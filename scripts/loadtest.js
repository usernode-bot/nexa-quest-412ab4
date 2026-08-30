#!/usr/bin/env node
//
// LIVE TRANSLATION load test — 10 to 50 concurrent readers against one room.
//
// What this measures, and what it deliberately does not:
//
//   It measures TRANSPORT and FAN-OUT. One speaker posts captions at a fixed
//   rate; N listeners hold `/stream?wait=1` open and record how long each
//   caption took to reach them. That covers the two legs this repo actually
//   owns end to end: the server writing a translation row, and a listener's
//   poll picking it up.
//
//   It does NOT measure model latency. A staging container receives no LLM
//   proxy credentials at all, so every translation comes back `unavailable`
//   with code `llm_disabled` and the translate leg is ~0 ms. A green run here
//   says the delivery path holds up under load. It says nothing about how
//   fast Claude is. Read the `/admin/metrics` readiness panel for that.
//
// Zero dependencies, Node 22 (global fetch). Run it from the repo root so it
// can read the thresholds out of lib/slo.js:
//
//   npm run loadtest -- --base https://<staging-host> --token <iframe-jwt> \
//     --listeners 25 --speaker-rate 12 --duration 120
//
// Exits non-zero when a measured percentile breaches a `crit` threshold in
// lib/slo.js, so it can gate a pilot go/no-go without a human squinting at it.

'use strict';

const fs = require('fs');
const path = require('path');

const SLO = require(path.join(__dirname, '..', 'lib', 'slo.js'));
const CONFIG = require(path.join(__dirname, '..', 'lib', 'config.js'));

const { LIMITS } = CONFIG;

// --- arguments -------------------------------------------------------------

const USAGE = `
Usage: node scripts/loadtest.js --base <host> --token <t> [options]

  --base <url>           Base URL of the app under test. Required.
  --token <jwt>          A platform iframe token for the speaker. Required
                         unless --tokens is given.
  --tokens <file>        File with one iframe token per line. The first is the
                         speaker; the rest join as real participants. Use this
                         for a genuine multi-participant test.
  --room <CODE>          Join an existing room instead of creating one.
  --purpose <key>        Room purpose when creating (${CONFIG.PURPOSE_KEYS.join(', ')}).
  --tier <key>           Scale tier when creating (${CONFIG.TIER_KEYS.join(', ')}).
  --listeners <n>        Concurrent reader loops. Default 25.
  --speaker-rate <n>     Captions per minute. Default 12.
  --duration <s>         Seconds to run. Default 120.
  --no-wait              Force plain interval polling instead of long polling.
  --json                 Print the report as JSON instead of a table.
  --help                 This text.
`.trim();

