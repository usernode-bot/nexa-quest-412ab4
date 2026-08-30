// Service level objectives — one file, two readers.
//
// The metrics screen and the alert evaluator must never disagree about what
// "good" means, so the thresholds live here and both import them. Changing a
// number here changes the dashboard verdict and the alert that pages someone,
// together, which is the point.
//
// Why "first words on screen" and not "end to end":
//
// The original target was <500 ms end to end. That number is unreachable and
// was never really about the whole chain: browser speech recognition alone
// takes 700-1500 ms to decide a phrase is finished, and no amount of work in
// this repo moves it, because the recogniser is the operating system's. So the
// budget is split into three honest targets:
//
//   firstWord  ttft_p95 + deliver_p95 — how long after the server starts
//              translating do words appear on a listener's screen. This is the
//              part the app owns end to end, and 500 ms is the target.
//   total      capture + translate + deliver — the three-leg number a reader
//              actually experiences. 2500 ms.
//   heard      total + audio — the four-leg number a listener who is LISTENING
//              experiences. 3500 ms, and legitimately absent for someone
//              reading subtitles.

const TARGETS = {
  firstWord: { warnMs: 500, critMs: 900, label: 'First words on screen' },
  total: { warnMs: 2500, critMs: 4000, label: 'Caption on screen' },
  heard: { warnMs: 3500, critMs: 5500, label: 'Caption spoken' },
};

const RATES = {
  // Share of translations that came back error/unavailable.
  failRate: { warn: 0.02, crit: 0.08 },
  // Share of audio samples whose synthesiser never started.
  audioFallbackRate: { warn: 0.20, crit: 0.40 },
};

// Below this many samples a percentile is noise. A verdict computed on four
// rows is worse than no verdict, so it reports `insufficient` rather than
// `pass` — a green tick nobody earned is how a dashboard starts lying.
const MIN_SAMPLES = 50;

const RULES = ['latency_p95', 'first_word_p95', 'error_rate', 'audio_fallback_rate', 'silent_room', 'proxy_grants'];

// Two consecutive breaching evaluations before an alert opens, two clear ones
// before it resolves. A single 5-minute window with three slow captions in it
// is weather, not a problem.
const CONSECUTIVE_TO_OPEN = 2;
const CONSECUTIVE_TO_RESOLVE = 2;
const EVAL_INTERVAL_MS = 5 * 60 * 1000;

function verdictMs(value, target, n) {
  if (!Number.isFinite(Number(n)) || Number(n) < MIN_SAMPLES) return 'insufficient';
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 'insufficient';
  if (v > target.critMs) return 'crit';
  if (v > target.warnMs) return 'warn';
  return 'pass';
}

function verdictRate(value, rate, n) {
  if (!Number.isFinite(Number(n)) || Number(n) < MIN_SAMPLES) return 'insufficient';
  const v = Number(value);
  if (!Number.isFinite(v)) return 'insufficient';
  if (v > rate.crit) return 'crit';
  if (v > rate.warn) return 'warn';
  return 'pass';
}

const ORDER = { pass: 0, insufficient: 1, warn: 2, crit: 3 };
function worst(list) {
  let out = 'pass';
  for (const v of list) if (ORDER[v] > ORDER[out]) out = v;
  return out;
}

/**
 * Turn the numbers the metrics route already computes into a readiness verdict.
 *
 * `latency` is the row from lib/latency's PCTS aggregate, `ttftP95` the proxy
 * time-to-first-token percentile, `fail` the translation failure share.
 */
function evaluate({ latency, ttftP95, failRate, translationCount }) {
  const L = latency || {};
  const n = Number(L.n || 0);
  const audioN = Number(L.audio_n || 0);
  const fallbacks = Number(L.audio_fallbacks || 0);

  const deliverP95 = Number(L.deliver_p95 || 0);
  const firstWordMs = Number.isFinite(Number(ttftP95)) && Number(ttftP95) > 0
    ? Number(ttftP95) + deliverP95
    : null;
  const fallbackRate = audioN > 0 ? fallbacks / audioN : null;

  const checks = [
    {
      key: 'firstWord',
      label: TARGETS.firstWord.label,
      value: firstWordMs,
      unit: 'ms',
      target: TARGETS.firstWord.warnMs,
      n,
      verdict: verdictMs(firstWordMs, TARGETS.firstWord, n),
      note: 'Translation start to words rendered. Excludes the microphone.',
    },
    {
      key: 'total',
      label: TARGETS.total.label,
      value: Number(L.total_p95 || 0) || null,
      unit: 'ms',
      target: TARGETS.total.warnMs,
      n,
      verdict: verdictMs(L.total_p95, TARGETS.total, n),
      note: 'Microphone, translation and delivery together.',
    },
    {
      key: 'heard',
      label: TARGETS.heard.label,
      value: Number(L.heard_p95 || 0) || null,
      unit: 'ms',
      target: TARGETS.heard.warnMs,
      n: audioN,
      verdict: verdictMs(L.heard_p95, TARGETS.heard, audioN),
      note: 'Only rows that produced a voice. Readers have no audio leg.',
    },
    {
      key: 'failRate',
      label: 'Translation failures',
      value: Number.isFinite(Number(failRate)) ? Number(failRate) : null,
      unit: 'rate',
      target: RATES.failRate.warn,
      n: Number(translationCount || 0),
      verdict: verdictRate(failRate, RATES.failRate, translationCount),
      note: 'Share of captions that came back error or unavailable.',
    },
    {
      key: 'audioFallbackRate',
      label: 'Could not be spoken',
      value: fallbackRate,
      unit: 'rate',
      target: RATES.audioFallbackRate.warn,
      n: audioN,
      verdict: verdictRate(fallbackRate, RATES.audioFallbackRate, audioN),
      note: 'Sealed clauses whose synthesiser never started.',
    },
  ];

  return {
    minSamples: MIN_SAMPLES,
    verdict: worst(checks.map((c) => c.verdict)),
    checks,
    firstWordMs,
    audioFallbackRate: fallbackRate,
  };
}

module.exports = {
  TARGETS,
  RATES,
  MIN_SAMPLES,
  RULES,
  CONSECUTIVE_TO_OPEN,
  CONSECUTIVE_TO_RESOLVE,
  EVAL_INTERVAL_MS,
  evaluate,
  verdictMs,
  verdictRate,
  worst,
};
