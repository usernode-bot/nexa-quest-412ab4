const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const CONFIG = require('./lib/config');
const { migrate } = require('./lib/schema');
const { seedStaging } = require('./lib/seed');
const translator = require('./lib/engine');
const floor = require('./lib/floor');
const cost = require('./lib/cost');
const langgroups = require('./lib/langgroups');
const telephony = require('./lib/bridge/telephony');
const stream = require('./lib/stream');
const latencyLog = require('./lib/latency');
const segment = require('./lib/segment');

const {
  LANG_CODES, LANG_BY_CODE, PURPOSE_KEYS, LIMITS,
  TIER_BY_KEY, TIER_KEYS, PURPOSE_TIER,
} = CONFIG;

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

// A room's tier decides its participant cap, how many people may hold the
// floor at once, and whether the roster is sent row-by-row or aggregated.
// Unknown values fall back to the smallest tier rather than throwing — a room
// row written by an older deploy is still a room.
function tierFor(room) {
  return TIER_BY_KEY[room && room.scale_tier] || TIER_BY_KEY.direct;
}

function publicTier(tier) {
  return {
    key: tier.key,
    label: tier.label,
    blurb: tier.blurb,
    maxParticipants: tier.maxParticipants,
    maxTargetLangs: tier.maxTargetLangs,
    speakerSlots: tier.speakerSlots,
    rosterMode: tier.rosterMode,
    handQueue: tier.handQueue,
    pollActiveMs: tier.pollActiveMs,
    // The client must not decide for itself whether to hold a request open:
    // one source of truth, so a tier upgrade changes the transport for both
    // ends at the same moment.
    longPoll: !!tier.longPoll,
  };
}

function publicRoom(room) {
  const tier = tierFor(room);
  return {
    code: room.code,
    title: room.title,
    purpose: room.purpose,
    scaleTier: tier.key,
    tier: publicTier(tier),
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
    // Multi-slot floors live in `active_speakers`; /stream fills this in. The
    // scalar above is kept so a client mid-deploy still renders.
    activeSpeakerUserIds: [],
  };
}

// A listening mode the app knows, or the default. `tts_enabled` is derived
// from it and never set independently, so the boolean and the mode cannot
// drift apart on the same row.
function normAudioMode(v, fallback) {
  const fb = CONFIG.AUDIO.MODES.includes(fallback) ? fallback : CONFIG.AUDIO.DEFAULT_MODE;
  return CONFIG.AUDIO.MODES.includes(v) ? v : fb;
}

function ttsFromMode(mode) {
  return normAudioMode(mode, CONFIG.AUDIO.DEFAULT_MODE) !== 'original';
}

