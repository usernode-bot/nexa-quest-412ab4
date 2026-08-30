// Engine: `proxy-text` — the one that actually runs today.
//
// Recognised TEXT goes out through the PLATFORM LLM proxy and the translated
// text comes back; no audio ever crosses the network in either direction.
// This app never calls Anthropic (or anyone else) directly and never asks a
// user for an API key — the proxy bills the signed-in user's own AI budget
// under a consent grant they gave this app. The proxy is absent in staging and
// in standalone deploys, which is a supported state, not an error: the caption
// falls back to `status: 'unavailable'` and the UI says so.
//
// The request is STREAMED (SSE). That is what delivers the "transcript delta"
// half of the product: a partial caption is emitted at the first sentence
// boundary (or 60 characters, whichever lands first) so a listener starts
// reading while the model is still writing, and `ttft_ms` becomes a number we
// can actually put on a dashboard.

const { LANG_BY_CODE, PRESERVE_TERMS } = require('../config');

const ENGINE_ID = 'proxy-text';
const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN && !!process.env.USERNODE_LLM_PROXY_URL;

// Rolling conversation context — a translation SESSION, keyed
// `roomId:speakerUserId:src>tgt`. Six turns is enough for pronouns and
// follow-ups ("upgrade it" -> what is "it") without making every request
// expensive.
//
// Keying on the SPEAKER is the point. A shared per-room history mixed
// everyone's sentences into one transcript, so in a three-way call the model
// resolved "it" against whatever the previous person happened to say. One
// session per speaker keeps each person's thread of reference intact, and it
// is also what makes a language change cheap to handle: the speaker's own
// sessions are dropped and nobody else's context is disturbed.
const CONTEXT_TURNS = 6;
// A `large` room fans one speaker out to a listening audience, so its prompts
// are the ones most worth keeping short: fewer carried turns is fewer input
// tokens on every call in the room, and a townhall has far less back-and-forth
// reference to preserve than a two-person support call does.
const CONTEXT_TURNS_LARGE = 4;
// A session nobody has spoken into for this long is not context any more, it
// is a leak. Swept from the app's hourly housekeeping pass.
const SESSION_IDLE_MS = 10 * 60 * 1000;
const contexts = new Map();

// One serial queue per (room, target language) so captions for a listener
// arrive in the order they were spoken.
const queues = new Map();
const MAX_INFLIGHT_PER_ROOM = 4;
// A process-wide ceiling as well: one busy room must not starve every other
// room's captions of proxy concurrency.
const MAX_INFLIGHT_GLOBAL = 24;
const inflight = new Map();
let globalInflight = 0;

// A partial caption is worth writing once there is something readable to
// read. Anything shorter is a flicker, not a caption.
const PARTIAL_MIN_CHARS = 60;
// Except for the FIRST one. "Words are appearing" is the signal a listener is
// actually waiting for, and 60 characters of Indonesian is most of a sentence
// — long enough that the screen stayed blank through the part of the wait that
// felt longest. The first emission goes out at 24 characters or at the first
// clause boundary, whichever lands first; every emission after it is back to
// the 60-character rhythm so the caption does not strobe.
const FIRST_PARTIAL_MIN_CHARS = 24;
const SENTENCE_END = /[.!?。！？…]\s*$/;
// A clause boundary is enough to show a first partial on, though not enough to
// SEAL one — sealing is `lib/segment.js`'s decision and stays stricter.
const CLAUSE_BREAK = /[,;:、，;：]\s/;

// Two deadlines on the proxy call. The catch below has always mapped
// `AbortError` onto `code: 'timeout'`, but nothing ever fired one, so a proxy
// that accepted the connection and then went quiet held a fan-out slot until
// the platform's own socket timeout — with the room's serial queue stalled
// behind it. The hard deadline bounds the whole call; the first-token deadline
// bounds the part a listener experiences as silence.
const TRANSLATE_TIMEOUT_MS = 12000;
const TTFT_DEADLINE_MS = 4000;

function ctxKey(roomId, speakerUserId, src, tgt) {
  return `${roomId}:${speakerUserId == null ? 'anon' : speakerUserId}:${src}>${tgt}`;
}

function session(key) {
  let s = contexts.get(key);
  if (!s) { s = { turns: [], touchedAt: Date.now() }; contexts.set(key, s); }
  s.touchedAt = Date.now();
  return s;
}

function pushContext(roomId, speakerUserId, src, tgt, sourceText, translatedText, tier) {
  const s = session(ctxKey(roomId, speakerUserId, src, tgt));
  s.turns.push({ sourceText, translatedText });
  const keep = tier === 'large' ? CONTEXT_TURNS_LARGE : CONTEXT_TURNS;
  while (s.turns.length > keep) s.turns.shift();
}

// A speaker who switches the language they speak has started a new thread of
// reference. Carrying the old one over produces captions that answer the
// wrong sentence, so drop every session that speaker owns in this room.
function resetSpeaker(roomId, speakerUserId) {
  const prefix = `${roomId}:${speakerUserId}:`;
  for (const key of contexts.keys()) {
    if (key.startsWith(prefix)) contexts.delete(key);
  }
}

