# Security review

Scope: this repo. Everything below is either something the app does, or
something the platform does that the app must not undo.

## Authentication

The platform mints an RS256 JWT per user per app and injects it into the
iframe as `?token=`. The app verifies it with `USERNODE_JWT_PUBLIC_KEY` and
pins three things plus a claim:

- `algorithms: ['RS256']` — not optional. Every app on the platform knows the
  public PEM. A verifier that also accepted HS256 would treat that PEM as an
  HMAC secret and let any caller forge any user.
- `issuer: 'usernode'`.
- `audience: 'usernode:app:<USERNODE_APP_ID>'` — what stops a token minted for
  another app from working here.
- `pur === 'iframe'`.

Every non-GET request and every `/api/*` request is deny-by-default. The
public set is exactly `/health`, `/favicon.ico` and `/api/config`, all three
of which return the same bytes to everyone. `req.user` carries only
`{ id, username, usernode_pubkey, locale }`; the app never sees an email or a
real name and does not ask for one.

The app does not and must not roll its own login, mint its own session
cookie, or accept a user id from a request body as an identity.

## Authorization

Two levels, both explicit.

**Room level.** Membership is a row in `room_participants`. Host-only actions
(mode, tier, mute, remove) check `room.host_user_id === req.user.id` inside
the same transaction that reads the room `FOR UPDATE`. Retracting an
utterance checks the speaker. A removed participant is refused rather than
silently ignored, so the UI can say why.

**App level.** `LT_ADMIN_USERNAMES`, a non-private `dapp.json` secret holding
a comma-separated list of platform usernames, matched case-insensitively.
It **fails closed**: an empty or unset value means nobody is an admin. The
previous `isAdmin` read a claim the platform JWT does not carry and could
therefore never return true, which meant the admin surfaces were unreachable
rather than protected. Fixing that was the point of the change.

Admin-gated: `GET /api/feedback`, `GET /api/errors`, and the `cost` and
`grants` blocks of `GET /api/metrics`.

All three **withhold the data with a 200 rather than refusing with a 403**.
That is a deliberate choice and worth being explicit about, because a 200 on a
denied read looks careless at a glance. The reasoning: the privileged rows are
not in the response either way, so the two answers are equally confidential;
what differs is that a 403 makes the browser log a failed request on a screen
that is working exactly as designed, which pollutes the console-error signal
the proposal checks and `/admin/errors` both depend on. The envelope carries
`adminOnly: true` and empty collections, and the screen renders a "visible to
app admins" placeholder.

The rule this follows: refuse when the caller asked for something they may not
do, answer when they asked what they may see and the answer is nothing. Every
write path still refuses outright.

`GET /api/alerts` is deliberately **not** admin-gated. An alert row carries a
rule name, a severity and a room code. Any participant already knows their
room is misbehaving, and hiding the reason helps nobody.

## Table privacy

Staging containers get a copy of the production database. The question for
each table is: would a stranger opening a staging preview seeing every row be
a problem?

| Table | Marking | Reason |
|---|---|---|
| `rooms` | public | Code, title, purpose, tier. A room code is not a credential; joining still requires an authenticated user and passes the roster checks. |
| `room_participants` | public | Usernames and language choices, already visible to everyone in the room. |
| `utterances` | **private** | Verbatim speech. What someone says in a support call is the most sensitive thing this app touches. |
| `utterance_translations` | **private** | The same speech in another language. |
| `reports` | **private** | Who reported whom, and why. |
| `error_events` | **private** | Free-text error messages from clients and the server. Sanitised, but sanitised free text is still free text. |
| `pilot_feedback` | **private** | Written comments about calls, plus the reporter's identity. |
| `user_language_prefs` | public | A language choice and a listening mode. |
| `llm_grant_events` | public | Whether a grant was asked for and accepted. No content, no amounts. |
| `active_speakers`, `room_sessions`, `rate_events`, `daily_usage`, `latency_samples`, `alerts` | public | Integers, counters and rule names. Nothing identifying, nothing said. |

### The invariant the linter enforces

**A public table must never carry a foreign key into a private one.** Staging
copies private tables schema-only, so such an FK would dangle in every
preview. Checked at migration time.