// Older clients send `ttsEnabled` and know nothing about modes. Map that onto
// the mode vocabulary rather than keeping two sources of truth.
function audioModeFromBody(body, current) {
  const b = body || {};
  if (b.audioMode !== undefined) return normAudioMode(b.audioMode, current);
  if (b.ttsEnabled !== undefined) {
    if (b.ttsEnabled === false) return 'original';
    const base = normAudioMode(current, CONFIG.AUDIO.DEFAULT_MODE);
    if (base !== 'original') return base;
    return CONFIG.AUDIO.DEFAULT_MODE !== 'original' ? CONFIG.AUDIO.DEFAULT_MODE : 'translation';
  }
  return normAudioMode(current, CONFIG.AUDIO.DEFAULT_MODE);
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
    audioMode: normAudioMode(p.audio_mode, CONFIG.AUDIO.DEFAULT_MODE),
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
    tiers: CONFIG.SCALE_TIERS,
    tierByPurpose: PURPOSE_TIER,
    degrade: CONFIG.DEGRADE_THRESHOLDS,
    limits: LIMITS,
    latency: CONFIG.LATENCY,
    audio: CONFIG.AUDIO,
    llmEnabled: translator.LLM_ENABLED,
    engine: translator.activeEngineId(),
    dialIn: telephony.status(),
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
          audioMode: normAudioMode(p.audio_mode, CONFIG.AUDIO.DEFAULT_MODE),
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
      prefs: {
        speaksLang: guess,
        hearsLang: guess,
        audioMode: CONFIG.AUDIO.DEFAULT_MODE,
        ttsEnabled: ttsFromMode(CONFIG.AUDIO.DEFAULT_MODE),
        isDefault: true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/me/prefs', async (req, res) => {
  const speaks = normLang(req.body && req.body.speaksLang, 'en');
  const hears = normLang(req.body && req.body.hearsLang, 'en');
  try {
    const { rows: existing } = await pool.query(
      'SELECT audio_mode FROM user_language_prefs WHERE user_id = $1',
      [req.user.id]
    );
    const audioMode = audioModeFromBody(
      req.body,
      existing.length ? existing[0].audio_mode : CONFIG.AUDIO.DEFAULT_MODE
    );
    const tts = ttsFromMode(audioMode);
    await pool.query(
      `INSERT INTO user_language_prefs
         (user_id, username, speaks_lang, hears_lang, tts_enabled, audio_mode, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET username = EXCLUDED.username, speaks_lang = EXCLUDED.speaks_lang,
             hears_lang = EXCLUDED.hears_lang, tts_enabled = EXCLUDED.tts_enabled,
             audio_mode = EXCLUDED.audio_mode,
             updated_at = NOW()`,
      [req.user.id, req.user.username, speaks, hears, tts, audioMode]
    );
    res.json({
      prefs: {
        speaksLang: speaks, hearsLang: hears, audioMode, ttsEnabled: tts, isDefault: false,
      },
    });
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
  // Each pinned use case starts in the tier that matches how it actually runs
  // (a townhall is a large room from the first second), but the host may pick
  // a bigger one up front rather than upgrading mid-call.
  const requested = req.body && req.body.scaleTier;
  const scaleTier = TIER_KEYS.includes(requested)
    ? requested
    : (PURPOSE_TIER[purpose] || 'direct');

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
        `INSERT INTO rooms (code, title, purpose, host_user_id, host_username, two_way, scale_tier, seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1)
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [code, title, purpose, req.user.id, req.user.username, twoWay, scaleTier]
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
    // A room is a durable address; the SITTING is what accrues cost. Opening
    // the ledger row is best-effort — a dashboard is never worth a failed call.
    cost.startSession(pool, room.id, scaleTier, translator.activeEngineId())
      .catch((err) => console.error('[cost] session open failed', err.message));
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
      // Two ceilings, and the room takes the lower: the tier the host chose,
      // and the app-wide maximum. A direct call that has quietly become a
      // meeting is an upgrade the host makes, not something a joiner forces.
      const tier = tierFor(room);
      const peopleCap = Math.min(tier.maxParticipants, LIMITS.MAX_PARTICIPANTS);
      if (counts.rows[0].n >= peopleCap) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'room_full',
          tier: tier.key,
          max: peopleCap,
          message: `This ${tier.label.toLowerCase()} holds ${peopleCap} people. The host can move it to a larger room.`,
        });
      }
      const distinct = await client.query(
        `SELECT DISTINCT hears_lang FROM room_participants
         WHERE room_id = $1 AND left_at IS NULL AND removed = FALSE`,
        [room.id]
      );
      const langs = new Set(distinct.rows.map((r) => r.hears_lang));
      // The language cap is the one that actually bounds spend, so it is
      // enforced here AND again as a slice in the fan-out.
      const langCap = Math.min(tier.maxTargetLangs, LIMITS.MAX_TARGET_LANGS);
      if (!langs.has(hears) && langs.size >= langCap) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'too_many_languages',
          max: langCap,
          message: `This call already carries ${langCap} listening languages, the maximum for a ${tier.label.toLowerCase()}.`,
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
      const langCap = Math.min(tierFor(room).maxTargetLangs, LIMITS.MAX_TARGET_LANGS);
      if (!langs.has(hears) && langs.size >= langCap) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'too_many_languages',
          max: langCap,
          message: `This call already carries ${langCap} listening languages, the maximum.`,
        });
      }
    }

    // A host-muted participant cannot un-mute themselves; that is the whole
    // point of the moderation control.
    let micOn = b.micOn === undefined ? me.mic_on : !!b.micOn;
    if (me.muted_by_host) micOn = false;
    const audioMode = audioModeFromBody(b, me.audio_mode);
    const tts = ttsFromMode(audioMode);
    const hand = b.handRaised === undefined
      ? me.hand_raised_at
      : (b.handRaised ? (me.hand_raised_at || new Date()) : null);

    const seq = await bumpSeq(client, room.id);
    await client.query(
      `UPDATE room_participants
       SET speaks_lang=$3, hears_lang=$4, mic_on=$5, tts_enabled=$6, hand_raised_at=$7,
           audio_mode=$9, last_seen_at=NOW(), left_at=NULL, seq=$8
       WHERE room_id=$1 AND user_id=$2`,
      [room.id, req.user.id, speaks, hears, micOn, tts, hand, seq, audioMode]
    );
    await client.query('COMMIT');

    // A speaker who changed the language they speak has started a new thread
    // of reference; the old translation session would answer the wrong
    // sentence.
    if (speaks !== me.speaks_lang) translator.resetSpeaker(room.id, req.user.id);

    // Switching the language you HEAR strands everything already on screen,
    // because no caption row exists for the language you just picked. Ask for
    // a small catch-up. Fire and forget: the switch itself must land at once,
    // and the captions arrive over the cursor stream like any others.
    let backfilling = 0;
    if (hears !== me.hears_lang) {
      backfilling = Math.min(CONFIG.LATENCY.BACKFILL_UTTERANCES, 5);
      if (await rateAllows('lang_switch', `user:${req.user.id}`, 3, '1 minute')) {
        backfillForListener(room, hears, req.user.id, req.userToken)
          .catch((err) => console.error('[backfill]', err.message));
      } else {
        backfilling = 0;
      }
    }

    res.json({ ok: true, seq, backfilling });
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

// Host-only tier upgrade. A call that started as two people walking through
// setup and turned into a fifteen-operator incident bridge should not have to
// be re-created at a new code — the address people already pasted into chat
// stays the address.
//
// Upgrades only, never shrinks. Going the other way would mean deciding which
// of the people already in the room get ejected, and there is no answer to
// that question that is not rude.
app.post('/api/rooms/:code/tier', async (req, res) => {
  const wanted = req.body && req.body.scaleTier;
  if (!TIER_KEYS.includes(wanted)) return res.status(400).json({ error: 'bad_tier' });

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
    if (room.ended_at) { await client.query('ROLLBACK'); return res.status(410).json({ error: 'room_ended' }); }

    const current = tierFor(room);
    // TIER_KEYS is ordered smallest to largest, so the comparison is the index.
    if (TIER_KEYS.indexOf(wanted) < TIER_KEYS.indexOf(current.key)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'cannot_shrink_tier',
        message: 'A room can grow mid-call but cannot shrink — nobody gets ejected.',
        current: current.key,
      });
    }

    const seq = await bumpSeq(client, room.id);
    const { rows: updated } = await client.query(
      'UPDATE rooms SET scale_tier = $2 WHERE id = $1 RETURNING *',
      [room.id, wanted]
    );
    await client.query('COMMIT');
    res.json({ ok: true, room: publicRoom(updated[0]), seq });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// The floor. Generalized from one active speaker to N slots (direct 1,
// group 3, large 1) — see lib/floor.js. A lease is a ROW whose `until` has
// not passed, so a speaker whose tab died stops holding the floor without
// anyone having to notice.
app.post('/api/rooms/:code/floor', async (req, res) => {
  const wantsRelease = !!(req.body && req.body.release);
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
    if (me.muted_by_host) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'muted_by_host' }); }

    if (wantsRelease) {
      await floor.release(client, room.id, req.user.id);
      await client.query(
        `UPDATE rooms SET active_speaker_user_id = NULL, active_speaker_until = NULL
         WHERE id = $1 AND active_speaker_user_id = $2`,
        [room.id, req.user.id]
      );
      const holders = await floor.activeSpeakers(client, room.id);
      await client.query('COMMIT');
      return res.json({ ok: true, holder: null, activeSpeakers: holders });
    }

    const tier = tierFor(room);
    const result = await floor.claim(client, room.id, req.user, tier);
    if (!result.granted) {
      // Their hand went up as part of the claim, so the room state changed.
      const seq = await bumpSeq(client, room.id);
      await client.query('COMMIT');
      return res.status(409).json({
        error: 'floor_taken',
        queued: true,
        position: result.position,
        slots: tier.speakerSlots,
        holder: result.holders.length ? result.holders[0].userId : null,
        holders: result.holders,
        seq,
      });
    }

    // Keep the legacy scalar in step for the single-slot tiers, so a client
    // that has not reloaded across this deploy still shows a speaker.
    if (tier.speakerSlots === 1) {
      await client.query(
        `UPDATE rooms SET active_speaker_user_id = $2, active_speaker_until = $3 WHERE id = $1`,
        [room.id, req.user.id, result.until]
      );
    }
    // A renewal is not news; only a fresh claim moves the room's cursor.
    let seq = Number(room.seq);
    if (!result.renewed) seq = await bumpSeq(client, room.id);
    const holders = await floor.activeSpeakers(client, room.id);
    await client.query('COMMIT');
    res.json({ ok: true, holder: req.user.id, until: result.until, activeSpeakers: holders, seq });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Dial-in. Answers 501 in EVERY environment, because the capability is
// missing from the platform rather than from this deploy — see
// lib/bridge/telephony.js. The room UI shows the row as "coming soon" rather
// than hiding it, so the roadmap is visible and the honest answer is one tap
// away instead of being a surprise.
app.post('/api/rooms/:code/dial-in', async (req, res) => {
  try {
    const room = await findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'room_not_found' });
    const result = await telephony.requestDialIn(room);
    res.status(501).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- utterances ------------------------------------------------------------
// Fan-out: one translation call per LANGUAGE GROUP, not per listener.
//
// This is the whole cost argument. Sixty Indonesian listeners in a townhall
// are one call, not sixty, so the bill tracks G (distinct target languages)
// while the audience tracks N. Three bounds hold it down, and all three are
// structural rather than hopeful: the tier's language cap, the global
// MAX_TARGET_LANGS slice, and the degradation ladder in lib/cost.js.
async function fanOutTranslations(room, utterance, userToken, opts) {
  const options = opts || {};
  const tier = tierFor(room);
  const degrade = cost.level(room.id);
  const engineId = translator.activeEngineId();

  let targets = [];
  let groups = [];
  try {
    groups = await langgroups.languageGroups(pool, room.id);
    targets = langgroups.resolveTargets(groups, utterance.source_lang, tier, degrade, {
      speakerHoldsFloor: !!options.speakerHoldsFloor,
    });
  } catch (err) {
    console.error('[translate] could not resolve targets:', err.message);
    return;
  }

  const sizeOf = Object.fromEntries(groups.map((g) => [g.lang, g.size]));

  if (!targets.length && degrade !== 'normal') {
    // Degrading is not silence: the transcript still flows, and the room is
    // told why the captions stopped rather than being left to guess.
    console.log(`[translate] room=${room.id} tier=${tier.key} src=${utterance.source_lang} `
      + `groups=${groups.length} status=shed code=${degrade}`);
  }

  for (const group of targets) {
    translateInto(room, utterance, group.lang, sizeOf[group.lang] || 1, userToken,
      { tier, degrade, engineId });
  }
}

// One target language, start to finish: place the pending row, run the call,
// write the result. Split out of the fan-out loop because the language-switch
// backfill needs exactly this and must not get a second, drifting copy of it.
async function translateInto(room, utterance, target, groupSize, userToken, ctx) {
  const { tier, degrade, engineId } = ctx;
  {
    // Insert the pending row first so listeners see "translating…" rather
    // than a caption that appears out of nowhere a second later.
    let placed = false;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const seq = await bumpSeq(client, room.id);
        const ins = await client.query(
          `INSERT INTO utterance_translations
             (utterance_id, room_id, target_lang, status, seq, group_size, engine_id)
           VALUES ($1,$2,$3,'pending',$4,$5,$6)
           ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
          [utterance.id, room.id, target, seq, groupSize, engineId]
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
      return;
    }
    // Someone already placed this caption (a re-fan-out, or a backfill racing
    // the live fan-out). Not an error, just nothing left to do.
    if (!placed) return;

    // EVERY fan-out path goes through enqueue(): serial per (room, target) so
    // a listener's captions arrive in the order they were spoken, and shed
    // rather than queued without bound when the proxy falls behind.
    translator.enqueue(room.id, target, async () => {
      const result = await translator.translate({
        roomId: room.id,
        // The session this caption belongs to. Per speaker, not per room.
        speakerUserId: utterance.speaker_user_id,
        sourceLang: utterance.source_lang,
        targetLang: target,
        sourceText: utterance.source_text,
        userToken,
        // Delta captions: a provisional caption is written as the model
        // writes, so a listener starts reading before the sentence is done.
        onPartial: (partial) => {
          writePartial(room.id, utterance.id, target, partial).catch(() => {});
        },
      });

      const deltaCents = cost.noteMeter(room.id, utterance.speaker_user_id, result.meter);
      cost.noteTranslation(pool, room.id, deltaCents, cost.level(room.id))
        .catch(() => {});

      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // A speaker who retracted mid-flight does not get their words
          // published a second later by a call that was already in the air.
          const { rows: live } = await client.query(
            'SELECT retracted FROM utterances WHERE id = $1',
            [utterance.id]
          );
          const retracted = !live.length || live[0].retracted;

          // Seal the rest of the caption. If the finished text no longer
          // agrees with what was already sealed, `finalize` throws the whole
          // segment list away and returns the caption as one segment: one
          // honest reading beats a clever one that contradicts the screen.
          const { rows: prevSeg } = await client.query(
            `SELECT segments FROM utterance_translations
              WHERE utterance_id = $1 AND target_lang = $2 FOR UPDATE`,
            [utterance.id, target]
          );
          const before = prevSeg[0] && Array.isArray(prevSeg[0].segments) ? prevSeg[0].segments : [];
          const speakable = !retracted && result.status === 'ok' && result.text;
          const sealed = speakable
            ? segment.finalize(before, result.text)
            : { segments: [], reset: false };

          const seq = await bumpSeq(client, room.id);
          await client.query(
            `UPDATE utterance_translations
             SET text=$3, status=$4, latency_ms=$5, ttft_ms=$6, seq=$7,
                 group_size=$8, engine_id=$9, finalized_at=NOW(),
                 segments=$10::jsonb, sealed_idx=$11,
                 first_segment_at = COALESCE(first_segment_at, CASE WHEN $11 > 0 THEN NOW() END)
             WHERE utterance_id=$1 AND target_lang=$2`,
            [utterance.id, target,
              retracted ? null : result.text,
              retracted ? 'retracted' : result.status,
              result.latencyMs, result.ttftMs, seq, groupSize, engineId,
              JSON.stringify(sealed.segments), sealed.segments.length]
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

      // One structured line per call, with no utterance content in it — this
      // is the monitoring surface, not a transcript log.
      console.log(`[translate] room=${room.id} tier=${tier.key} src=${utterance.source_lang} `
        + `tgt=${target} group=${groupSize} status=${result.status} `
        + `ttft=${result.ttftMs == null ? '-' : result.ttftMs} `
        + `lat=${result.latencyMs == null ? '-' : result.latencyMs} `
        + `code=${result.code || '-'} degrade=${degrade} `
        + `cap=${tier.maxTargetLangs} capture=${utterance.capture_ms == null ? '-' : utterance.capture_ms}`);

      return result;
    });
  }
}

// A partial caption is a provisional row: same row, `status='partial'`, a new
// seq so the cursor stream carries it. The client renders it dimmed and
// deliberately never SPEAKS it — hearing half a sentence read aloud and then
// the whole sentence again is worse than waiting.
async function writePartial(roomId, utteranceId, target, text) {
  if (!text) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Seal whatever clauses are now complete. Sealing is append-only by
    // construction, so a listener who already heard clause 1 can never be
    // handed a different clause 1 on the next tick.
    const { rows: prev } = await client.query(
      `SELECT segments FROM utterance_translations
        WHERE utterance_id = $1 AND target_lang = $2 FOR UPDATE`,
      [utteranceId, target]
    );
    const before = prev[0] && Array.isArray(prev[0].segments) ? prev[0].segments : [];
    const sealed = segment.sealSegments(before, text, { final: false });
    const segments = sealed.diverged ? before : sealed.segments;
    const seq = await bumpSeq(client, roomId);
    await client.query(
      `UPDATE utterance_translations
          SET text = $3, status = 'partial', seq = $4,
              segments = $5::jsonb, sealed_idx = $6,
              first_segment_at = COALESCE(first_segment_at, CASE WHEN $6 > 0 THEN NOW() END)
        WHERE utterance_id = $1 AND target_lang = $2 AND status IN ('pending','partial')`,
      [utteranceId, target, text, seq, JSON.stringify(segments), segments.length]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    client.release();
  }
}

// --- backfill on a language switch -------------------------------------------
// Changing the language you hear used to strand every sentence already on
// screen: no `utterance_translations` row exists for the new target, so the
// feed said "waiting for a caption" forever. Nothing was going to write one,
// because fan-out only ever runs for the languages present when a sentence
// was spoken.
//
// So the switch itself asks for a small, bounded catch-up: the last few
// sentences, translated into the language you just picked. Bounded on
// purpose. Re-translating a whole call because someone tapped a flag is a
// cost bomb, and the degradation ladder outranks convenience — when the room
// is already shedding captions this does nothing at all.
async function backfillForListener(room, targetLang, listenerUserId, userToken) {
  const degrade = cost.level(room.id);
  if (degrade !== 'normal' || room.mode === 'transcript_only') return 0;

  const tier = tierFor(room);
  const engineId = translator.activeEngineId();

  let rows;
  try {
    const r = await pool.query(
      `SELECT u.* FROM utterances u
        WHERE u.room_id = $1
          AND u.retracted = FALSE
          AND u.speaker_user_id <> $2
          AND u.source_lang <> $3
          AND NOT EXISTS (
            SELECT 1 FROM utterance_translations t
             WHERE t.utterance_id = u.id AND t.target_lang = $3
          )
        ORDER BY u.seq DESC
        LIMIT $4`,
      [room.id, listenerUserId, targetLang, CONFIG.LATENCY.BACKFILL_UTTERANCES]
    );
    rows = r.rows;
  } catch (err) {
    console.error('[backfill] lookup failed:', err.message);
    return 0;
  }

  // Oldest first so the catch-up reads in the order it was said.
  for (const utterance of rows.reverse()) {
    translateInto(room, utterance, targetLang, 1, userToken, { tier, degrade, engineId });
  }
  if (rows.length) {
    console.log(`[backfill] room=${room.id} tgt=${targetLang} n=${rows.length}`);
  }
  return rows.length;
}

// --- delivery latency --------------------------------------------------------
// The listener reports how long a finished caption took to reach the screen.
// It sends a duration it measured, never a timestamp, so no clock skew enters
// the number; the server supplies the capture and translate legs itself from
// rows it already wrote, which also means a client cannot invent them.
app.post('/api/rooms/:code/latency', async (req, res) => {
  try {
    const room = await findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'Room not found', code: 'room_not_found' });
    if (!(await rateAllows('latency', `user:${req.user.id}`, 30, '1 minute'))) {
      // Telemetry is never worth an error the user has to read.
      return res.json({ ok: true, written: 0, throttled: true });
    }
    const written = await latencyLog.record(
      pool, room.id, tierFor(room).key, req.body && req.body.samples
    );
    res.json({ ok: true, written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms/:code/utterances', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  const via = (req.body && req.body.via) === 'typed' ? 'typed' : 'voice';
  // Capture leg: how long the browser's recogniser held the phrase before it
  // called it final. Only the browser can see it, so it reports it — and only
  // for voice, because a typing pause is a person thinking, not a delay the
  // app can shorten.
  const rawCapture = Number(req.body && req.body.captureMs);
  const captureMs = via === 'voice' && Number.isFinite(rawCapture)
    && rawCapture >= 0 && rawCapture <= 120000 ? Math.round(rawCapture) : null;
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
        `INSERT INTO utterances
           (room_id, speaker_user_id, speaker_username, source_lang, source_text, via, seq, capture_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [room.id, req.user.id, req.user.username, sourceLang, text, via, seq, captureMs]
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

    cost.noteUtterance(pool, room.id).catch(() => {});

    // Transcript-only mode (the host's escape hatch, and the bottom rung of
    // the budget ladder) still records what was said — it just does not spend
    // anyone's AI budget translating it.
    if (room.mode !== 'transcript_only') {
      const holdsFloor = await floor.holdsFloor(pool, room.id, req.user.id).catch(() => false);
      fanOutTranslations(room, utterance, req.userToken, { speakerHoldsFloor: holdsFloor })
        .catch((err) => console.error('[translate] fan-out failed:', err.message));
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
// Assembly lives in lib/stream.js. What stays here is the route: auth is
// already applied above, the helpers are this file's, and the only decision
// left is whether to answer immediately or hold the request open.
const STREAM_DEPS = {
  pool, langgroups, floor, cost, telephony,
  getParticipant, tierFor, publicTier, publicRoom, publicParticipant,
};

app.get('/api/rooms/:code/stream', async (req, res) => {
  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  const wantsWait = req.query.wait === '1';
  try {
    let room = await findRoom(req.params.code);
    // An unknown code is an ordinary answer here, not a transport failure: this
    // endpoint is hit by a plain page load, and a 404 makes the browser log a
    // console error that fails the baseline no-console-errors check. The
    // mutating routes below still 404 properly — nothing loads them on boot.
    if (!room) return res.json({ notFound: true, seq: 0 });

    // Long poll. Holding the request removes the client's idle tick from the
    // delivery leg entirely: the caption ships the moment it is written
    // instead of up to a full interval later. Small rooms only — a held
    // request per listener is exactly what does not scale to an audience of
    // hundreds, which is why the tier carries the flag.
    const tier = tierFor(room);
    const held = wantsWait && tier.longPoll && since > 0 && !room.ended_at && !shuttingDown
      && Number(room.seq) <= since;
    if (held) {
      await stream.waitForChange(pool, room.id, since, { isShuttingDown: () => shuttingDown });
      // The client is still connected only if it is: a browser that navigated
      // away during the hold leaves nothing worth assembling.
      if (res.writableEnded || req.destroyed) return;
      const fresh = await findRoom(req.params.code);
      if (!fresh) return res.json({ notFound: true, seq: 0 });
      room = fresh;
    }

    const payload = await stream.assemble(STREAM_DEPS, { room, user: req.user, since });
    payload.held = held;
    res.json(payload);
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
    await floor.release(client, room.id, req.user.id);
    if (endRoom && room.host_user_id === req.user.id && !room.ended_at) {
      await floor.releaseAll(client, room.id);
      await client.query(
        `UPDATE rooms SET ended_at = NOW(), end_reason = 'host_ended' WHERE id = $1`,
        [room.id]
      );
    }
    await client.query('COMMIT');
    if (endRoom && room.host_user_id === req.user.id) {
      translator.forgetRoom(room.id);
      cost.endSession(pool, room.id).catch(() => {});
    }
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
    const [latency, rollups, grants, live, byTier, spend, degraded, endToEnd] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS n,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms))::int AS p50,
           ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ttft_ms))::int AS ttft_p50,
           ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ttft_ms))::int AS ttft_p95,
           COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
           COUNT(*) FILTER (WHERE status = 'unavailable')::int AS unavailable,
           ROUND(AVG(group_size), 1)::float AS avg_group_size
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
      // Latency is not one number: a townhall fanning out to four languages
      // and a two-person support call are different workloads, and averaging
      // them together hides whichever one is sick.
      pool.query(
        `SELECT r.scale_tier AS tier,
                COUNT(t.*)::int AS n,
                ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.latency_ms))::int AS p50,
                ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.latency_ms))::int AS p95
           FROM utterance_translations t
           JOIN rooms r ON r.id = t.room_id
          WHERE t.created_at > NOW() - INTERVAL '7 days' AND t.status = 'ok'
          GROUP BY r.scale_tier
          ORDER BY COUNT(t.*) DESC`
      ),
      // Cost per call, read off the proxy's own meter rather than a token
      // price table this app would only get wrong.
      pool.query(
        `SELECT COALESCE(SUM(spent_cents), 0)::float AS spent_cents,
                COALESCE(SUM(translation_calls), 0)::int AS calls,
                COALESCE(SUM(utterances), 0)::int AS utterances,
                COUNT(*)::int AS sessions
           FROM room_sessions
          WHERE started_at > NOW() - INTERVAL '7 days'`
      ),
      pool.query(
        `SELECT degraded_to, COUNT(*)::int AS n
           FROM room_sessions
          WHERE started_at > NOW() - INTERVAL '7 days' AND degraded_to IS NOT NULL
          GROUP BY degraded_to`
      ),
      // The three legs of the wait, measured separately. `latency` above is
      // the middle one only.
      latencyLog.endToEnd(pool),
    ]);
    const grantMap = Object.fromEntries(grants.rows.map((r) => [r.outcome, r.n]));
    const asked = (grantMap.granted || 0) + (grantMap.declined || 0) + (grantMap.dismissed || 0);
    res.json({
      isAdmin: isAdmin(req.user),
      latency: latency.rows[0],
      endToEnd,
      daily: rollups.rows,
      grants: {
        ...grantMap,
        asked,
        acceptanceRate: asked ? Math.round(((grantMap.granted || 0) / asked) * 100) : null,
      },
      live: live.rows[0],
      byTier: byTier.rows,
      cost: {
        spentCents: spend.rows[0].spent_cents,
        calls: spend.rows[0].calls,
        utterances: spend.rows[0].utterances,
        sessions: spend.rows[0].sessions,
        // Cost per LISTENER is this divided by the average group size — which
        // is the entire argument for grouping, stated as a number.
        centsPerCall: spend.rows[0].calls
          ? Math.round((spend.rows[0].spent_cents / spend.rows[0].calls) * 10000) / 10000
          : null,
      },
      degraded: Object.fromEntries(degraded.rows.map((r) => [r.degraded_to, r.n])),
      engines: translator.engineStatus(),
      engine: translator.activeEngineId(),
      translationSessions: translator.sessionCount(),
      dialIn: telephony.status(),
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
    // Latency samples are aggregates, not content, but they are also not
    // interesting past the window the metrics screen reads.
    await latencyLog.prune(pool);
    // In-memory translation sessions nobody has spoken into for ten minutes.
    const dropped = translator.sweepSessions();
    if (dropped) console.log(`[housekeeping] dropped ${dropped} idle translation sessions`);
    // Lapsed floor leases. Claiming already reaps, but a room that went quiet
    // should not keep showing a speaker who left an hour ago.
    await pool.query(`DELETE FROM active_speakers WHERE until <= NOW() - INTERVAL '5 minutes'`);
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
    // A sitting ends when its room does, even if nobody was around to say so.
    await pool.query(
      `UPDATE room_sessions s SET ended_at = COALESCE(r.ended_at, NOW())
         FROM rooms r
        WHERE r.id = s.room_id AND s.ended_at IS NULL AND r.ended_at IS NOT NULL`
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
