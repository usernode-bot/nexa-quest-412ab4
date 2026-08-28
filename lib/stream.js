// The cursor stream — assembly, the event vocabulary, and the long-poll hold.
//
// Everything the room UI needs, filtered to what changed since `since`. A
// monotonic per-room `seq` is what makes polling cheap: the client only ever
// asks for the tail, and a reconnect after a dropped network is the same
// request with an older cursor.
//
// This file owns the shape of that answer. `server.js` keeps the route (auth,
// status codes, error handling) and hands in the helpers it already has, so
// the payload is testable without standing up Express.

const CONFIG = require('./config');

const { LATENCY } = CONFIG;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

// --- long poll ---------------------------------------------------------------
// Hold the request open until the room's seq moves past the caller's cursor.
// Deliberately a short polled SELECT rather than LISTEN/NOTIFY: it borrows no
// connection for the duration of the hold, survives a pool that hands out a
// different backend each tick, and needs nothing from the platform beyond
// plain HTTP. The whole win is removing the client's idle tick from the
// delivery leg, and 250 ms of server-side polling buys that.
async function waitForChange(pool, roomId, since, opts) {
  const options = opts || {};
  const holdMs = options.holdMs || LATENCY.STREAM_HOLD_MS;
  const tickMs = options.tickMs || LATENCY.STREAM_TICK_MS;
  const isShuttingDown = options.isShuttingDown || (() => false);
  const deadline = Date.now() + holdMs;

  while (Date.now() < deadline) {
    // Leaving is more urgent than waiting: a drain must not sit on held
    // requests for the whole grace window.
    if (isShuttingDown()) return false;
    await sleep(Math.min(tickMs, Math.max(0, deadline - Date.now())));
    if (isShuttingDown()) return false;
    let row;
    try {
      const r = await pool.query('SELECT seq, ended_at FROM rooms WHERE id = $1', [roomId]);
      row = r.rows[0];
    } catch {
      return false; // answer with whatever we have rather than failing the poll
    }
    if (!row) return true;                       // room vanished: let the caller say so
    if (row.ended_at) return true;               // ending is a change worth shipping
    if (Number(row.seq) > since) return true;
  }
  return false;
}

// --- event vocabulary ---------------------------------------------------------
// The raw rows stay in the payload exactly as they were, so a client running
// older code keeps rendering. `events` is a derived, ordered log of what
// changed in THIS delta — the same vocabulary a socket would push, carried
// over the transport we actually have. Backlog rows are not events: they are
// history, and replaying them as "created" would double-speak a room.
function buildEvents(ctx) {
  const events = [];
  const { room, since, participants, utterances, translations, holders, tier, participantCount } = ctx;

  events.push({
    type: 'room.state',
    seq: Number(room.seq),
    mode: room.mode,
    tier: tier.key,
    participantCount,
  });

  for (const p of participants) {
    events.push({
      type: 'participant.upsert',
      seq: Number(p.seq),
      userId: p.user_id,
      username: p.username,
      speaksLang: p.speaks_lang,
      hearsLang: p.hears_lang,
      present: !p.left_at && !p.removed,
    });
  }

  for (const u of utterances) {
    events.push({
      type: u.retracted ? 'utterance.retracted' : 'utterance.created',
      seq: Number(u.seq),
      utteranceId: Number(u.id),
      speakerUserId: u.speaker_user_id,
      sourceLang: u.source_lang,
      via: u.via,
    });
  }

  for (const t of translations) {
    const type = t.status === 'ok' ? 'translation.final'
      : t.status === 'partial' ? 'translation.partial'
        : t.status === 'unavailable' ? 'translation.unavailable'
          : t.status === 'error' ? 'translation.error'
            : t.status === 'retracted' ? 'utterance.retracted'
              : 'translation.pending';
    events.push({
      type,
      seq: Number(t.seq),
      utteranceId: Number(t.utterance_id),
      targetLang: t.target_lang,
      latencyMs: t.latency_ms,
      ttftMs: t.ttft_ms,
      // How stale this caption already was when the response was assembled.
      // Skew-free by construction: both ends of the subtraction are the
      // server's own clock, and the browser only ever adds its own elapsed
      // time on top. This is the number long-polling exists to shrink.
      ageMs: ageOf(t),
      sealedIdx: Number(t.sealed_idx || 0),
    });
    // Sealed clauses ride the same delta. Split out as its own event because
    // it means something different from a caption status: these words will
    // never be rewritten, so a listener's synthesiser may start on them while
    // the rest of the sentence is still being generated.
    const sealed = sealedOf(t);
    if (sealed.length) {
      events.push({
        type: 'translation.segment',
        seq: Number(t.seq),
        utteranceId: Number(t.utterance_id),
        targetLang: t.target_lang,
        segments: sealed,
        sealedIdx: sealed.length,
        final: t.status === 'ok',
        // Age of the audio leg, from the server's own clock only.
        audioAgeMs: audioAgeOf(t),
      });
    }
  }

  if (holders.length) {
    events.push({
      type: 'floor.changed',
      seq: Number(room.seq),
      userIds: holders.map((h) => h.userId),
    });
  }

  if (room.ended_at) events.push({ type: 'room.ended', seq: Number(room.seq) });

  return events
    .filter((e) => e.type === 'room.state' || e.type === 'room.ended' || e.seq > since)
    .sort((a, b) => a.seq - b.seq);
}

