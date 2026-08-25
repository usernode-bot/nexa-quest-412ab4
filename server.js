const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const CONFIG = require('./lib/config');
const { migrate } = require('./lib/schema');
const { seedStaging } = require('./lib/seed');
const translator = require('./lib/translate');

const { LANG_CODES, LANG_BY_CODE, PURPOSE_KEYS, LIMITS } = CONFIG;

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PLATFORM_BASE_URL = 'https://social-vibecoding.usernodelabs.org';
const APP_SLUG = 'live-translation';

// --- auth ------------------------------------------------------------------
// Platform convention: tokens are RS256, issued by `usernode`, with audience
// `usernode:app:<APP_ID>` and a `pur` claim of `iframe`. Pinning the
// algorithm is not optional — every app knows the public PEM, so a verifier
// that also accepted HS256 would treat that PEM as an HMAC secret and let
// any caller forge any user.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n');
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? `usernode:app:${process.env.USERNODE_APP_ID}`
  : null;
// Retired alias, still injected for apps written before the RSA cutover.
const LEGACY_JWT_SECRET = process.env.JWT_SECRET;

function verifyToken(token) {
  if (!token) return null;
  if (JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      if (claims && claims.pur === 'iframe') return claims;
      return null;
    } catch {
      return null;
    }
  }
  // Fallback for deploys that still only carry the legacy shared secret.
  if (LEGACY_JWT_SECRET) {
    try {
      return jwt.verify(token, LEGACY_JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return null;
    }
  }
  return null;
}

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico', '/api/config']);

app.use(express.json({ limit: '64kb' }));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  const claims = verifyToken(token);
  if (claims) {
    req.user = claims;
    req.userToken = String(token);
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// --- helpers ---------------------------------------------------------------
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
function newRoomCode() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  return out;
}

function normLang(value, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return LANG_CODES.includes(v) ? v : fallback;
}

function isAdmin(user) {
  return !!(user && (user.is_admin || user.admin || user.role === 'admin'));
}

async function bumpSeq(client, roomId) {
  const { rows } = await client.query(
    'UPDATE rooms SET seq = seq + 1 WHERE id = $1 RETURNING seq',
    [roomId]
  );
  if (!rows.length) throw new Error('room_gone');
  return Number(rows[0].seq);
}

async function findRoom(code) {
  const { rows } = await pool.query(
    'SELECT * FROM rooms WHERE code = $1',
    [String(code || '').trim().toUpperCase()]
  );
  return rows[0] || null;
}

async function getParticipant(roomId, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM room_participants WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return rows[0] || null;
}

