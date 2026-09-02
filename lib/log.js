// Structured logging — one JSON object per line on stdout.
//
// The platform captures container stdout and nothing else, so a log line is
// the only durable record of what the server did. Free-form
// `console.log('[translate] room=...')` strings were readable by a human
// tailing a terminal and useless to anything that wanted to count them, so
// every site now emits the same shape:
//
//   {"ts":"...","level":"info","event":"translate","reqId":"a1b2c3d4",
//    "roomId":42,"tier":"direct","code":"ok","ms":812,"msg":"..."}
//
// `event` is the stable key to group by. Everything else is optional and only
// present when it means something. Never put caption text, utterance text or
// any user-authored string in a log line: stdout is not a private table.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[String(process.env.LT_LOG_LEVEL || '').toLowerCase()]
  || (process.env.USERNODE_ENV === 'staging' ? LEVELS.debug : LEVELS.info);

// Anything longer than this is a paste, not a log line.
const MAX_MSG = 300;

function trim(v) {
  if (v == null) return undefined;
  const s = String(v);
  return s.length > MAX_MSG ? `${s.slice(0, MAX_MSG)}…` : s;
}

function emit(level, event, fields) {
  if (LEVELS[level] < MIN) return;
  const line = { ts: new Date().toISOString(), level, event: String(event || 'log') };
  const f = fields || {};
  for (const key of Object.keys(f)) {
    const v = f[key];
    if (v === undefined || v === null) continue;
    line[key] = key === 'msg' || key === 'detail' ? trim(v) : v;
  }
  const out = JSON.stringify(line);
  // stderr for error so a platform that separates the streams still sees it.
  if (level === 'error') process.stderr.write(`${out}\n`);
  else process.stdout.write(`${out}\n`);
}

function make(bound) {
  const base = bound || {};
  const merge = (fields) => (fields ? { ...base, ...fields } : base);
  return {
    debug: (event, fields) => emit('debug', event, merge(fields)),
    info: (event, fields) => emit('info', event, merge(fields)),
    warn: (event, fields) => emit('warn', event, merge(fields)),
    error: (event, fields) => emit('error', event, merge(fields)),
    child: (fields) => make(merge(fields)),
  };
}

module.exports = make(null);
module.exports.LEVELS = LEVELS;
