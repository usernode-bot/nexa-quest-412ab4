// End-to-end latency, in three parts.
//
// `utterance_translations.latency_ms` only ever measured the middle leg — the
// proxy call. That is the part the app controls and the least of what a
// listener waits through. A caption is late for three separable reasons, and
// mixing them into one number makes it impossible to know which one to fix:
//
//   capture   the browser recogniser deciding the phrase is finished
//   translate the LLM proxy call, first token to last
//   deliver   the caption sitting finished on the server until it reaches a
//             listener's screen (poll interval, network, render)
//
// Only the browser can see the first and third, so the client reports them.
// It reports a DURATION it measured, never a wall-clock time, so no clock
// skew enters the arithmetic. The server supplies `translate` itself from the
// row it already wrote, which also means a client cannot invent one.

const CONFIG = require('./config');

const { LATENCY } = CONFIG;
const MAX_LEG_MS = 120000;

function clean(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0 || v > MAX_LEG_MS) return null;
  return Math.round(v);
}

// One row per (utterance, target language) a listener actually saw. Assembled
// server-side by joining the private tables, but only integers land in the
// public `latency_samples` table: no text, no user id, no utterance id.
async function record(pool, roomId, tier, samples) {
  const list = (Array.isArray(samples) ? samples : []).slice(0, LATENCY.MAX_SAMPLES_PER_BATCH);
  let written = 0;
  for (const s of list) {
    const utteranceId = parseInt(s && s.utteranceId, 10);
    const targetLang = s && typeof s.targetLang === 'string' ? s.targetLang.slice(0, 8) : null;
    const deliverMs = clean(s && s.deliverMs);
    if (!utteranceId || !targetLang || deliverMs === null) continue;
    try {
      const r = await pool.query(
        `INSERT INTO latency_samples (room_id, target_lang, tier, capture_ms, translate_ms, deliver_ms)
         SELECT $1, $2, $3, u.capture_ms, t.latency_ms, $4
           FROM utterances u
           JOIN utterance_translations t
             ON t.utterance_id = u.id AND t.target_lang = $2
          WHERE u.id = $5 AND u.room_id = $1 AND t.status = 'ok'`,
        [roomId, targetLang, tier, deliverMs, utteranceId]
      );
      written += r.rowCount;
    } catch {
      // A sample is telemetry. Losing one must never fail a listener's poll.
    }
  }
  return written;
}

const PCTS = `
  COUNT(*)::int AS n,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY capture_ms))::int   AS capture_p50,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY capture_ms))::int  AS capture_p95,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY translate_ms))::int  AS translate_p50,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY translate_ms))::int AS translate_p95,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY deliver_ms))::int    AS deliver_p50,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY deliver_ms))::int   AS deliver_p95,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY COALESCE(capture_ms,0) + COALESCE(translate_ms,0) + COALESCE(deliver_ms,0)))::int  AS total_p50,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY COALESCE(capture_ms,0) + COALESCE(translate_ms,0) + COALESCE(deliver_ms,0)))::int AS total_p95
`;

async function endToEnd(pool) {
  const window = `NOW() - INTERVAL '${LATENCY.SAMPLE_RETENTION_DAYS} days'`;
  const [overall, byTier] = await Promise.all([
    pool.query(`SELECT ${PCTS} FROM latency_samples WHERE created_at > ${window}`),
    pool.query(
      `SELECT COALESCE(tier, 'unknown') AS tier, ${PCTS}
         FROM latency_samples WHERE created_at > ${window}
        GROUP BY 1 ORDER BY 1`
    ),
  ]);
  return { overall: overall.rows[0], byTier: byTier.rows };
}

async function prune(pool) {
  await pool.query(
    `DELETE FROM latency_samples WHERE created_at < NOW() - INTERVAL '${LATENCY.SAMPLE_RETENTION_DAYS} days'`
  );
}

module.exports = { record, endToEnd, prune };