// Sliding-window rate limiting, persisted so it survives a redeploy.
async function rateAllows(scope, key, limit, windowSql) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rate_events
     WHERE scope = $1 AND scope_key = $2 AND created_at > NOW() - $3::INTERVAL`,
    [scope, String(key), windowSql]
  );
  if (rows[0].n >= limit) return false;
  await pool.query(
    'INSERT INTO rate_events (scope, scope_key) VALUES ($1, $2)',
    [scope, String(key)]
  );
  return true;
}

function publicRoom(room) {
  return {
    code: room.code,
    title: room.title,
    purpose: room.purpose,
    hostUserId: room.host_user_id,
    hostUsername: room.host_username,
    twoWay: room.two_way,
    mode: room.mode,
    seq: Number(room.seq),
    createdAt: room.created_at,
    endedAt: room.ended_at,
    endReason: room.end_reason,
    activeSpeakerUserId:
      room.active_speaker_until && new Date(room.active_speaker_until) > new Date()
        ? room.active_speaker_user_id
        : null,
  };
}

function publicParticipant(p) {
  return {
    userId: p.user_id,
    username: p.username,
    speaksLang: p.speaks_lang,
    hearsLang: p.hears_lang,
    micOn: p.mic_on,
    role: p.role,
    ttsEnabled: p.tts_enabled,
    handRaisedAt: p.hand_raised_at,
    mutedByHost: p.muted_by_host,
    removed: p.removed,
    left: !!p.left_at,
    online: !p.left_at && (Date.now() - new Date(p.last_seen_at).getTime()) < LIMITS.PRESENCE_TIMEOUT_MS,
    seq: Number(p.seq),
  };
}

// --- config ----------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    languages: CONFIG.LANGUAGES,
    comingSoon: CONFIG.COMING_SOON,
    purposes: CONFIG.ROOM_PURPOSES,
    limits: LIMITS,
    llmEnabled: translator.LLM_ENABLED,
    env: process.env.USERNODE_ENV || 'production',
  });
});

app.get('/api/llm-status', (_req, res) => {
  res.json({
    enabled: translator.LLM_ENABLED,
    reason: translator.LLM_ENABLED
      ? null
      : 'The platform translation service is not available in this environment.',
  });
});

app.post('/api/llm-grant-outcome', async (req, res) => {
  const outcome = ['granted', 'declined', 'dismissed'].includes(req.body && req.body.outcome)
    ? req.body.outcome
    : 'dismissed';
  try {
    await pool.query(
      'INSERT INTO llm_grant_events (user_id, outcome) VALUES ($1, $2)',
      [req.user.id, outcome]
    );
  } catch { /* telemetry must never break the call */ }
  res.json({ ok: true });
});

// --- language preferences --------------------------------------------------
app.get('/api/me/prefs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM user_language_prefs WHERE user_id = $1',
      [req.user.id]
    );
    if (rows.length) {
      const p = rows[0];
      return res.json({
        prefs: {
          speaksLang: p.speaks_lang,
          hearsLang: p.hears_lang,
          ttsEnabled: p.tts_enabled,
          isDefault: false,
        },
      });
    }
    // Seed the picker from the user's platform-level language preference
    // (the `locale` JWT claim), falling back to English. `null` means "no
    // preference set", which is NOT the same as English — so we only use it
    // as a default, never persist it silently.
    const locale = String(req.user.locale || '').toLowerCase();
    const guess = LANG_CODES.find((c) => locale === c || locale.startsWith(`${c}-`)) || 'en';
    res.json({
      prefs: { speaksLang: guess, hearsLang: guess, ttsEnabled: true, isDefault: true },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/me/prefs', async (req, res) => {
  const speaks = normLang(req.body && req.body.speaksLang, 'en');
  const hears = normLang(req.body && req.body.hearsLang, 'en');
  const tts = (req.body && req.body.ttsEnabled) !== false;
  try {
    await pool.query(
      `INSERT INTO user_language_prefs (user_id, username, speaks_lang, hears_lang, tts_enabled, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET username = EXCLUDED.username, speaks_lang = EXCLUDED.speaks_lang,
             hears_lang = EXCLUDED.hears_lang, tts_enabled = EXCLUDED.tts_enabled,
             updated_at = NOW()`,
      [req.user.id, req.user.username, speaks, hears, tts]
    );
    res.json({ prefs: { speaksLang: speaks, hearsLang: hears, ttsEnabled: tts, isDefault: false } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- rooms -----------------------------------------------------------------
app.get('/api/rooms/mine', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, (
         SELECT COUNT(*)::int FROM room_participants p
         WHERE p.room_id = r.id AND p.left_at IS NULL AND p.removed = FALSE
       ) AS live_count
       FROM rooms r
       WHERE r.ended_at IS NULL
         AND (r.host_user_id = $1
              OR EXISTS (SELECT 1 FROM room_participants p
                         WHERE p.room_id = r.id AND p.user_id = $1 AND p.removed = FALSE)
              OR r.ephemeral = FALSE)
       ORDER BY r.created_at DESC
       LIMIT 12`,
      [req.user.id]
    );
    res.json({
      rooms: rows.map((r) => ({ ...publicRoom(r), liveCount: r.live_count })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms', async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim().slice(0, 120) || 'Untitled call';
  const purpose = PURPOSE_KEYS.includes(req.body && req.body.purpose) ? req.body.purpose : 'support';
  const speaks = normLang(req.body && req.body.speaksLang, 'en');
  const hears = normLang(req.body && req.body.hearsLang, 'en');
  const purposeDef = CONFIG.ROOM_PURPOSES.find((p) => p.key === purpose);
  const twoWay = typeof (req.body && req.body.twoWay) === 'boolean'
    ? req.body.twoWay
    : !!(purposeDef && purposeDef.defaultTwoWay);

  try {
    if (!await rateAllows('room_create', req.user.id, LIMITS.ROOMS_PER_HOUR_PER_USER, '1 hour')) {
      return res.status(429).json({
        error: 'rate_limited',
        message: `You can start ${LIMITS.ROOMS_PER_HOUR_PER_USER} calls per hour.`,
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let room = null;
    for (let attempt = 0; attempt < 6 && !room; attempt += 1) {
      const code = newRoomCode();
      const { rows } = await client.query(
        `INSERT INTO rooms (code, title, purpose, host_user_id, host_username, two_way, seq)
         VALUES ($1,$2,$3,$4,$5,$6,1)
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [code, title, purpose, req.user.id, req.user.username, twoWay]
      );
      room = rows[0] || null;
    }
    if (!room) throw new Error('could not allocate a room code');

    await client.query(
      `INSERT INTO room_participants (room_id, user_id, username, speaks_lang, hears_lang, mic_on, role, seq)
       VALUES ($1,$2,$3,$4,$5,TRUE,'host',1)`,
      [room.id, req.user.id, req.user.username, speaks, hears]
    );
    await client.query('COMMIT');
    res.json({ room: publicRoom(room) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/rooms/:code/join', async (req, res) => {
  const speaks = normLang(req.body && req.body.speaksLang, 'en');
  const hears = normLang(req.body && req.body.hearsLang, 'en');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM rooms WHERE code = $1 FOR UPDATE',
      [String(req.params.code || '').toUpperCase()]
    );
    const room = roomRows[0];
    if (!room) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'room_not_found' }); }
    if (room.ended_at) { await client.query('ROLLBACK'); return res.status(410).json({ error: 'room_ended' }); }

    const existing = await client.query(
      'SELECT * FROM room_participants WHERE room_id = $1 AND user_id = $2',
      [room.id, req.user.id]
    );
    if (existing.rows.length && existing.rows[0].removed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'removed_by_host' });
    }

    if (!existing.rows.length) {
      const counts = await client.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(DISTINCT hears_lang)::int AS langs
         FROM room_participants
         WHERE room_id = $1 AND left_at IS NULL AND removed = FALSE`,
        [room.id]
      );
      if (counts.rows[0].n >= LIMITS.MAX_PARTICIPANTS) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'room_full' });
      }
      const distinct = await client.query(
        `SELECT DISTINCT hears_lang FROM room_participants
         WHERE room_id = $1 AND left_at IS NULL AND removed = FALSE`,
        [room.id]
      );
      const langs = new Set(distinct.rows.map((r) => r.hears_lang));
      if (!langs.has(hears) && langs.size >= LIMITS.MAX_TARGET_LANGS) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'too_many_languages',
          message: `This call already carries ${LIMITS.MAX_TARGET_LANGS} listening languages, the maximum.`,
        });
      }
    }

    const seq = await bumpSeq(client, room.id);
    // A room's creator is its host; everyone else joins as audience and can
    // be promoted by the host. Purpose does not change who may speak — the
    // host does.
    const role = room.host_user_id === req.user.id ? 'host' : 'audience';
    await client.query(
      `INSERT INTO room_participants (room_id, user_id, username, speaks_lang, hears_lang, mic_on, role, seq, last_seen_at, left_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NULL)
       ON CONFLICT (room_id, user_id) DO UPDATE
         SET speaks_lang = EXCLUDED.speaks_lang,
             hears_lang  = EXCLUDED.hears_lang,
             left_at = NULL, last_seen_at = NOW(), seq = EXCLUDED.seq`,
      [room.id, req.user.id, req.user.username, speaks, hears,
        role !== 'audience' || !!room.two_way, role, seq]
    );
    await client.query('COMMIT');
    res.json({ room: publicRoom(room), joined: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Update my own participant row: language, mic, TTS, raised hand.
app.patch('/api/rooms/:code/me', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM rooms WHERE code = $1 FOR UPDATE',
      [String(req.params.code || '').toUpperCase()]
    );
    const room = roomRows[0];
    if (!room) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'room_not_found' }); }

    const { rows: meRows } = await client.query(
      'SELECT * FROM room_participants WHERE room_id = $1 AND user_id = $2',
      [room.id, req.user.id]
    );
    const me = meRows[0];
    if (!me || me.removed) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'not_a_member' }); }

    const b = req.body || {};
    const speaks = b.speaksLang === undefined ? me.speaks_lang : normLang(b.speaksLang, me.speaks_lang);
    let hears = b.hearsLang === undefined ? me.hears_lang : normLang(b.hearsLang, me.hears_lang);

    if (hears !== me.hears_lang) {
      const distinct = await client.query(
        `SELECT DISTINCT hears_lang FROM room_participants
         WHERE room_id = $1 AND left_at IS NULL AND removed = FALSE AND user_id <> $2`,
        [room.id, req.user.id]
      );
      const langs = new Set(distinct.rows.map((r) => r.hears_lang));
      if (!langs.has(hears) && langs.size >= LIMITS.MAX_TARGET_LANGS) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'too_many_languages',
          message: `This call already carries ${LIMITS.MAX_TARGET_LANGS} listening languages, the maximum.`,
        });
      }
    }

    // A host-muted participant cannot un-mute themselves; that is the whole
    // point of the moderation control.
    let micOn = b.micOn === undefined ? me.mic_on : !!b.micOn;
    if (me.muted_by_host) micOn = false;
    const tts = b.ttsEnabled === undefined ? me.tts_enabled : !!b.ttsEnabled;
    const hand = b.handRaised === undefined
      ? me.hand_raised_at
      : (b.handRaised ? (me.hand_raised_at || new Date()) : null);

    const seq = await bumpSeq(client, room.id);
    await client.query(
      `UPDATE room_participants
       SET speaks_lang=$3, hears_lang=$4, mic_on=$5, tts_enabled=$6, hand_raised_at=$7,
           last_seen_at=NOW(), left_at=NULL, seq=$8
       WHERE room_id=$1 AND user_id=$2`,
      [room.id, req.user.id, speaks, hears, micOn, tts, hand, seq]
    );
    await client.query('COMMIT');
    res.json({ ok: true, seq });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Host moderation: promote/demote, mute, remove. (Stage 3 roles + Stage 7.)