function parseArgs(argv) {
  const out = {
    base: null,
    token: null,
    tokens: null,
    room: null,
    purpose: 'support',
    tier: null,
    listeners: 25,
    speakerRate: 12,
    duration: 120,
    wait: true,
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a === '--base') out.base = next();
    else if (a === '--token') out.token = next();
    else if (a === '--tokens') out.tokens = next();
    else if (a === '--room') out.room = String(next() || '').toUpperCase();
    else if (a === '--purpose') out.purpose = next();
    else if (a === '--tier') out.tier = next();
    else if (a === '--listeners') out.listeners = parseInt(next(), 10);
    else if (a === '--speaker-rate') out.speakerRate = Number(next());
    else if (a === '--duration') out.duration = Number(next());
    else if (a === '--no-wait') out.wait = false;
    else if (a === '--json') out.json = true;
    else { console.error(`unknown option: ${a}\n\n${USAGE}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv);

let tokens = [];
if (args.tokens) {
  tokens = fs.readFileSync(args.tokens, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}
if (args.token) tokens.unshift(args.token);
if (!args.base || !tokens.length) {
  console.error(`${USAGE}\n\nMissing --base or --token.`);
  process.exit(2);
}
const BASE = args.base.replace(/\/+$/, '');

// --- the constraints this test is shaped by --------------------------------
//
// Printed rather than commented, because every one of them is a way a run can
// be quietly meaningless, and the person reading the output is the one who
// needs to know.

function printConstraints() {
  const lines = [
    `room_participants is UNIQUE (room_id, user_id), so one token is one`,
    `  participant. With ${tokens.length} token(s) the default shape is 1 member speaking`,
    `  and ${args.listeners} non-member readers on the read-only stream. Pass --tokens`,
    `  <file> for a genuine multi-participant test.`,
    `Rate limits in force: ${LIMITS.UTTERANCES_PER_MIN_PER_ROOM} utterances/min/room,`,
    `  ${LIMITS.ROOMS_PER_HOUR_PER_USER} rooms/hour/user, 30 latency posts/min/user,`,
    `  20 joins/min/user. A 429 is counted, never retried.`,
    `Spend is capped at MAX_TARGET_LANGS=${LIMITS.MAX_TARGET_LANGS} distinct target languages, and`,
    `  MAX_PARTICIPANTS=${LIMITS.MAX_PARTICIPANTS} bounds a single room.`,
    `The large tier never long-polls, by design. Point this at a direct or`,
    `  group room if you want to exercise the held path.`,
    `Staging has no LLM proxy: every translation resolves to unavailable`,
    `  (llm_disabled). This run measures transport and fan-out, not model latency.`,
  ];
  for (const l of lines) console.log(`  ${l}`);
}

// --- tiny http helper ------------------------------------------------------

async function call(method, url, token, body) {
  const started = Date.now();
  const headers = { 'x-usernode-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, code: 'network', data: null, detail: err.message };
  }
  let data = null;
  try { data = await res.json(); } catch { /* a body we cannot read is still a status */ }
  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - started,
    code: res.ok ? null : ((data && data.error) || `http_${res.status}`),
    data,
  };
}

// --- statistics ------------------------------------------------------------

function pct(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return Math.round(s[i]);
}

const stats = {
  posted: 0,
  postFailures: new Map(),
  polls: 0,
  pollFailures: new Map(),
  held: 0,
  throttled: 0,
  // Wall time from "the speaker's POST returned" to "a listener first saw any
  // translation event for it". Measured on one clock, this process's.
  firstWordMs: [],
  // Same, but to the first FINAL (or unavailable) row: the caption is done.
  finalMs: [],
  // What the server itself said the caption's age was when it assembled the
  // response. The delivery leg with this process's own scheduling removed.
  ageMs: [],
  pollMs: [],
};

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

// --- the run ---------------------------------------------------------------

const postedAt = new Map();   // utteranceId -> ms timestamp
const sawFirst = new Set();   // utteranceId
const sawFinal = new Set();   // utteranceId

let stop = false;
// Deliberately NOT unref'd. Between a post and the next one every loop is
// sitting in here, and an unref'd timer does not hold the event loop open, so
// the process would exit 0 in the middle of the run and print no report at all.
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function speakerLoop(token, code, endsAt) {
  const gapMs = Math.max(200, Math.round(60000 / Math.max(1, args.speakerRate)));
  let n = 0;
  while (!stop && Date.now() < endsAt) {
    n += 1;
    const r = await call('POST', `/api/rooms/${code}/utterances`, token, {
      text: `Load test caption ${n}. The validator node needs a restart before the next epoch.`,
      via: 'typed',
    });
    if (r.ok && r.data && r.data.utterance) {
      stats.posted += 1;
      postedAt.set(Number(r.data.utterance.id), Date.now());
    } else {
      bump(stats.postFailures, r.code || 'unknown');
      if (r.status === 429) stats.throttled += 1;
    }
    await sleep(gapMs);
  }
}

async function listenerLoop(token, code, endsAt) {
  let since = 0;
  while (!stop && Date.now() < endsAt) {
    const q = `since=${since}${args.wait ? '&wait=1' : ''}`;
    const r = await call('GET', `/api/rooms/${code}/stream?${q}`, token);
    stats.polls += 1;
    stats.pollMs.push(r.ms);
    if (!r.ok) {
      bump(stats.pollFailures, r.code || 'unknown');
      if (r.status === 429) stats.throttled += 1;
      await sleep(1000);
      continue;
    }
    const data = r.data || {};
    if (data.held) stats.held += 1;
    if (Number.isFinite(Number(data.seq))) since = Math.max(since, Number(data.seq));
    const now = Date.now();
    for (const ev of (data.events || [])) {
      if (!String(ev.type || '').startsWith('translation.')) continue;
      const id = Number(ev.utteranceId);
      const at = postedAt.get(id);
      if (!at) continue;
      if (Number.isFinite(Number(ev.ageMs))) stats.ageMs.push(Number(ev.ageMs));
      if (!sawFirst.has(id)) { sawFirst.add(id); stats.firstWordMs.push(now - at); }
      const done = ev.type === 'translation.final'
        || ev.type === 'translation.unavailable'
        || ev.type === 'translation.error';
      if (done && !sawFinal.has(id)) { sawFinal.add(id); stats.finalMs.push(now - at); }
    }
    // A held request that came back empty earns one plain tick, exactly like
    // the browser client does, so a quiet room is not sitting on a socket.
    if (!args.wait || !data.held) await sleep(250);
  }
}

async function ensureRoom(token) {
  if (args.room) {
    const j = await call('POST', `/api/rooms/${args.room}/join`, token, { speaksLang: 'en', hearsLang: 'id' });
    if (!j.ok) throw new Error(`could not join ${args.room}: ${j.code}`);
    return args.room;
  }
  const body = { title: 'Load test', purpose: args.purpose, speaksLang: 'en', hearsLang: 'id' };
  if (args.tier) body.scaleTier = args.tier;
  const r = await call('POST', '/api/rooms', token, body);
  if (!r.ok || !r.data || !r.data.room) throw new Error(`could not create a room: ${r.code}`);
  return r.data.room.code;
}

// --- reporting -------------------------------------------------------------

function verdictFor(name, value, target, n) {
  const v = SLO.verdictMs(value, target, n);
  return { name, value, warn: target.warnMs, crit: target.critMs, n, verdict: v };
}

function buildReport(code, ranS) {
  const heldRatio = stats.polls ? stats.held / stats.polls : 0;
  const pollTotal = stats.polls;
  const pollErrors = [...stats.pollFailures.values()].reduce((a, b) => a + b, 0);
  const errorRate = pollTotal ? pollErrors / pollTotal : 0;

  // Only the two legs this test can actually see get a verdict. `total` and
  // `heard` need a microphone and a synthesiser, neither of which exists in a
  // load generator, and inventing a number for them would be worse than a gap.
  const checks = [
    verdictFor('First words on screen', pct(stats.firstWordMs, 0.95), SLO.TARGETS.firstWord, stats.firstWordMs.length),
    verdictFor('Caption complete', pct(stats.finalMs, 0.95), SLO.TARGETS.total, stats.finalMs.length),
  ];
  const transportVerdict = SLO.verdictRate(errorRate, SLO.RATES.failRate, pollTotal);
  checks.push({
    name: 'Poll error rate',
    value: errorRate,
    warn: SLO.RATES.failRate.warn,
    crit: SLO.RATES.failRate.crit,
    n: pollTotal,
    verdict: transportVerdict,
    rate: true,
  });

  return {
    room: code,
    durationS: Math.round(ranS),
    listeners: args.listeners,
    speakerRatePerMin: args.speakerRate,
    longPollRequested: args.wait,
    posted: stats.posted,
    delivered: sawFinal.size,
    polls: stats.polls,
    heldRatio: Number(heldRatio.toFixed(3)),
    throttled: stats.throttled,
    legs: {
      firstWord: { n: stats.firstWordMs.length, p50: pct(stats.firstWordMs, 0.5), p95: pct(stats.firstWordMs, 0.95) },
      final: { n: stats.finalMs.length, p50: pct(stats.finalMs, 0.5), p95: pct(stats.finalMs, 0.95) },
      serverAge: { n: stats.ageMs.length, p50: pct(stats.ageMs, 0.5), p95: pct(stats.ageMs, 0.95) },
      pollRoundTrip: { n: stats.pollMs.length, p50: pct(stats.pollMs, 0.5), p95: pct(stats.pollMs, 0.95) },
    },
    postFailures: Object.fromEntries(stats.postFailures),
    pollFailures: Object.fromEntries(stats.pollFailures),
    checks,
    verdict: SLO.worst(checks.map((c) => c.verdict)),
  };
}

const MARK = { pass: 'PASS', warn: 'WARN', crit: 'FAIL', insufficient: 'n/a ' };

function printReport(rep) {
  const line = (k, v) => console.log(`  ${String(k).padEnd(24)} ${v}`);
  console.log('\n--- result -----------------------------------------------------');
  line('room', rep.room);
  line('ran for', `${rep.durationS}s with ${rep.listeners} listeners`);
  line('captions posted', rep.posted);
  line('captions delivered', rep.delivered);
  line('polls', `${rep.polls} (${Math.round(rep.heldRatio * 100)}% held)`);
  line('throttled (429)', rep.throttled);
  console.log('');
  for (const [name, leg] of Object.entries(rep.legs)) {
    line(name, leg.n ? `n=${leg.n}  p50 ${leg.p50}ms  p95 ${leg.p95}ms` : 'no samples');
  }
  if (Object.keys(rep.postFailures).length) {
    console.log('');
    for (const [k, v] of Object.entries(rep.postFailures)) line(`post error ${k}`, v);
  }
  if (Object.keys(rep.pollFailures).length) {
    for (const [k, v] of Object.entries(rep.pollFailures)) line(`poll error ${k}`, v);
  }
  console.log('\n--- against lib/slo.js -----------------------------------------');
  for (const c of rep.checks) {
    const shown = c.value == null ? '-'
      : (c.rate ? `${(c.value * 100).toFixed(1)}%` : `${c.value}ms`);
    const target = c.rate ? `${(c.warn * 100).toFixed(0)}%` : `${c.warn}ms`;
    console.log(`  ${MARK[c.verdict]}  ${c.name.padEnd(24)} ${String(shown).padStart(8)}  target ${target}  n=${c.n}`);
  }
  console.log(`\n  overall: ${MARK[rep.verdict]}`);
  console.log('\n  Transport and fan-out only. Staging runs with no LLM proxy, so the');
  console.log('  translate leg is absent from these numbers by construction.\n');
}

// --- main ------------------------------------------------------------------

async function main() {
  console.log('\nLIVE TRANSLATION load test');
  console.log(`  target: ${BASE}\n`);
  printConstraints();

  if (args.speakerRate > LIMITS.UTTERANCES_PER_MIN_PER_ROOM) {
    console.log(`\n  NOTE: --speaker-rate ${args.speakerRate} is above the room limit of `
      + `${LIMITS.UTTERANCES_PER_MIN_PER_ROOM}/min. Expect 429s.`);
  }

  const speaker = tokens[0];
  const code = await ensureRoom(speaker);
  console.log(`\n  room ${code}, starting ${args.listeners} listeners for ${args.duration}s\n`);

  const startedAt = Date.now();
  const endsAt = startedAt + args.duration * 1000;

  const loops = [speakerLoop(speaker, code, endsAt)];
  for (let i = 0; i < args.listeners; i += 1) {
    // Extra tokens become real participants; beyond them, listeners reuse the
    // speaker's token as non-members on the read-only stream. That is not a
    // shortcut, it is the only shape one identity can take (see the note above).
    const token = tokens[(i + 1) % tokens.length];
    loops.push(listenerLoop(token, code, endsAt));
    // Stagger the starts. Fifty simultaneous first polls is a thundering herd
    // this app will never see in the wild and tells us nothing useful.
    await sleep(Math.min(60, Math.round(3000 / Math.max(1, args.listeners))));
  }

  const onSignal = () => { stop = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await Promise.all(loops);

  const rep = buildReport(code, (Date.now() - startedAt) / 1000);
  if (args.json) console.log(JSON.stringify(rep, null, 2));
  else printReport(rep);

  // Leaving the room closes the cost session, so a load test does not leave a
  // room looking live on the dashboard for the rest of the day.
  await call('POST', `/api/rooms/${code}/leave`, speaker, { endRoom: !args.room });

  process.exit(rep.verdict === 'crit' ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nload test failed to run: ${err.message}\n`);
  process.exit(2);
});
