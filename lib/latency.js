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
//   audio     the sealed clause sitting on screen until the listener's own
//             synthesiser actually starts speaking it
//
// The fourth leg is the one Slice 2 added, and it is the only one that can
// legitimately be absent: a listener reading subtitles has no audio leg, and
// a device whose synthesiser refuses to start records the attempt as a
// fallback rather than as a very slow success. So `total` stays the
// three-leg number it always was, and `heard` is the four-leg one measured
// only over rows that actually produced a voice.
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
  // The browser's own trace id for the sentence, carried back out so the log
  // line for the fourth leg can be joined to the three that came before it.
  const traces = [];
  for (const s of list) {
    const utteranceId = parseInt(s && s.utteranceId, 10);
    const targetLang = s && typeof s.targetLang === 'string' ? s.targetLang.slice(0, 8) : null;
    const deliverMs = clean(s && s.deliverMs);
    if (!utteranceId || !targetLang || deliverMs === null) continue;
    const audioMs = clean(s && s.audioMs);
    // 'spoken' or 'fallback'. Anything else, including a listener who is
    // reading on purpose, records no outcome at all rather than a guess.
    const audioOutcome = s && (s.audioOutcome === 'spoken' || s.audioOutcome === 'fallback')
      ? s.audioOutcome
      : (audioMs === null ? null : 'spoken');
    try {
      const r = await pool.query(
        `INSERT INTO latency_samples
           (room_id, target_lang, tier, capture_ms, translate_ms, deliver_ms, audio_ms, audio_outcome)
         SELECT $1, $2, $3, u.capture_ms, t.latency_ms, $4, $6, $7
           FROM utterances u
           JOIN utterance_translations t
             ON t.utterance_id = u.id AND t.target_lang = $2
          WHERE u.id = $5 AND u.room_id = $1 AND t.status = 'ok'
         RETURNING (SELECT trace_id FROM utterances WHERE id = $5) AS trace_id`,
        [roomId, targetLang, tier, deliverMs, utteranceId, audioMs, audioOutcome]
      );
      written += r.rowCount;
      for (const row of r.rows) if (row.trace_id) traces.push(row.trace_id);
    } catch {
      // A sample is telemetry. Losing one must never fail a listener's poll.
    }
  }
  return { written, traces };
}

const PCTS = `
  COUNT(*)::int AS n,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY capture_ms))[1]::int   AS capture_p50,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY capture_ms))[2]::int   AS capture_p95,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY translate_ms))[1]::int AS translate_p50,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY translate_ms))[2]::int AS translate_p95,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY deliver_ms))[1]::int   AS deliver_p50,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY deliver_ms))[2]::int   AS deliver_p95,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY
    COALESCE(capture_ms,0) + COALESCE(translate_ms,0) + COALESCE(deliver_ms,0)))[1]::int  AS total_p50,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY
    COALESCE(capture_ms,0) + COALESCE(translate_ms,0) + COALESCE(deliver_ms,0)))[2]::int  AS total_p95,
  COUNT(audio_ms)::int AS audio_n,
  SUM(CASE WHEN audio_outcome = 'fallback' THEN 1 ELSE 0 END)::int AS audio_fallbacks,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY audio_ms))[1]::int     AS audio_p50,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY audio_ms))[2]::int     AS audio_p95,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY (CASE WHEN audio_ms IS NULL THEN NULL
    ELSE COALESCE(capture_ms,0) + COALESCE(translate_ms,0) + COALESCE(deliver_ms,0) + audio_ms END)))[1]::int  AS heard_p50,
  (PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY (CASE WHEN audio_ms IS NULL THEN NULL
    ELSE COALESCE(capture_ms,0) + COALESCE(translate_ms,0) + COALESCE(deliver_ms,0) + audio_ms END)))[2]::int  AS heard_p95
`;

// The dashboard can ask for a shorter window than the retention period. The
// value is not interpolated from user input: `rangeSql` maps a fixed set of
// tokens onto a fixed set of intervals, and anything unrecognised falls back
// to the default.
const RANGES = {
  '1h': "NOW() - INTERVAL '1 hour'",
  '24h': "NOW() - INTERVAL '24 hours'",
  '7d': `NOW() - INTERVAL '${LATENCY.SAMPLE_RETENTION_DAYS} days'`,
};
const DEFAULT_RANGE = '7d';

function rangeSql(range) {
  return RANGES[range] || RANGES[DEFAULT_RANGE];
}

// --- the windowed aggregate, memoised ---------------------------------------
// These two queries are the app's most expensive by a wide margin, and the
// reason is structural: the default range IS the retention window, so the scan
// covers essentially the whole table however it is indexed — a week of samples
// is what is on disk. Two consequences, both worth fixing here rather than by
// adding hardware:
//
//   * Every dashboard view recomputed the identical number. The data changes
//     on human timescales (a call ends, a listener reports a leg), so a few
//     seconds of staleness is invisible on the screen and turns a burst of
//     reloads into one scan.
//   * Concurrent views ran the same scan N times at once. The cache stores the
//     PROMISE, so N simultaneous viewers coalesce onto the single in-flight
//     query instead of stampeding the pool — which is what made three dashboard
//     route groups loading together push a shared pool past its statement
//     deadline.
//
// Deliberately small and per-process: one entry per range, and a TTL short
// enough that the screen never reads as stale. Nothing here is a report;
// /admin/metrics is a live view, and a latency percentile fifteen seconds old
// is the same number to anyone reading it — the data behind it moves on the
// timescale of calls ending, not of page loads.
const END_TO_END_TTL_MS = 15000;
const endToEndCache = new Map();   // range -> { at, promise }

async function endToEnd(pool, range) {
  const key = range || DEFAULT_RANGE;
  const hit = endToEndCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < END_TO_END_TTL_MS) return hit.promise;

  const window = rangeSql(key);
  const promise = (async () => {
    const [overall, byTier] = await Promise.all([
      pool.query(`SELECT ${PCTS} FROM latency_samples WHERE created_at > ${window}`),
      pool.query(
        `SELECT COALESCE(tier, 'unknown') AS tier, ${PCTS}
           FROM latency_samples WHERE created_at > ${window}
          GROUP BY 1 ORDER BY 1`
      ),
    ]);
    return { overall: overall.rows[0], byTier: byTier.rows };
  })();
  // Cache the in-flight promise so simultaneous callers share one scan; a
  // rejection is dropped so the next caller retries instead of inheriting it.
  endToEndCache.set(key, { at: now, promise });
  promise.catch(() => { if (endToEndCache.get(key) && endToEndCache.get(key).promise === promise) endToEndCache.delete(key); });
  return promise;
}

async function prune(pool) {
  await pool.query(
    `DELETE FROM latency_samples WHERE created_at < NOW() - INTERVAL '${LATENCY.SAMPLE_RETENTION_DAYS} days'`
  );
}

module.exports = { record, endToEnd, prune, PCTS, rangeSql, RANGES, DEFAULT_RANGE };
