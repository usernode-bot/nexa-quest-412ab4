// Translation fan-out through the PLATFORM LLM proxy.
//
// This app never calls Anthropic (or anyone else) directly and never asks a
// user for an API key — the proxy bills the signed-in user's own AI budget
// under a consent grant they gave this app. The proxy is absent in staging
// and in standalone deploys, which is a supported state, not an error: the
// caption falls back to `status: 'unavailable'` and the UI says so.

const { LANG_BY_CODE, PRESERVE_TERMS } = require('./config');

const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN && !!process.env.USERNODE_LLM_PROXY_URL;

// Rolling conversation context, keyed `roomId:src>tgt`. Six turns is enough
// for pronouns and follow-ups ("upgrade it" -> what is "it") without making
// every request expensive.
const CONTEXT_TURNS = 6;
const contexts = new Map();

// One serial queue per (room, target language) so captions for a listener
// arrive in the order they were spoken, with a cap on concurrent rooms'
// worth of in-flight work.
const queues = new Map();
const MAX_INFLIGHT_PER_ROOM = 4;
const inflight = new Map();

function ctxKey(roomId, src, tgt) { return `${roomId}:${src}>${tgt}`; }

function pushContext(roomId, src, tgt, sourceText, translatedText) {
  const key = ctxKey(roomId, src, tgt);
  const list = contexts.get(key) || [];
  list.push({ sourceText, translatedText });
  while (list.length > CONTEXT_TURNS) list.shift();
  contexts.set(key, list);
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

/**
 * Translate one utterance. Resolves
 * `{ status, text, latencyMs, code? }` and never throws — a caption that
 * failed is a caption that says it failed, not a 500 on the speaker.
 */
async function translate({ roomId, sourceLang, targetLang, sourceText, userToken }) {
  if (!LLM_ENABLED) {
    return { status: 'unavailable', text: null, latencyMs: null, code: 'llm_disabled' };
  }
  if (sourceLang === targetLang) {
    return { status: 'ok', text: sourceText, latencyMs: 0 };
  }

  const src = LANG_BY_CODE[sourceLang];
  const tgt = LANG_BY_CODE[targetLang];
  if (!src || !tgt) {
    return { status: 'error', text: null, latencyMs: null, code: 'unsupported_language' };
  }

  const history = contexts.get(ctxKey(roomId, sourceLang, targetLang)) || [];
  const messages = [];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.sourceText });
    messages.push({ role: 'assistant', content: turn.translatedText });
  }
  messages.push({ role: 'user', content: sourceText });

  const started = Date.now();
  try {
    const resp = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
      method: 'POST',
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
        stream: false,
        system: systemPrompt(src.english, tgt.english),
        messages,
      }),
    });

    const latencyMs = Date.now() - started;
    const spentCents = Number(resp.headers.get('x-usernode-llm-spent-cents'));
    const capCents = Number(resp.headers.get('x-usernode-llm-cap-cents'));
    const meter = Number.isFinite(spentCents) && Number.isFinite(capCents)
      ? { spentCents, capCents } : null;

    if (!resp.ok) {
      let code = `http_${resp.status}`;
      try {
        const body = await resp.json();
        if (body && body.code) code = body.code;
      } catch { /* non-JSON error body */ }
      // grant_required / app_cap_exceeded / budget_exceeded are all states
      // the room UI explains to the user rather than errors to retry.
      const soft = code === 'grant_required' || code === 'app_cap_exceeded' || code === 'budget_exceeded';
      return { status: soft ? 'unavailable' : 'error', text: null, latencyMs, code, meter };
    }

    const body = await resp.json();
    const text = (body.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) return { status: 'error', text: null, latencyMs, code: 'empty_response', meter };

    pushContext(roomId, sourceLang, targetLang, sourceText, text);
    return { status: 'ok', text, latencyMs, meter };
  } catch (err) {
    return {
      status: 'error',
      text: null,
      latencyMs: Date.now() - started,
      code: err && err.name === 'AbortError' ? 'timeout' : 'network_error',
    };
  }
}

/**
 * Enqueue work on the serial queue for one (room, target language) pair.
 * Returns a promise that settles when THIS job has run.
 */
function enqueue(roomId, targetLang, job) {
  const roomKey = String(roomId);
  const n = inflight.get(roomKey) || 0;
  if (n >= MAX_INFLIGHT_PER_ROOM * 4) {
    // Backstop: a room generating work faster than the proxy drains it
    // sheds rather than growing an unbounded queue.
    return Promise.resolve({ status: 'error', code: 'overloaded', text: null, latencyMs: null });
  }
  inflight.set(roomKey, n + 1);

  const key = `${roomId}:${targetLang}`;
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    inflight.set(roomKey, Math.max(0, (inflight.get(roomKey) || 1) - 1));
  });
  // Keep the chain alive even if a job rejects.
  queues.set(key, next.catch(() => {}));
  return next;
}

module.exports = { LLM_ENABLED, translate, enqueue, forgetRoom };
