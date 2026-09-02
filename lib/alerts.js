// Alerting, in the only place it can live: inside the app.
//
// The platform has nothing to scrape. There is no Prometheus to point at this
// container, no Alertmanager to route from, and no way to ask for either. So
// the evaluator is a function on a five-minute timer that reads the same
// numbers the dashboard reads, through the same thresholds in `lib/slo.js`,
// and writes a row when one of them stays bad.
//
// "Stays bad" is doing real work there. A single window with three slow
// captions in it is weather. An alert opens only after two consecutive
// breaching evaluations and resolves only after two consecutive clear ones,
// which is the difference between a signal and a pager that everyone learns
// to ignore.

const SLO = require('./slo');
const log = require('./log');

// Consecutive-breach counters, per rule. Process-local on purpose: this is
// hysteresis state, not a record. A restart re-arms every rule, which costs at
// most one extra evaluation cycle before an ongoing problem opens again.
const streaks = new Map();

function bump(key, breaching) {
  const cur = streaks.get(key) || { bad: 0, good: 0 };
  if (breaching) { cur.bad += 1; cur.good = 0; } else { cur.good += 1; cur.bad = 0; }
  streaks.set(key, cur);
  return cur;
}

async function openAlert(pool, rule, severity, detail, roomId) {
  const { rows } = await pool.query(
    `SELECT id FROM alerts WHERE rule = $1 AND resolved_at IS NULL
       AND (room_id IS NOT DISTINCT FROM $2) LIMIT 1`,
    [rule, roomId || null]
  );
  if (rows.length) {
    await pool.query(`UPDATE alerts SET severity = $2, detail = $3::jsonb WHERE id = $1`,
      [rows[0].id, severity, JSON.stringify(detail || {})]);
    return false;
  }
  await pool.query(
    `INSERT INTO alerts (rule, severity, detail, room_id) VALUES ($1, $2, $3::jsonb, $4)`,
    [rule, severity, JSON.stringify(detail || {}), roomId || null]
  );
  log.warn('alert_open', { rule, severity, roomId: roomId || undefined, detail: JSON.stringify(detail || {}) });
  return true;
}

async function resolveAlert(pool, rule, roomId) {
  const { rowCount } = await pool.query(
    `UPDATE alerts SET resolved_at = NOW()
      WHERE rule = $1 AND resolved_at IS NULL AND (room_id IS NOT DISTINCT FROM $2)`,
    [rule, roomId || null]
  );
  if (rowCount) log.info('alert_resolve', { rule, roomId: roomId || undefined });
  return rowCount;
}

// Apply the open/resolve hysteresis for one rule.
async function settle(pool, rule, breaching, severity, detail, roomId) {
  const key = roomId ? `${rule}:${roomId}` : rule;
  const streak = bump(key, breaching);
  if (breaching && streak.bad >= SLO.CONSECUTIVE_TO_OPEN) {
    await openAlert(pool, rule, severity, detail, roomId);
  } else if (!breaching && streak.good >= SLO.CONSECUTIVE_TO_RESOLVE) {
    await resolveAlert(pool, rule, roomId);
  }
}

const SEV = { warn: 'warn', crit: 'crit' };

/**
 * One evaluation pass. Reads the last hour, not the dashboard's seven days:
 * an alert is about now, and a week of good data would bury a bad afternoon.
 */