app.patch('/api/rooms/:code/participants/:userId', async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'bad_user_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM rooms WHERE code = $1 FOR UPDATE',
      [String(req.params.code || '').toUpperCase()]
    );
    const room = roomRows[0];
    if (!room) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'room_not_found' }); }
    if (room.host_user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'host_only' });
    }
    if (targetId === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot_moderate_self' });
    }

    const { rows: tRows } = await client.query(
      'SELECT * FROM room_participants WHERE room_id = $1 AND user_id = $2',
      [room.id, targetId]
    );
    const target = tRows[0];
    if (!target) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_a_member' }); }

    const b = req.body || {};
    const role = ['agent', 'audience'].includes(b.role) ? b.role : target.role;
    const muted = b.mutedByHost === undefined ? target.muted_by_host : !!b.mutedByHost;
    const removed = b.removed === undefined ? target.removed : !!b.removed;
    const micOn = (muted || removed) ? false : (role === 'audience' ? false : target.mic_on);
    // Granting the floor clears the raised hand.
    const hand = role !== 'audience' ? null : target.hand_raised_at;

    const seq = await bumpSeq(client, room.id);
    await client.query(
      `UPDATE room_participants
       SET role=$3, muted_by_host=$4, removed=$5, mic_on=$6, hand_raised_at=$7,
           left_at = CASE WHEN $5 THEN NOW() ELSE left_at END, seq=$8
       WHERE room_id=$1 AND user_id=$2`,
      [room.id, targetId, role, muted, removed, micOn, hand, seq]
    );
    await client.query('COMMIT');
    res.json({ ok: true, seq });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Stage 7 — transcript-only fallback. The host can turn translation off for