function sweepSessions(idleMs) {
  const cutoff = Date.now() - (idleMs || SESSION_IDLE_MS);
  let dropped = 0;
  for (const [key, s] of contexts) {
    if (s.touchedAt < cutoff) { contexts.delete(key); dropped += 1; }
  }
  return dropped;
}

function sessionCount() { return contexts.size; }

// Queues and in-flight counters for rooms with no session left. `forgetRoom`
// covers the rooms the app knows have ended; this covers the ones that simply
// stopped, which over a long-lived container is most of them.
function sweepQueues() {
  const live = new Set();
  for (const key of contexts.keys()) live.add(key.slice(0, key.indexOf(':')));
  let swept = 0;
  for (const key of queues.keys()) {
    const roomKey = key.slice(0, key.indexOf(':'));
    if (!live.has(roomKey)) { queues.delete(key); swept += 1; }
  }
  for (const [roomKey, n] of inflight) {
    if (!live.has(roomKey) && n <= 0) inflight.delete(roomKey);
  }
  return swept;
}

function forgetRoom(roomId) {
  for (const key of contexts.keys()) {
    if (key.startsWith(`${roomId}:`)) contexts.delete(key);
  }
  for (const key of queues.keys()) {
    if (key.startsWith(`${roomId}:`)) queues.delete(key);
  }
  inflight.delete(String(roomId));
}

// Kept byte-stable so the proxy/provider can cache it across every call.
function systemPrompt(srcLabel, tgtLabel) {
  return [
    'You are the live translation channel inside a UserNode Labs voice call.',
    `Translate the speaker's ${srcLabel} into ${tgtLabel}.`,
    '',
    'Rules:',
    '- Output ONLY the translation. No preamble, no quotes, no notes, no alternatives.',
    '- This is speech: keep it natural and spoken, not literary. Keep it about as long as the original.',
    '- Preserve these protocol terms exactly as written, never translate or inflect them: '
      + PRESERVE_TERMS.join(', ') + '.',
    '- Keep numbers, version strings, addresses and command names byte-for-byte identical.',
    '- Speech-to-text makes mistakes. If a word is garbled, translate the most plausible intended meaning rather than the noise.',
    '- If the text is already in the target language, return it unchanged.',
  ].join('\n');
}

function readMeter(resp) {
  const spentCents = Number(resp.headers.get('x-usernode-llm-spent-cents'));
  const capCents = Number(resp.headers.get('x-usernode-llm-cap-cents'));
  return Number.isFinite(spentCents) && Number.isFinite(capCents)
    ? { spentCents, capCents }
    : null;
}

// grant_required / app_cap_exceeded / budget_exceeded are all states the room
// UI explains to the user rather than errors worth retrying.
function isSoft(code) {
  return code === 'grant_required' || code === 'app_cap_exceeded' || code === 'budget_exceeded';
}

/**
 * Consume the proxy's SSE body, calling `onDelta(fullTextSoFar)` as text
 * accumulates. Resolves the finished text.
 */
async function consumeStream(resp, onDelta) {
  const reader = resp.body && typeof resp.body.getReader === 'function'
    ? resp.body.getReader()
    : null;
  if (!reader) throw new Error('no_stream_body');

  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  let apiError = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; keep the tail for next read.
    let cut = buffered.indexOf('\n\n');
    while (cut !== -1) {
      const frame = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
          text += evt.delta.text;
          onDelta(text);
        } else if (evt.type === 'error') {
          apiError = (evt.error && (evt.error.code || evt.error.type)) || 'stream_error';
        }
      }
      cut = buffered.indexOf('\n\n');
    }
  }

  if (apiError) {
    const err = new Error(apiError);
    err.code = apiError;
    throw err;
  }
  return text.trim();
}

/**
 * Translate one utterance.
 *
 * Resolves `{ status, text, latencyMs, ttftMs, code?, meter? }` and NEVER
 * throws — a caption that failed is a caption that says it failed, not a 500
 * landing on the speaker who is still talking.
 *
 * `onPartial(text)` is invoked zero or more times with a provisional caption
 * before the final one resolves. It must not throw and its result is ignored.
 */
