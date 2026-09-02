# Support runbook

The on-call surface for this app is four screens, all in-app:

| Screen | What it answers |
|---|---|
| `/health` | Is the container up, is the database reachable, is the LLM proxy present |
| `/admin/metrics` | Are captions fast enough, and how many are failing |
| `/admin/alerts` | What has been wrong for at least ten minutes |
| `/admin/errors` | What exactly failed, grouped by code and source |

There is no Prometheus, no Grafana and no pager. The in-app dashboard is the
monitoring, which means somebody has to look at it. During the pilot that is
a daily habit; after launch, the weekly pass in `pilot-plan.md`.

## `/health` fields

`GET /health` is unauthenticated and cheap. Fields:

- `status` — `ok`, `degraded`, `unhealthy`, or `shutting_down`.
- `db` — `ok`, or `failing (n)` where n is consecutive probe failures. The
  probe is cached for 5 s and only turns the endpoint red after three
  consecutive failures, so one dropped connection during a failover does not
  look like an outage.
- `llm` — `ok` or `absent`. `absent` is correct and expected in staging.
- `engine` — `proxy-text` in every environment today.
- `queueDepth`, `translationSessions` — in-flight work and open cost sessions.
- `version`, `uptimeS`, `env`.

`shutting_down` is served with a 503 before the drain begins, on purpose:
anything polling readiness should see the container leave rotation before it
stops answering.

## Alert rules

One section per rule in the `alerts` table. The rule names here are the same
strings the table stores and the alerts screen shows, so an alert can be
looked up by copying its name.

### `latency_p95`

**Means.** The three-leg caption time (microphone plus translation plus
delivery) p95 is over 2500 ms, or over 4000 ms for a crit.

**First look.** `/admin/metrics`, the three latency legs. One of the three
will be carrying the whole increase.

- **Capture is high.** That is the browser's recogniser, not this app. Check
  whether the affected sessions are on one device or browser; the compat
  screenshots will usually explain it. Nothing in this repo will move it.
- **Translate is high.** Check `queueDepth` on `/health` and the engine
  section on the metrics screen. A deep queue with a normal proxy time means
  fan-out is backed up: too many distinct target languages in one busy room.
  A normal queue with a slow proxy time means the model is slow, which is
  upstream.
- **Deliver is high.** Check the held ratio. If holds have stopped happening
  on a direct or group room, long polling is being defeated by something
  between the browser and the container and every caption is waiting a full
  tick.

**Do.** If it is translate and the room is large, the tier already drops
context turns; there is nothing further to tune live. If it is delivery,
confirm the tier: `large` never long-polls, and a townhall that was upgraded
mid-call will show exactly this.

### `first_word_p95`

**Means.** Time to first token plus delivery p95 is over 500 ms (900 ms for a
crit). This is the leg the app owns end to end, so this alert is the one most
likely to be our fault.

**First look.** The readiness panel's `firstWord` row, then the engine
section for time to first token specifically.

**Do.** A rising time to first token with normal total latency points at the
proxy. A normal time to first token with a rising number points at delivery,
so read `latency_p95` above. If both are normal and the alert is still open,
check the sample count: a check computed on barely 50 samples swings hard.

### `error_rate`

**Means.** More than 2 percent of translations came back `error` or
`unavailable` (8 percent for a crit).

**First look.** `/admin/metrics` → the failure breakdown, which groups by
`fail_code`. The code tells you which of four different problems this is:

- `llm_disabled` — no proxy credentials. Correct in staging, an incident in
  production.
- `grant_required` — users have not granted AI access, or have revoked it.
  Product problem, not an outage. Cross-check the `proxy_grants` alert.
- `app_cap_exceeded` / `budget_exceeded` — someone's daily budget is spent.
  Resets at midnight UTC. The caption row explains itself in the UI and the
  speaker is never blocked.
- Anything else — a real upstream failure. Read `/admin/errors` for the
  message.

**Do.** Only the last case is ours. The first three are states the UI already
explains; the alert exists so we notice a spike, not so we fix each one.

### `audio_fallback_rate`

**Means.** More than 20 percent of sealed clauses that should have been
spoken never started a synthesiser (40 percent for a crit).

**First look.** Which languages. A device with no voice pack for one language
falls back to text for that language only, so this alert usually means a
particular language rather than a broken audio path.

**Do.** If it is one language, that is a device-side voice pack and the fix is
documentation, not code: say in the language sheet that audio is unavailable
for it on that platform. If it is every language on many devices, something in
the audio bus broke; check `/admin/errors` for `audio_start_timeout` and
`audio_watchdog`, which the client reports itself.

### `silent_room`

**Means.** A room is open, somebody was present in the last two minutes, and
no caption has succeeded in five minutes. Opens per room, so several can be
open at once.

**First look.** Is it actually silent? A validator room with people sitting
in it not talking is the normal case and is not a problem.

**Do.** If people say they are talking and nothing appears: check whether
their microphone is reachable (compat screen), whether they are muted by the
host, and whether the room is in transcript-only mode, which records what was
said without translating it. The alert resolves on its own two evaluations
after a successful caption.

### `proxy_grants`

**Means.** At least ten people were asked for AI access and fewer than half
said yes. Warn only, never crit.

**First look.** This is a copy problem almost every time. Read the consent
purpose line in `dapp.json` as a user would.

**Do.** Nothing operational. It is a product signal and belongs in the weekly
pass, not in an incident.

## Common operations

**Somebody cannot see the admin screens.** Their username is not in
`LT_ADMIN_USERNAMES`. It is a comma-separated, case-insensitive list set
through the Secrets UI, and it takes effect on the next deploy. An empty list
means nobody, by design.

**A caption said something wrong.** Get the room code and roughly the minute.
Utterances are retained 72 hours. Caption text stays in the tracker; it never
goes into a GitHub issue or a diagnostic snapshot.

**A user reports "nothing happens".** Ask them to open the platform's Dev
Console (the console icon in the header) and paste the red lines. Do not ask
for browser devtools; most users are in the mobile app where there are none.

**Deploy looks stuck.** The container drains for about 3 seconds on SIGTERM
and `/health` reports `shutting_down` throughout. If a deploy takes much
longer than that, it is the build, which is platform-side.

**The whole thing is wrong.** `rollback.md`.