// Only the sealed prefix is ever published. An unsealed clause is still
// being written, and a listener who heard it could be contradicted by their
// own screen a second later.
function sealedOf(t) {
  if (!Array.isArray(t.segments)) return [];
  const idx = Math.max(0, Math.min(Number(t.sealed_idx || 0), t.segments.length));
  return t.segments.slice(0, idx).filter((x) => typeof x === 'string');
}

// How long ago the first clause became speakable. Same construction as
// ageOf: server clock on both sides of the subtraction.
function audioAgeOf(t) {
  if (!t.first_segment_at) return null;
  const age = Date.now() - new Date(t.first_segment_at).getTime();
  return age >= 0 && age < 600000 ? Math.round(age) : null;
}

function ageOf(t) {
  if (!t.finalized_at) return null;
  const age = Date.now() - new Date(t.finalized_at).getTime();
  return age >= 0 && age < 600000 ? Math.round(age) : null;
}

// --- assembly -----------------------------------------------------------------
// `deps` is what server.js already owns: pool plus the row-shaping helpers.
async function assemble(deps, args) {
  const { pool, langgroups, floor, cost, telephony } = deps;
  const { room, user, since } = args;

  const me = await deps.getParticipant(room.id, user.id);
  const isMember = !!me && !me.removed && !me.left_at;
  if (isMember) {
    await pool.query(
      'UPDATE room_participants SET last_seen_at = NOW() WHERE room_id = $1 AND user_id = $2',
      [room.id, user.id]
    );
  }
  // A non-member reading a room is a real product state (you followed a
  // share link and have not joined yet), not a staging-only branch — it is
  // read-only, and it behaves identically in production.
  const hears = me ? me.hears_lang : null;

  const tier = deps.tierFor(room);
  // A large room's roster is not something a poll can carry row by row, and
  // it is not what the room needs to show either: "three languages, 61 / 74
  // / 65 people" is the useful shape. Small rooms still send every row,
  // because there you want to see faces and hands.
  const aggregated = tier.rosterMode === 'aggregate';
  const rosterLimit = aggregated ? 0 : Math.min(tier.maxParticipants, 200);

  const [participants, utterances, translations] = await Promise.all([
    rosterLimit
      ? pool.query(
        `SELECT * FROM room_participants WHERE room_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
        [room.id, since, rosterLimit]
      )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT * FROM utterances WHERE room_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 200`,
      [room.id, since]
    ),
    pool.query(
      `SELECT * FROM utterance_translations WHERE room_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 400`,
      [room.id, since]
    ),
  ]);

  // On a cold cursor also send the recent backlog so a joiner (or a
  // reconnect that lost its place) sees the conversation, not a blank feed.
  let backlog = { utterances: [], translations: [] };
  if (since === 0) {
    const u = await pool.query(
      `SELECT * FROM (
         SELECT * FROM utterances WHERE room_id = $1 ORDER BY seq DESC LIMIT 40
       ) t ORDER BY seq ASC`,
      [room.id]
    );
    const ids = u.rows.map((r) => r.id);
    const t = ids.length
      ? await pool.query(
        'SELECT * FROM utterance_translations WHERE utterance_id = ANY($1::bigint[])',
        [ids]
      )
      : { rows: [] };
    backlog = { utterances: u.rows, translations: t.rows };
  }

  // Always sent, at every tier — one cheap GROUP BY, and it is what the
  // aggregate roster, the invariant check and the "who can hear me" line in
  // the composer are all built out of.
  const [groups, statuses, holders, queue, counts] = await Promise.all([
    langgroups.languageGroups(pool, room.id),
    langgroups.groupStatuses(pool, room.id),
    floor.activeSpeakers(pool, room.id),
    tier.handQueue ? floor.queueFor(pool, room.id, 20) : Promise.resolve([]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM room_participants
        WHERE room_id = $1 AND left_at IS NULL AND removed = FALSE`,
      [room.id]
    ),
  ]);

  const langGroups = groups.map((g) => ({
    lang: g.lang,
    size: g.size,
    speaking: g.speaking,
    hands: g.hands,
    // 'off' is the room's own choice, not a failure — say so differently.
    status: room.mode === 'transcript_only' ? 'off' : (statuses[g.lang] || 'idle'),
  }));

  const myQueuePosition = queue.findIndex((q) => q.userId === user.id) + 1 || null;

  const mergeById = (a, b) => {
    const seen = new Map();
    for (const row of [...a, ...b]) seen.set(String(row.id), row);
    return [...seen.values()];
  };

  const allUtterances = mergeById(backlog.utterances, utterances.rows)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const allTranslations = mergeById(backlog.translations, translations.rows);

  const byUtterance = new Map();
  for (const t of allTranslations) {
    const key = String(t.utterance_id);
    if (!byUtterance.has(key)) byUtterance.set(key, []);
    byUtterance.get(key).push(t);
  }

  const roomOut = deps.publicRoom(room);
  roomOut.activeSpeakerUserIds = holders.map((h) => h.userId);

  const participantCount = counts.rows[0].n;

  return {
    room: roomOut,
    me: me ? deps.publicParticipant(me) : null,
    isMember,
    hearsLang: hears,
    seq: Number(room.seq),
    tier: deps.publicTier(tier),
    rosterMode: tier.rosterMode,
    participantCount,
    langGroups,
    activeSpeakers: holders,
    queue,
    myQueuePosition,
    // The host sees a percentage and a rung, never a dollar figure — the
    // meter belongs to the speaker's own platform budget, not to this app.
    budget: room.host_user_id === user.id ? cost.budgetFor(room.id) : null,
    dialIn: telephony.status(),
    participants: participants.rows.map(deps.publicParticipant),
    events: buildEvents({
      room,
      since,
      participants: participants.rows,
      utterances: utterances.rows,
      translations: translations.rows,
      holders,
      tier,
      participantCount,
    }),
    utterances: allUtterances.map((u) => ({
      id: Number(u.id),
      speakerUserId: u.speaker_user_id,
      speakerUsername: u.speaker_username,
      sourceLang: u.source_lang,
      sourceText: u.retracted ? null : u.source_text,
      retracted: u.retracted,
      via: u.via,
      seq: Number(u.seq),
      createdAt: u.created_at,
      translations: (byUtterance.get(String(u.id)) || []).map((t) => ({
        targetLang: t.target_lang,
        text: u.retracted ? null : t.text,
        status: t.status,
        latencyMs: t.latency_ms,
        ttftMs: t.ttft_ms,
        groupSize: t.group_size,
        ageMs: ageOf(t),
        segments: u.retracted ? [] : sealedOf(t),
        sealedIdx: u.retracted ? 0 : sealedOf(t).length,
        audioAgeMs: audioAgeOf(t),
      })),
    })),
  };
}

module.exports = { assemble, waitForChange, buildEvents };