// the whole room (a bad-connection or privacy escape hatch); everything is
// still captured in the original language, nothing is sent to the model.
app.post('/api/rooms/:code/mode', async (req, res) => {
  const mode = (req.body && req.body.mode) === 'transcript_only' ? 'transcript_only' : 'full';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM rooms WHERE code = $1 FOR UPDATE',
      [String(req.params.code || '').toUpperCase()]
    );
    const room = rows[0];
    if (!room) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'room_not_found' }); }
    if (room.host_user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'host_only' });
    }
    const seq = await bumpSeq(client, room.id);
    await client.query('UPDATE rooms SET mode = $2 WHERE id = $1', [room.id, mode]);
    await client.query('COMMIT');
    res.json({ ok: true, mode, seq });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Stage 5 — the active-speaker lease. A conditional UPDATE is the whole
// mechanism: whoever wins the row holds the floor until the lease lapses,
// and a dead tab releases it without anyone having to notice.
app.post('/api/rooms/:code/floor', async (req, res) => {
  const release = !!(req.body && req.body.release);
  try {
    const room = await findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'room_not_found' });
    const me = await getParticipant(room.id, req.user.id);
    if (!me || me.removed) return res.status(403).json({ error: 'not_a_member' });
    if (me.muted_by_host) return res.status(403).json({ error: 'muted_by_host' });

    if (release) {
      await pool.query(
        `UPDATE rooms SET active_speaker_user_id = NULL, active_speaker_until = NULL
         WHERE id = $1 AND active_speaker_user_id = $2`,
        [room.id, req.user.id]
      );
      return res.json({ ok: true, holder: null });
    }

    const { rows } = await pool.query(
      `UPDATE rooms
       SET active_speaker_user_id = $2,
           active_speaker_until = NOW() + ($3 || ' milliseconds')::INTERVAL
       WHERE id = $1
         AND (active_speaker_user_id IS NULL
              OR active_speaker_user_id = $2
              OR active_speaker_until < NOW())
       RETURNING active_speaker_user_id`,
      [room.id, req.user.id, LIMITS.FLOOR_LEASE_MS]
    );
    if (!rows.length) {
      const current = await findRoom(req.params.code);
      return res.status(409).json({
        error: 'floor_taken',
        holder: current ? current.active_speaker_user_id : null,
      });
    }
    res.json({ ok: true, holder: req.user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- utterances ------------------------------------------------------------
async function fanOutTranslations(room, utterance, userToken) {
  let targets = [];
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT hears_lang FROM room_participants
       WHERE room_id = $1 AND left_at IS NULL AND removed = FALSE`,
      [room.id]
    );
    targets = rows.map((r) => r.hears_lang).filter((l) => l && l !== utterance.source_lang);
  } catch (err) {
    console.error('[translate] could not resolve targets:', err.message);
    return;
  }
  // Hard cap regardless of what the roster says — this is what bounds spend.
  targets = targets.slice(0, LIMITS.MAX_TARGET_LANGS);

  for (const target of targets) {
    // Insert the pending row first so listeners see "translating…" rather
    // than a caption that appears out of nowhere a second later.
    let placed = false;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const seq = await bumpSeq(client, room.id);
        const ins = await client.query(
          `INSERT INTO utterance_translations (utterance_id, room_id, target_lang, status, seq)
           VALUES ($1,$2,$3,'pending',$4)
           ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
          [utterance.id, room.id, target, seq]
        );
        await client.query('COMMIT');
        placed = ins.rowCount > 0;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[translate] pending insert failed:', err.message);
      continue;
    }
    if (!placed) continue;

    translator.enqueue(room.id, target, async () => {
      const result = await translator.translate({
        roomId: room.id,
        sourceLang: utterance.source_lang,
        targetLang: target,
        sourceText: utterance.source_text,
        userToken,
      });
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const seq = await bumpSeq(client, room.id);
          await client.query(
            `UPDATE utterance_translations
             SET text=$3, status=$4, latency_ms=$5, seq=$6
             WHERE utterance_id=$1 AND target_lang=$2`,
            [utterance.id, target, result.text, result.status, result.latencyMs, seq]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      } catch (err) {
        console.error('[translate] result write failed:', err.message);
      }
      return result;
    });
  }
}