Note `latency_samples` therefore holds `room_id` but no `utterance_id`: the
sample is assembled by joining the private tables server-side, and only
integers land in the public row.

### The invariant nothing enforces

**No caption text may reach a public table, a log line, an issue body or a
diagnostic snapshot.** Specifically:

- `latency_samples` — integers and a language tag only. No text, no user id,
  no utterance id.
- `error_events.message` — a browser or driver error string, capped, never a
  caption. The client's `report()` helper passes an error, never content.
- `pilot_feedback.compat` — capability flags and counters from the device
  check. Never caption text, never a room transcript.
- Structured logs — `lib/log.js` fields are ids, codes and durations. A
  translation is logged by length and status, never by content.

Nothing in the migration linter can check this. It is a review question on
every change that adds a column, a log field or a snapshot key.

## Input handling

- `express.json({ limit: '64kb' })`. An utterance is capped at 500 characters
  server-side and the client caps the composer to match; the body limit is
  the backstop for everything else.
- Every user-supplied string reaching the DOM goes through `esc()`. The
  client renders with template strings, so this is a review invariant rather
  than a framework guarantee: a new interpolation of user data without `esc()`
  is an XSS, and the reviewer's job is to notice it.
- `SAFE_PATH` validates the chromeless deep-link path before it is echoed
  into a redirect: single leading slash, never `//`, no scheme, no
  whitespace, no backslash, no quote or angle bracket, and at most 512
  characters, which is the platform's documented ceiling. The path is then
  encoded as one query value so an inner query survives the trip.
- Language codes, purposes and tiers are matched against fixed lists from
  `lib/config.js`, never interpolated.
- The latency range parameter maps a fixed set of tokens onto a fixed set of
  SQL intervals. Nothing from a request is ever interpolated into SQL; every
  other value is a parameter.

## Rate limits

All in `rate_events`, keyed by scope plus a per-user or per-room key.

| Scope | Limit |
|---|---|
| `room_create` | 4 per hour per user |
| `join` | 20 per minute per user |
| `utterance` | 60 per minute per room |
| `lang_switch` | 3 per minute per user |
| `latency` | 30 per minute per user |
| `report` | 10 per hour per user |
| `feedback` | 5 per hour per user |
| `client_error` | 20 per 5 minutes per user |

Spend is bounded structurally rather than by rate limiting alone:
`MAX_TARGET_LANGS: 4` is enforced at join time and again as a `slice` in the
fan-out, with per-(room, target) serial queues and an in-flight shed backstop.

## Error responses

Every failure goes through one `fail()` helper. The body is
`{ error: <code>, message, requestId }` where `message` is a fixed localised
string chosen by the code, never `err.message`. A driver string can name a
column, a constraint or a value; none of that belongs in a response. The
underlying cause is logged and written to `error_events`, both server-side.

`grep -n "err.message" server.js` should only ever match log calls and the
`/health` probe's internal cache. It currently does.

## Not applicable, and why

- **Content-Security-Policy and `X-Frame-Options`.** This app is designed to
  be framed by the platform shell. `X-Frame-Options: DENY` would break it
  entirely, and a `frame-ancestors` CSP would have to name the shell's origin,
  which the app does not own and which changes per deployment. The framing
  boundary is the platform's to enforce, not ours.
- **CORS.** The app serves its own frontend from its own origin and the
  browser sends the token as a header on same-origin requests. There is no
  cross-origin API surface to configure, and adding permissive CORS would
  create one.
- **Our own secret store.** Values live in the platform Secrets UI, declared
  in `dapp.json`. Exactly one declaration exists (`LT_ADMIN_USERNAMES`) and it
  is non-private, because a list of usernames is not a credential and staging
  needs the same value to be reviewable.
- **Third-party API keys.** There are none and there must never be any. AI
  goes through the platform LLM proxy under a per-user consent grant.

## Open items

- The microphone is not delegated to app frames by the platform's Permissions
  Policy, and an undelegated capability rejects with the same
  `PERMISSION_DENIED` a user refusal produces. The app reports the two states
  distinctly on `/admin/compat` and makes the typed composer primary when the
  microphone is unreachable. Escalated to the platform; not worked around.
