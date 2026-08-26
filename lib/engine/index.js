// Translation engine registry — the adapter seam.
//
// Everything in the app that wants a caption asks the REGISTRY, never a
// specific engine. Today exactly one engine can run (`proxy-text`, the
// platform LLM proxy) and one is a declared-but-blocked stub
// (`realtime-audio`). Keeping the seam real is what makes the blocked one a
// single file to fill in rather than a rewrite.

const proxyText = require('./proxy-text');
const realtime = require('./realtime');

const ENGINES = [proxyText, realtime];
const BY_ID = Object.fromEntries(ENGINES.map((e) => [e.ENGINE_ID, e]));

// The engine a room runs on. Selection is NOT gated on USERNODE_ENV — staging
// and production take the identical code path; staging simply has no proxy
// credentials, so the same engine answers `unavailable` and the UI says so.
const DEFAULT_ENGINE_ID = proxyText.ENGINE_ID;

function getEngine(id) {
  return BY_ID[id] || BY_ID[DEFAULT_ENGINE_ID];
}

function activeEngineId() {
  return DEFAULT_ENGINE_ID;
}

// Shape rendered on /admin/metrics so the blocked capability is visible
// rather than folklore.
function engineStatus() {
  return ENGINES.map((e) => ({
    id: e.ENGINE_ID,
    label: e.label,
    available: !!e.available,
    active: e.ENGINE_ID === DEFAULT_ENGINE_ID,
    blockedReason: e.blockedReason || null,
    queueDepth: e.queueDepth ? e.queueDepth() : 0,
  }));
}

// Fan-out convenience: the active engine's queue. Every fan-out path in the
// app goes through this one function.
function enqueue(roomId, targetLang, job) {
  return getEngine(DEFAULT_ENGINE_ID).enqueue(roomId, targetLang, job);
}

function translate(args) {
  return getEngine(args && args.engineId).translate(args);
}

function forgetRoom(roomId) {
  for (const e of ENGINES) e.forgetRoom(roomId);
}

module.exports = {
  ENGINES,
  DEFAULT_ENGINE_ID,
  LLM_ENABLED: proxyText.LLM_ENABLED,
  getEngine,
  activeEngineId,
  engineStatus,
  translate,
  enqueue,
  forgetRoom,
};
