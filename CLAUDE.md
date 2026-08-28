# LIVE TRANSLATION — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About LIVE TRANSLATION

**Feature name:** LIVE TRANSLATION.

**Problem.** UserNode Labs is an Indonesian-founded network with a global
community. Onboarding, support and validator coordination all currently
happen in whichever language both sides can half-speak — usually English,
badly — so the people with the most operational knowledge are often the
least able to share it. Text chat translation exists; live conversation
translation does not.

**Vision.** Anyone in the UserNode community can join a call, speak their
own language, and be understood by everyone else in theirs — with no
interpreter, no shared lingua franca, and no app switching.

**Value proposition.** You speak. They hear it in their language. That is
the whole product surface; everything else is in service of it.

**Four pinned use cases** (these are `ROOM_PURPOSES` in `lib/config.js`,
not a loose list — the lobby is built out of them):

1. **Onboarding** — walking a new node operator through setup.
2. **Support** — a support agent and a user who share no language.
3. **Validator room** — operators coordinating during an incident.
4. **Global townhall** — one host, a multilingual audience listening.

**Launch languages:** Bahasa Indonesia and English, with Japanese,
Spanish, Chinese and Portuguese already wired; Korean, Vietnamese and
Hindi are declared as coming soon so the sheet shows the roadmap.

**KPIs:** caption latency (p50/p95), call completion, translation-grant
acceptance rate, and repeat rooms. All four are on `/admin/metrics`,
backed by the `daily_usage` rollup and `llm_grant_events`.

## Architecture — the one thing to understand first

**No audio ever crosses the network.** Speech-to-text runs in the browser
(Web Speech API), only the recognised *text* is POSTed, translation happens
server-side through the platform LLM proxy, and the translated caption is
spoken back by the listener's local speech synthesiser.

This is not a stylistic choice. Apps on this platform may not call OpenAI
Realtime or Twilio directly and may not ask users for API keys, and the
platform LLM proxy is Anthropic **text-only**. Inverting where the audio
lives is what makes the product buildable at all — and it happens to
survive a bad connection far better than a media stream would.

Two consequences worth remembering before changing anything here:

- A server-side media worker (roadmap Stage 5) and the telephony bridge
  (Stage 6) are **blocked on platform capabilities that do not exist**, not
  on effort. Do not start building either; escalate with
  `usernode-report-platform-issue` instead.
- Real-time delivery is **HTTP cursor polling over a monotonic per-room
  `seq`**, not a WebSocket — nothing in the platform conventions guarantees
  `Upgrade:` handling. A reconnect after a network drop is the same request
  with an older cursor, which is why reconnect needed no separate code path.
- On the `direct` and `group` tiers that same request is **long-polled**:
  `GET /stream?wait=1` parks in `lib/stream.js` until the room's `seq`
  moves or the hold expires, then answers with `held: true` so the client
  comes straight back instead of sleeping a second time. It is a bounded
  `setTimeout` loop that re-runs one cheap `SELECT seq`, deliberately not
  `LISTEN/NOTIFY` — a listening connection would be held out of the pool
  per viewer, and a held HTTP request costs nothing but a socket. `large`
  rooms never hold; they stay on the plain interval. The wait is abandoned
  the moment `shuttingDown` flips, so a deploy still drains in ~3s.

## App-specific conventions

- **Protocol nouns are never translated.** `PRESERVE_TERMS` in
  `lib/config.js` (UserNode, validator, staking, seed phrase, RPC, gas,
  slashing, epoch, mempool, …) must survive verbatim, as must numbers,
  versions and addresses. A translated wallet address is a lost wallet.
  Add to that list rather than patching prompts ad hoc.
- **`lib/config.js` is served verbatim to the browser at `GET /api/config`**
  so client and server cannot drift on languages, limits or purposes. Put
  anything both sides need there; never duplicate a constant.
- **Spend is bounded structurally, not by hoping.** `MAX_TARGET_LANGS: 4`
  is enforced at join time *and* again as a `slice` in the fan-out, with
  per-`(room, target)` serial queues and an in-flight shed backstop in
  `lib/translate.js`. Any new fan-out path must go through `enqueue()`.
- **Failure is a caption state, not a 500.** No LLM proxy (staging,
  standalone), `grant_required`, `app_cap_exceeded` and `budget_exceeded`
  all resolve to `status: 'unavailable'` on the translation row, so the UI
  explains itself and the speaker is never blocked. Keep it that way.
- **Private tables:** `utterances`, `utterance_translations` and `reports`
  carry `staging:private` — what people say in a support call is not
  cloned into a preview container. No public table FKs into any of them.
- **Seeded demo rooms belong to fake identities only** (`staging-demo-*`,
  ids 900000+). Never seed `req.user`: membership is a signal this app's
  own logic reads, so seeding the visitor would make the read-only
  non-member view untestable and different in production. The
  "Translation preview" test exists precisely to pin that.
- **Latency is measured in three legs, and the client only ever reports
  its own.** `utterances.capture_ms` is how long the microphone took,
  `utterance_translations` carries the proxy leg, and the browser POSTs a
  *duration* to `/api/rooms/:code/latency` — `ageMs` the server computed on
  its own clock, plus the client's own elapsed render time. No client
  timestamp is ever trusted, so nothing depends on the two clocks agreeing.
  `lib/latency.js` joins the three legs server-side for `/admin/metrics`;
  the raw samples live in the public `latency_samples` table and are pruned
  by `houseKeeping`. Telemetry batches are fire and forget: a dropped batch
  is the correct failure, never a retry loop.
- **Model IDs carry no date suffix** (`claude-opus-5`). `budget_tokens`
  and assistant prefill both 400 on Opus 5; `output_config: { effort: 'low' }`
  is the latency lever.
