// Engine: `realtime-audio` — declared, wired, and deliberately NOT running.
//
// The Stage 2 brief asked for a realtime speech-to-speech translation API
// (audio in, translated audio out) behind a server-side media worker. That is
// not a thing this app is allowed to build today, and the reason is a platform
// rule rather than an effort estimate:
//
//   - Apps on this platform may not call third-party AI vendors directly and
//     may not ask users for API keys. The only sanctioned AI path is the
//     platform LLM proxy.
//   - The platform LLM proxy is Anthropic Messages — TEXT in, text out. There
//     is no audio channel through it.
//   - There is no media transport (no guaranteed WebSocket upgrade, no SFU,
//     no persistent volume) for a server-side media worker to sit on.
//
// So this file exists as the SEAM, not the implementation. It reports itself
// unavailable with `platform_capability_missing`, which is the same code the
// telephony bridge returns, and which the admin metrics screen surfaces. When
// the platform grows an audio-capable proxy, the work is to fill in this one
// file — every call site already goes through the registry.
//
// Do not start building this. Escalate with `usernode-report-platform-issue`.

const ENGINE_ID = 'realtime-audio';

const BLOCKED = {
  status: 'unavailable',
  text: null,
  latencyMs: null,
  ttftMs: null,
  code: 'platform_capability_missing',
};

async function translate() {
  return { ...BLOCKED };
}

// The registry's shape is uniform, so the stub answers the same calls.
function enqueue(roomId, targetLang, job) {
  return Promise.resolve().then(job).catch(() => ({ ...BLOCKED }));
}

function forgetRoom() { /* nothing is held */ }
function queueDepth() { return 0; }

module.exports = {
  ENGINE_ID,
  available: false,
  label: 'Realtime audio (blocked)',
  blockedReason: 'The platform LLM proxy is text-only and there is no media transport for a server-side audio worker.',
  translate,
  enqueue,
  forgetRoom,
  queueDepth,
};