async function translate({ roomId, speakerUserId, sourceLang, targetLang, sourceText, userToken, onPartial, tier }) {
  if (!LLM_ENABLED) {
    return { status: 'unavailable', text: null, latencyMs: null, ttftMs: null, code: 'llm_disabled' };
  }
  if (sourceLang === targetLang) {
    return { status: 'ok', text: sourceText, latencyMs: 0, ttftMs: 0 };
  }

  const src = LANG_BY_CODE[sourceLang];
  const tgt = LANG_BY_CODE[targetLang];
  if (!src || !tgt) {
    return { status: 'error', text: null, latencyMs: null, ttftMs: null, code: 'unsupported_language' };
  }

  const history = session(ctxKey(roomId, speakerUserId, sourceLang, targetLang)).turns;
  const messages = [];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.sourceText });
    messages.push({ role: 'assistant', content: turn.translatedText });
  }
  messages.push({ role: 'user', content: sourceText });

  const started = Date.now();
  let ttftMs = null;

  // One controller, two timers. The first-token timer is cleared the moment a
  // token arrives; the hard timer runs for the life of the call. Both are
  // cleared in the `finally` so a fast call leaves nothing behind.
  const controller = new AbortController();
  let hardTimer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  let ttftTimer = setTimeout(() => controller.abort(), TTFT_DEADLINE_MS);
  const clearTtft = () => { if (ttftTimer) { clearTimeout(ttftTimer); ttftTimer = null; } };

  try {
    const resp = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-usernode-app-token': process.env.USERNODE_LLM_PROXY_TOKEN,
        'x-usernode-user-token': userToken || '',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 512,
        // Captions are a latency-first workload — thinking would ruin them.
        output_config: { effort: 'low' },
        stream: true,
        system: systemPrompt(src.english, tgt.english),
        messages,
      }),
    });

    const meter = readMeter(resp);

    if (!resp.ok) {
      let code = `http_${resp.status}`;
      try {
        const body = await resp.json();
        if (body && body.code) code = body.code;
      } catch { /* non-JSON error body */ }
      return {
        status: isSoft(code) ? 'unavailable' : 'error',
        text: null, latencyMs: Date.now() - started, ttftMs: null, code, meter,
      };
    }

    const contentType = String(resp.headers.get('content-type') || '');
    let text;

    if (contentType.includes('text/event-stream')) {
      let lastEmitted = '';
      let emitted = 0;
      text = await consumeStream(resp, (soFar) => {
        if (ttftMs == null) { ttftMs = Date.now() - started; clearTtft(); }
        if (typeof onPartial !== 'function') return;
        // Emit at a sentence boundary, or once enough has accumulated since
        // the last emission to be worth re-rendering. The first emission is
        // held to a lower bar for the reason above.
        const grown = soFar.length - lastEmitted.length;
        const floor = emitted === 0 ? FIRST_PARTIAL_MIN_CHARS : PARTIAL_MIN_CHARS;
        const boundary = (SENTENCE_END.test(soFar) || (emitted === 0 && CLAUSE_BREAK.test(soFar)))
          && grown > 0;
        if (!boundary && grown < floor) return;
        lastEmitted = soFar;
        emitted += 1;
        try { onPartial(soFar.trim()); } catch { /* a partial is best-effort */ }
      });
    } else {
      // A proxy that answered without streaming is still a working proxy.
      const body = await resp.json();
      text = (body.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      ttftMs = Date.now() - started;
      clearTtft();
    }

    const latencyMs = Date.now() - started;
    if (!text) return { status: 'error', text: null, latencyMs, ttftMs, code: 'empty_response', meter };

    pushContext(roomId, speakerUserId, sourceLang, targetLang, sourceText, text, tier);
    return { status: 'ok', text, latencyMs, ttftMs, meter };
  } catch (err) {
    const code = err && err.code ? err.code
      : (err && err.name === 'AbortError' ? 'timeout' : 'network_error');
    return {
      status: isSoft(code) ? 'unavailable' : 'error',
      text: null,
      latencyMs: Date.now() - started,
      ttftMs,
      code,
    };
  } finally {
    clearTimeout(hardTimer);
    hardTimer = null;
    clearTtft();
  }
}

/**
 * Enqueue work on the serial queue for one (room, target language) pair.
 * Returns a promise that settles when THIS job has run.
 *
 * Every fan-out path in the app goes through here — that is what keeps a room
 * that is producing captions faster than the proxy drains them from growing an
 * unbounded queue instead of shedding.
 */
function enqueue(roomId, targetLang, job) {
  const roomKey = String(roomId);
  const n = inflight.get(roomKey) || 0;
  if (n >= MAX_INFLIGHT_PER_ROOM * 4 || globalInflight >= MAX_INFLIGHT_GLOBAL * 4) {
    return Promise.resolve({
      status: 'error', code: 'overloaded', text: null, latencyMs: null, ttftMs: null,
    });
  }
  inflight.set(roomKey, n + 1);
  globalInflight += 1;

  const key = `${roomId}:${targetLang}`;
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    inflight.set(roomKey, Math.max(0, (inflight.get(roomKey) || 1) - 1));
    globalInflight = Math.max(0, globalInflight - 1);
  });
  // Keep the chain alive even if a job rejects.
  queues.set(key, next.catch(() => {}));
  return next;
}

function queueDepth() {
  let depth = 0;
  for (const n of inflight.values()) depth += n;
  return depth;
}

module.exports = {
  ENGINE_ID,
  LLM_ENABLED,
  available: LLM_ENABLED,
  label: 'Platform text proxy',
  translate,
  enqueue,
  forgetRoom,
  resetSpeaker,
  sweepSessions,
  sessionCount,
  sweepQueues,
  queueDepth,
  MAX_INFLIGHT_GLOBAL,
  TRANSLATE_TIMEOUT_MS,
  TTFT_DEADLINE_MS,
};