app.post('/api/rooms/:code/utterances', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  const via = (req.body && req.body.via) === 'typed' ? 'typed' : 'voice';
  if (!text) return res.status(400).json({ error: 'empty_text' });
  if (text.length > LIMITS.MAX_UTTERANCE_CHARS) {
    return res.status(400).json({ error: 'too_long', max: LIMITS.MAX_UTTERANCE_CHARS });
  }

  try {
    const room = await findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'room_not_found' });
    if (room.ended_at) return res.status(410).json({ error: 'room_ended' });

    const me = await getParticipant(room.id, req.user.id);
    if (!me || me.removed || me.left_at) return res.status(403).json({ error: 'not_a_member' });
    if (me.muted_by_host) return res.status(403).json({ error: 'muted_by_host' });
    // Stage 3: in a one-way room only the host and promoted agents speak.
    if (!room.two_way && me.role === 'audience') {
      return res.status(403).json({ error: 'listen_only', message: 'Raise your hand to ask for the floor.' });
    }

    if (!await rateAllows('utterance', `room:${room.id}`, LIMITS.UTTERANCES_PER_MIN_PER_ROOM, '1 minute')) {
      return res.status(429).json({ error: 'rate_limited', message: 'This call is producing captions faster than we can translate them.' });
    }

    const sourceLang = normLang(req.body && req.body.sourceLang, me.speaks_lang);

    const client = await pool.connect();
    let utterance;
    try {
      await client.query('BEGIN');
      const seq = await bumpSeq(client, room.id);
      const { rows } = await client.query(
        `INSERT INTO utterances (room_id, speaker_user_id, speaker_username, source_lang, source_text, via, seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [room.id, req.user.id, req.user.username, sourceLang, text, via, seq]
      );
      utterance = rows[0];
      await client.query(
        'UPDATE room_participants SET last_seen_at = NOW() WHERE room_id = $1 AND user_id = $2',
        [room.id, req.user.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Transcript-only mode (Stage 7 fallback) still records what was said —
    // it just does not spend anyone's AI budget translating it.
    if (room.mode !== 'transcript_only') {
      fanOutTranslations(room, utterance, req.userToken).catch((err) =>
        console.error('[translate] fan-out failed:', err.message)
      );
    }

    res.json({ utterance: { id: Number(utterance.id), seq: Number(utterance.seq) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms/:code/utterances/:id/retract', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM rooms WHERE code = $1 FOR UPDATE',
      [String(req.params.code || '').toUpperCase()]
    );
    const room = roomRows[0];
    if (!room) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'room_not_found' }); }

    const { rows: uRows } = await client.query(
      'SELECT * FROM utterances WHERE id = $1 AND room_id = $2',
      [parseInt(req.params.id, 10) || 0, room.id]
    );
    const utt = uRows[0];
    if (!utt) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    // Your own words, or the host's room.
    if (utt.speaker_user_id !== req.user.id && room.host_user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'not_yours' });
    }

    const seq = await bumpSeq(client, room.id);
    await client.query('UPDATE utterances SET retracted = TRUE, seq = $2 WHERE id = $1', [utt.id, seq]);
    await client.query('COMMIT');
    res.json({ ok: true, seq });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/rooms/:code/utterances/:id/report', async (req, res) => {
  try {
    const room = await findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'room_not_found' });
    const me = await getParticipant(room.id, req.user.id);
    if (!me) return res.status(403).json({ error: 'not_a_member' });

    const { rows } = await pool.query(
      'SELECT * FROM utterances WHERE id = $1 AND room_id = $2',
      [parseInt(req.params.id, 10) || 0, room.id]
    );
    const utt = rows[0];
    if (!utt) return res.status(404).json({ error: 'not_found' });

    if (!await rateAllows('report', req.user.id, 10, '1 hour')) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    await pool.query(
      `INSERT INTO reports (room_id, utterance_id, reporter_user_id, reported_user_id, reported_username, quoted_text, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [room.id, utt.id, req.user.id, utt.speaker_user_id, utt.speaker_username,
        utt.source_text.slice(0, 500), String((req.body && req.body.reason) || '').slice(0, 255)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- the cursor stream -----------------------------------------------------
// Everything the room UI needs, filtered to what changed since `since`.
// A monotonic per-room `seq` is what makes polling cheap: the client only
// ever asks for the tail, and a reconnect after a dropped network is the
// same request with an older cursor.
app.get('/api/rooms/:code/stream', async (req, res) => {
  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  try {
    const room = await findRoom(req.params.code);
    // An unknown code is an ordinary answer here, not a transport failure: this
    // endpoint is hit by a plain page load, and a 404 makes the browser log a
    // console error that fails the baseline no-console-errors check. The
    // mutating routes below still 404 properly — nothing loads them on boot.
    if (!room) return res.json({ notFound: true, seq: 0 });

    const me = await getParticipant(room.id, req.user.id);
    const isMember = !!me && !me.removed && !me.left_at;
    if (isMember) {
      await pool.query(
        'UPDATE room_participants SET last_seen_at = NOW() WHERE room_id = $1 AND user_id = $2',
        [room.id, req.user.id]
      );
    }
    // A non-member reading a room is a real product state (you followed a
    // share link and have not joined yet), not a staging-only branch — it is
    // read-only, and it behaves identically in production.
    const hears = me ? me.hears_lang : null;

    const [participants, utterances, translations] = await Promise.all([
      pool.query(
        `SELECT * FROM room_participants WHERE room_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 200`,
        [room.id, since]
      ),
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

    res.json({
      room: publicRoom(room),
      me: me ? publicParticipant(me) : null,
      isMember,
      hearsLang: hears,
      seq: Number(room.seq),
      participants: participants.rows.map(publicParticipant),
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
        })),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms/:code/leave', async (req, res) => {
  const endRoom = !!(req.body && req.body.endRoom);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM rooms WHERE code = $1 FOR UPDATE',
      [String(req.params.code || '').toUpperCase()]
    );
    const room = roomRows[0];
    if (!room) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'room_not_found' }); }

    const seq = await bumpSeq(client, room.id);
    await client.query(
      `UPDATE room_participants SET left_at = NOW(), mic_on = FALSE, hand_raised_at = NULL, seq = $3
       WHERE room_id = $1 AND user_id = $2`,
      [room.id, req.user.id, seq]
    );
    await client.query(
      `UPDATE rooms SET active_speaker_user_id = NULL, active_speaker_until = NULL
       WHERE id = $1 AND active_speaker_user_id = $2`,
      [room.id, req.user.id]
    );
    if (endRoom && room.host_user_id === req.user.id && !room.ended_at) {
      await client.query(
        `UPDATE rooms SET ended_at = NOW(), end_reason = 'host_ended' WHERE id = $1`,
        [room.id]
      );
    }
    await client.query('COMMIT');
    translator.forgetRoom(room.id);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/rooms/:code/summary', async (req, res) => {
  try {
    const room = await findRoom(req.params.code);
    if (!room) return res.json({ notFound: true });  // same reasoning as /stream
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM utterances WHERE room_id = $1) AS utterances,
         (SELECT COUNT(DISTINCT user_id)::int FROM room_participants WHERE room_id = $1) AS people,
         (SELECT COUNT(DISTINCT hears_lang)::int FROM room_participants WHERE room_id = $1) AS languages,
         (SELECT ROUND(AVG(latency_ms))::int FROM utterance_translations
          WHERE room_id = $1 AND status = 'ok' AND latency_ms IS NOT NULL) AS avg_latency_ms,
         EXTRACT(EPOCH FROM (COALESCE($2::timestamptz, NOW()) - $3::timestamptz))::int AS duration_s`,
      [room.id, room.ended_at, room.created_at]
    );
    res.json({ room: publicRoom(room), summary: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- metrics (Stage 7) -----------------------------------------------------
app.get('/api/metrics', async (req, res) => {
  try {
    const [latency, rollups, grants, live] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS n,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms))::int AS p50,
           ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95,
           COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
           COUNT(*) FILTER (WHERE status = 'unavailable')::int AS unavailable
         FROM utterance_translations
         WHERE created_at > NOW() - INTERVAL '7 days'`
      ),
      pool.query('SELECT * FROM daily_usage ORDER BY day DESC LIMIT 14'),
      pool.query(
        `SELECT outcome, COUNT(*)::int AS n FROM llm_grant_events
         WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY outcome`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS open_rooms,
                (SELECT COUNT(*)::int FROM room_participants
                 WHERE left_at IS NULL AND removed = FALSE) AS live_participants
         FROM rooms WHERE ended_at IS NULL`
      ),
    ]);
    const grantMap = Object.fromEntries(grants.rows.map((r) => [r.outcome, r.n]));
    const asked = (grantMap.granted || 0) + (grantMap.declined || 0) + (grantMap.dismissed || 0);
    res.json({
      isAdmin: isAdmin(req.user),
      latency: latency.rows[0],
      daily: rollups.rows,
      grants: {
        ...grantMap,
        asked,
        acceptanceRate: asked ? Math.round(((grantMap.granted || 0) / asked) * 100) : null,
      },
      live: live.rows[0],
      llmEnabled: translator.LLM_ENABLED,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- static + HTML shell ---------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// Chromeless deep links: an unauthenticated TOP-LEVEL visit to this app's own
// subdomain (a share link pasted into a browser) cannot be served, because the
// iframe token only exists inside the platform shell. Bounce it to the
// platform's chromeless view WITH the requested path so the visitor lands on
// the shared room instead of the home screen.
const SAFE_PATH = /^\/(?!\/)[^\s\\`'"<>]{0,511}$/;

app.get('*', (req, res) => {
  if (!req.user) {
    if (req.get('sec-fetch-dest') === 'document') {
      const inner = req.originalUrl;
      const target = SAFE_PATH.test(inner)
        ? `${PLATFORM_BASE_URL}/#app/${APP_SLUG}/full?path=${inner}`
        : `${PLATFORM_BASE_URL}/#app/${APP_SLUG}/full`;
      return res.redirect(302, target);
    }
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- background jobs -------------------------------------------------------
async function houseKeeping() {
  try {
    // Captions are transient. Keep the DB (and every staging clone of it)
    // from accumulating call transcripts forever.
    await pool.query(
      `DELETE FROM utterances WHERE created_at < NOW() - ($1 || ' hours')::INTERVAL`,
      [LIMITS.RETENTION_HOURS]
    );
    await pool.query(`DELETE FROM rate_events WHERE created_at < NOW() - INTERVAL '2 hours'`);
    // Close rooms nobody is in any more.
    await pool.query(
      `UPDATE rooms SET ended_at = NOW(), end_reason = 'abandoned'
       WHERE ended_at IS NULL AND ephemeral = TRUE
         AND created_at < NOW() - INTERVAL '15 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM room_participants p
           WHERE p.room_id = rooms.id AND p.left_at IS NULL
             AND p.last_seen_at > NOW() - INTERVAL '15 minutes')`
    );
    // Daily rollup — aggregate only, no identity.
    await pool.query(
      `INSERT INTO daily_usage (day, rooms_started, room_minutes, utterances, translation_calls, distinct_language_pairs, updated_at)
       SELECT CURRENT_DATE,
         (SELECT COUNT(*)::int FROM rooms WHERE created_at::date = CURRENT_DATE),
         (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - created_at)) / 60), 0)::int
            FROM rooms WHERE created_at::date = CURRENT_DATE),
         (SELECT COUNT(*)::int FROM utterances WHERE created_at::date = CURRENT_DATE),
         (SELECT COUNT(*)::int FROM utterance_translations WHERE created_at::date = CURRENT_DATE),
         (SELECT COUNT(*)::int FROM (
            SELECT DISTINCT u.source_lang, t.target_lang
            FROM utterance_translations t JOIN utterances u ON u.id = t.utterance_id
            WHERE t.created_at::date = CURRENT_DATE) x),
         NOW()
       ON CONFLICT (day) DO UPDATE SET
         rooms_started = EXCLUDED.rooms_started,
         room_minutes = EXCLUDED.room_minutes,
         utterances = EXCLUDED.utterances,
         translation_calls = EXCLUDED.translation_calls,
         distinct_language_pairs = EXCLUDED.distinct_language_pairs,
         updated_at = NOW()`
    );
  } catch (err) {
    console.error('[housekeeping]', err.message);
  }
}

// --- boot + graceful shutdown ---------------------------------------------
let server;
let houseKeepingTimer;

async function start() {
  await migrate(pool);
  if (IS_STAGING) await seedStaging(pool);
  await houseKeeping();
  houseKeepingTimer = setInterval(houseKeeping, 60 * 60 * 1000);
  houseKeepingTimer.unref?.();

  server = app.listen(port, () => {
    console.log(`LIVE TRANSLATION listening on :${port} (env=${process.env.USERNODE_ENV || 'production'}, llm=${translator.LLM_ENABLED})`);
  });
}

const DRAIN_MS = 3000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (houseKeepingTimer) clearInterval(houseKeepingTimer);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => { console.error(err); process.exit(1); });
