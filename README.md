# LIVE TRANSLATION

Talk in your language. They hear theirs.

A cross-language live voice layer for UserNode Labs calls: everyone picks the
language they speak and the language they want to hear, and each participant
reads — and optionally hears — the room in their own language.

**No audio ever leaves the browser.** Speech-to-text runs locally (Web Speech
API), only the recognised text is sent to the server, translation happens
through the platform LLM proxy, and the translated caption is spoken back by
the local speech synthesiser. See `CLAUDE.md` for the architecture and for why
the server-side media worker and the telephony bridge are blocked on missing
platform capabilities rather than on effort.

Built on Usernode Social Vibecoding.

## Running it

`npm start` boots the server on `PORT` (3000 on the platform). It needs
`DATABASE_URL`, `USERNODE_JWT_PUBLIC_KEY` and `USERNODE_APP_ID`; the schema is
applied idempotently on boot, so a fresh database is fine.

`npm run loadtest -- --help` drives a room with a scripted speaker and a
configurable number of listeners and prints per-leg percentiles against the
thresholds in `lib/slo.js`. It exits non-zero on a critical verdict.

## Operating it

Four screens, all inside the app. `/admin/metrics` is the dashboard (three
latency legs plus the audio leg, readiness against the SLOs, failure causes,
cost and grants). `/admin/alerts` is what is currently firing. `/admin/compat`
is the device check each real browser fills in for itself. `/admin/errors` is
client and server errors. `/health` answers honestly, including during a
deploy drain.

The admin screens are gated on the `LT_ADMIN_USERNAMES` secret, which fails
closed: empty means nobody.

## Documentation

| Doc | For |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Anybody in a call |
| [docs/admin-guide.md](docs/admin-guide.md) | Whoever runs the app |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Organised by symptom |
| [docs/runbook.md](docs/runbook.md) | One section per alert rule |
| [docs/testing-checklist.md](docs/testing-checklist.md) | Browser and device matrix |
| [docs/pilot-plan.md](docs/pilot-plan.md) | Running the pilot |
| [docs/go-no-go.md](docs/go-no-go.md) | Production readiness gates |
| [docs/rollback.md](docs/rollback.md) | Reverting, and what a revert cannot undo |
| [docs/security-review.md](docs/security-review.md) | Auth, table privacy, rate limits |
| [docs/scaling.md](docs/scaling.md) | What assumes one container |
| [docs/roadmap-q3-q4.md](docs/roadmap-q3-q4.md) | Buildable next, and what is blocked |
