# Admin guide

## Becoming an admin

Admin is a list of platform usernames in the `LT_ADMIN_USERNAMES` secret,
comma-separated, matched case-insensitively. Set it in the app's Secrets panel
(the key icon in the app header). It takes effect on the next deploy.

The list **fails closed**. Empty or unset means nobody is an admin, which
means nobody can see cost, grants, pilot feedback or the error console. Set it
before launch; it is gate 10 of the go/no-go.

Nothing else grants admin. The platform's own JWT carries no admin claim, so
there is no way to be an admin here by being an admin elsewhere.

## The screens

| Path | Who | What it is for |
|---|---|---|
| `/admin/metrics` | any signed-in user, with cost and grants hidden from non-admins | Latency, failures, readiness, spend |
| `/admin/alerts` | any signed-in user | What has been wrong for at least ten minutes |
| `/admin/compat` | any signed-in user | What this browser and device can actually do |
| `/admin/errors` | admins only | Client and server errors, grouped |
| `/admin/feedback` | admins only | Pilot feedback, with averages by purpose |
| `/health` | anyone, no sign-in | Container, database, proxy, queue depth |

Metrics accepts `?range=1h`, `?range=24h` or `?range=7d` (the default), and
every screen accepts `?lang=id` to render in Indonesian. Both are pure client
state and write nothing, which is what makes them safe to point a screenshot
at.

## Reading the metrics screen

**Readiness** is the panel to read first. Five checks, each with a verdict:

- `pass` — under target.
- `warn` — over the warn threshold.
- `crit` — over the crit threshold.
- `insufficient` — fewer than 50 samples. This is not a pass. A verdict
  computed on four rows is worse than no verdict, so the screen says so
  instead of showing a green tick nobody earned.

The three latency targets, all from `lib/slo.js`:

- **First words on screen** — 500 ms. Translation start to words rendered.
  This is the part the app owns end to end, so it is the number to care about.
- **Caption on screen** — 2500 ms. Microphone, translation and delivery. The
  microphone is the operating system's and typically costs 700-1500 ms on its
  own, which is why the original "under 500 ms end to end" target was replaced
  with three honest ones.
- **Caption spoken** — 3500 ms, and legitimately absent for anyone reading
  rather than listening.

**Failures** groups translations that came back error or unavailable by their
cause code. Four of those causes are not outages: `llm_disabled` (no proxy in
this environment), `grant_required`, `app_cap_exceeded`, `budget_exceeded`.
Read the grouping before reacting to the total.

**Cost** is spend against the platform LLM proxy, per call and per day. It is
admin-only because it is the app's operating cost, not a user's.

## Alerts

Six rules, evaluated every five minutes. An alert opens after two consecutive
breaching evaluations and resolves after two clear ones, so a single bad
window is weather rather than an incident. `silent_room` is per room; the rest
are global.

`runbook.md` has one section per rule, keyed by the same names the screen
shows, with what it means and what to look at first.

## The device check

`/admin/compat` probes the browser it is opened in and prints what it found:
speech recognition, whether the microphone is even reachable inside the app
frame, speech synthesis, a voice for each launch language, audio context and
ducking, local storage, the last observed long-poll hold, and safe-area
insets.

Ask every pilot participant to open it and screenshot it before their first
session. It is two minutes and it explains most of what goes wrong later.

The microphone row is the one to read carefully. The platform delegates only
`geolocation`, `clipboard-write` and `pointer-lock` to app frames, and an
undelegated capability rejects with the same error code a user refusal
produces. The screen distinguishes "you said no" from "we were never allowed
to ask", because telling a user to change a permission they were never asked
for is the worst possible support answer.

## Running a call as host

- **Mode.** A room can be switched to transcript-only, which records what was
  said without translating it. Nobody's budget is spent and the captions stay
  in the original language. It is the bottom rung of the budget ladder and the
  host's escape hatch.
- **Tier.** A host can move a room up (direct, group, large) but never down.
  Moving up mid-call is what a townhall that outgrew its room does.
- **Floor.** Group rooms have three speaking slots and a hand queue; townhalls
  have one. Hands are ordered and the host admits them.
- **Mute and remove.** Both are host-only, both take effect immediately, and
  the affected person is told which one happened rather than being silently
  ignored.

## Cost control

Spend is bounded by structure, not by watching:

- A room translates into at most four distinct target languages, enforced when
  someone joins and again in the fan-out.
- Each (room, language) pair has a serial queue, so a fast talker cannot start
  ten parallel translations.
- A budget ladder sheds work as a room's spend rises: fewer context turns,
  then floor-holders only, then transcript-only.
- Every call is billed to the speaking user's own platform AI budget under a
  consent grant they can revoke at any time. The app never holds an API key
  and never asks anyone for one.

## Retention

- Utterances and their translations: 72 hours.
- Latency samples: 7 days.
- Error events: 14 days.
- Feedback, alerts, cost sessions and daily rollups: kept.

Housekeeping runs hourly, alert evaluation every five minutes.

## Deploying and undeploying

There is no deploy step. Merging a proposal rebuilds production. Undoing a
change is a revert PR, and because the database is not reverted with it, every
migration in this repo only ever adds. See `rollback.md` before you need it.