async function evaluate(pool, deps) {
  const latency = deps.latency;
  const window = "NOW() - INTERVAL '60 minutes'";

  const [lat, tx, grants, silent] = await Promise.all([
    pool.query(`SELECT ${latency.PCTS} FROM latency_samples WHERE created_at > ${window}`),
    pool.query(
      `SELECT COUNT(*)::int AS n,
              SUM(CASE WHEN status IN ('error','unavailable') THEN 1 ELSE 0 END)::int AS bad,
              ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ttft_ms))::int AS ttft_p95
         FROM utterance_translations WHERE created_at > ${window}`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS asked,
              SUM(CASE WHEN outcome = 'granted' THEN 1 ELSE 0 END)::int AS granted
         FROM llm_grant_events WHERE created_at > NOW() - INTERVAL '24 hours'`
    ),
    // A room with somebody present in the last two minutes that has produced
    // no successful caption in five. Either the microphone leg is dead on
    // every device in it or the fan-out is stuck, and both look like silence.
    pool.query(
      `SELECT r.id, r.code
         FROM rooms r
        WHERE r.ended_at IS NULL
          AND EXISTS (
            SELECT 1 FROM room_participants p
             WHERE p.room_id = r.id AND p.left_at IS NULL AND p.removed = FALSE
               AND p.last_seen_at > NOW() - INTERVAL '2 minutes')
          AND NOT EXISTS (
            SELECT 1 FROM utterance_translations t
             WHERE t.room_id = r.id AND t.status = 'ok'
               AND t.created_at > NOW() - INTERVAL '5 minutes')
          AND r.created_at < NOW() - INTERVAL '5 minutes'
        LIMIT 20`
    ),
  ]);

  const L = lat.rows[0] || {};
  const T = tx.rows[0] || {};
  const failRate = Number(T.n) > 0 ? Number(T.bad) / Number(T.n) : null;
  const readiness = SLO.evaluate({
    latency: L,
    ttftP95: T.ttft_p95,
    failRate,
    translationCount: T.n,
  });

  const byKey = Object.fromEntries(readiness.checks.map((c) => [c.key, c]));

  const total = byKey.total;
  await settle(pool, 'latency_p95', total.verdict === 'warn' || total.verdict === 'crit',
    total.verdict === 'crit' ? SEV.crit : SEV.warn,
    { p95: total.value, target: total.target, n: total.n });

  const fw = byKey.firstWord;
  await settle(pool, 'first_word_p95', fw.verdict === 'warn' || fw.verdict === 'crit',
    fw.verdict === 'crit' ? SEV.crit : SEV.warn,
    { p95: fw.value, target: fw.target, n: fw.n });

  const fr = byKey.failRate;
  await settle(pool, 'error_rate', fr.verdict === 'warn' || fr.verdict === 'crit',
    fr.verdict === 'crit' ? SEV.crit : SEV.warn,
    { rate: fr.value, target: fr.target, n: fr.n });

  const af = byKey.audioFallbackRate;
  await settle(pool, 'audio_fallback_rate', af.verdict === 'warn' || af.verdict === 'crit',
    af.verdict === 'crit' ? SEV.crit : SEV.warn,
    { rate: af.value, target: af.target, n: af.n });

  // Grants: people declining AI access is a product signal, not an outage, so
  // it only ever opens at warn and needs a real sample behind it.
  const G = grants.rows[0] || {};
  const asked = Number(G.asked || 0);
  const acceptance = asked > 0 ? Number(G.granted || 0) / asked : null;
  await settle(pool, 'proxy_grants', asked >= 10 && acceptance !== null && acceptance < 0.5,
    SEV.warn, { acceptance, asked });

  // Per-room rules carry their own streak key so one quiet room does not
  // resolve another one's alert.
  const silentIds = new Set(silent.rows.map((r) => Number(r.id)));
  for (const row of silent.rows) {
    await settle(pool, 'silent_room', true, SEV.warn, { code: row.code }, Number(row.id));
  }
  const { rows: openSilent } = await pool.query(
    `SELECT room_id FROM alerts WHERE rule = 'silent_room' AND resolved_at IS NULL AND room_id IS NOT NULL`
  );
  for (const row of openSilent) {
    if (!silentIds.has(Number(row.room_id))) {
      await settle(pool, 'silent_room', false, SEV.warn, {}, Number(row.room_id));
    }
  }

  return readiness;
}

async function list(pool, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const { rows } = await pool.query(
    `SELECT a.id, a.rule, a.severity, a.opened_at, a.resolved_at, a.detail, r.code AS room_code
       FROM alerts a LEFT JOIN rooms r ON r.id = a.room_id
      ORDER BY (a.resolved_at IS NULL) DESC, a.opened_at DESC
      LIMIT $1`,
    [n]
  );
  return rows;
}

async function openCount(pool) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM alerts WHERE resolved_at IS NULL`);
  return Number(rows[0] ? rows[0].n : 0);
}

module.exports = { evaluate, list, openCount, openAlert, resolveAlert };
