// Cost ledger and the degradation ladder.
//
// This app NEVER computes token prices. The platform proxy returns a spend
// meter on every call — `x-usernode-llm-spent-cents` (the speaker's spend
// through this app today) and `x-usernode-llm-cap-cents` (their cap) — and
// those two numbers are the whole ledger. Reading them instead of modelling
// them is what stops the ladder from being wrong the day pricing changes.
//
// The ladder, as fractions of the cap:
//   >= 0.70  shed_small       — keep only the largest language group
//   >= 0.90  floor_only       — translate only what a floor-holder says
//   >= 1.00  transcript_only  — nothing is translated; everyone still SPEAKS
//
// Note what degradation never does: it never stops the call, never blocks the
// speaker, and never hides a feature. The transcript keeps flowing at every
// rung, which is exactly why running out of budget is a caption state rather
// than an outage.

const { DEGRADE_THRESHOLDS } = require('./config');

// roomId -> { spentCents, capCents, ratio, at }
const state = new Map();
// `${roomId}:${userId}` -> last meter reading, so per-room attribution is the
// DELTA of a user's daily spend across their calls in this room. Approximate
// by construction (a user in two rooms at once splits imperfectly) and
// documented as such — it drives a dashboard, not a bill.
const lastSeen = new Map();
// roomId -> open room_sessions.id
const sessions = new Map();

function levelFor(ratio) {
  if (!Number.isFinite(ratio)) return 'normal';
  if (ratio >= DEGRADE_THRESHOLDS.TRANSCRIPT_ONLY) return 'transcript_only';
  if (ratio >= DEGRADE_THRESHOLDS.FLOOR_ONLY) return 'floor_only';
  if (ratio >= DEGRADE_THRESHOLDS.SHED_SMALL_GROUPS) return 'shed_small';
  return 'normal';
}

/** Current degradation rung for a room. 'normal' until a meter says otherwise. */
function level(roomId) {
  const s = state.get(String(roomId));
  return s ? levelFor(s.ratio) : 'normal';
}

/** What the host sees: a percentage and a rung, never a dollar figure. */
function budgetFor(roomId) {
  const s = state.get(String(roomId));
  if (!s) return { level: 'normal', spentPct: null };
  return {
    level: levelFor(s.ratio),
    spentPct: Math.round(Math.min(1, Math.max(0, s.ratio)) * 100),
  };
}

/**
 * Record a meter reading from a proxy response. Returns the delta in cents
 * attributable to this room, which is what gets added to the session ledger.
 */
function noteMeter(roomId, userId, meter) {
  if (!meter || !Number.isFinite(meter.spentCents) || !(meter.capCents > 0)) return 0;
  const rid = String(roomId);
  state.set(rid, {
    spentCents: meter.spentCents,
    capCents: meter.capCents,
    ratio: meter.spentCents / meter.capCents,
    at: Date.now(),
  });

  const key = `${rid}:${userId}`;
  const prev = lastSeen.get(key);
  lastSeen.set(key, meter.spentCents);
  if (!Number.isFinite(prev)) return 0;
  return Math.max(0, meter.spentCents - prev);
}

function forgetRoom(roomId) {
  const rid = String(roomId);
  state.delete(rid);
  sessions.delete(rid);
  for (const key of lastSeen.keys()) {
    if (key.startsWith(`${rid}:`)) lastSeen.delete(key);
  }
}

// --- room_sessions ---------------------------------------------------------
// A room is a durable address; a session is one sitting inside it. Every
// write here is failure-tolerant: a ledger that throws would take down a call,
// and no dashboard is worth that.

async function startSession(pool, roomId, tier, engineId) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO room_sessions (room_id, engine_id, scale_tier)
       VALUES ($1, $2, $3) RETURNING id`,
      [roomId, engineId, tier]
    );
    sessions.set(String(roomId), rows[0].id);
    return rows[0].id;
  } catch (err) {
    console.error('[cost] startSession failed', err.message);
    return null;
  }
}

async function currentSession(pool, roomId) {
  const cached = sessions.get(String(roomId));
  if (cached) return cached;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM room_sessions
        WHERE room_id = $1 AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [roomId]
    );
    if (rows.length) {
      sessions.set(String(roomId), rows[0].id);
      return rows[0].id;
    }
  } catch (err) {
    console.error('[cost] currentSession failed', err.message);
  }
  return null;
}

async function noteUtterance(pool, roomId) {
  const id = await currentSession(pool, roomId);
  if (!id) return;
  try {
    await pool.query(`UPDATE room_sessions SET utterances = utterances + 1 WHERE id = $1`, [id]);
  } catch (err) {
    console.error('[cost] noteUtterance failed', err.message);
  }
}

async function noteTranslation(pool, roomId, deltaCents, degradedTo) {
  const id = await currentSession(pool, roomId);
  if (!id) return;
  try {
    await pool.query(
      `UPDATE room_sessions
          SET translation_calls = translation_calls + 1,
              spent_cents = spent_cents + $2,
              degraded_to = COALESCE($3, degraded_to)
        WHERE id = $1`,
      [id, Number(deltaCents) || 0, degradedTo && degradedTo !== 'normal' ? degradedTo : null]
    );
  } catch (err) {
    console.error('[cost] noteTranslation failed', err.message);
  }
}

async function endSession(pool, roomId) {
  const id = await currentSession(pool, roomId);
  forgetRoom(roomId);
  if (!id) return;
  try {
    await pool.query(`UPDATE room_sessions SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL`, [id]);
  } catch (err) {
    console.error('[cost] endSession failed', err.message);
  }
}

module.exports = {
  level, levelFor, budgetFor, noteMeter, forgetRoom,
  startSession, currentSession, noteUtterance, noteTranslation, endSession,
};
