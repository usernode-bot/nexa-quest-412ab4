# Production go / no-go

Read this with `/admin/metrics` open on a 7 day range and `/admin/alerts` in
another tab. Every criterion below is either a number the app already shows
or a yes/no somebody has to say out loud. Nothing here is a judgement call
about "feeling ready".

## Hard gates (any single no is a no-go)

| # | Gate | Where to read it | Threshold |
|---|---|---|---|
| 1 | Readiness verdict is not `crit` | `/admin/metrics` → readiness panel | `pass` or `warn` |
| 2 | First words on screen | readiness panel, `firstWord` | p95 under 900 ms (crit line in `lib/slo.js`) |
| 3 | Caption on screen, three legs | readiness panel, `total` | p95 under 4000 ms |
| 4 | Translation failures | readiness panel, `failRate` | under 8 percent of captions |
| 5 | Enough samples to mean anything | any check reading `insufficient` | at least 50 samples per check |
| 6 | No open `crit` alert | `/admin/alerts` | zero open crit rows |
| 7 | Every pinned use case ran | pilot tracker | four sessions, one per purpose |
| 8 | No open P0, no unfixed P1 | issue tracker | zero |
| 9 | Load test passes | `npm run loadtest` against staging | exit code 0 |
| 10 | Admin roster is set | `LT_ADMIN_USERNAMES` in the Secrets UI | at least one real username |

Gate 10 is the one that gets forgotten. The admin list fails closed: an empty
value means nobody can see cost, grants, feedback or the error console in
production, which is a silent loss of every operational surface in this
document.

## Soft gates (a no here needs a written reason, not a block)

- **Caption spoken**, the four-leg number, p95 under 5500 ms. Legitimately
  absent if most pilot users read rather than listen.
- **Could not be spoken** under 40 percent. A high number usually means a
  missing voice pack for one language rather than a bug, and the compat
  screenshots will say which.
- **Grant acceptance** above 50 percent. Below that, the consent copy is the
  problem, not the engine.
- **Repeat rooms**: at least two pilot participants started a second call
  without being asked to.

## Things that are explicitly not gates

- Zero errors. `/admin/errors` will always have rows; a browser that closes
  mid-poll is an error event and not a problem. Read the grouping, not the
  count.
- p50 anything. Half the users being fine has never been the bar.
- Cross-browser green everywhere. Firefox has no speech recognition and will
  not pass row 5 of the testing checklist as a speaker. That is a known,
  accepted, documented gap.
- Microphone inside the Usernode app WebView. Blocked on a platform
  capability, escalated, typed input is the supported path.

## The call

Go/no-go is a meeting with the four numbers from gates 1-4 read out loud, the
alerts screen shared, and one named person saying go or no-go. If it is a
no-go, write which gate failed and what would clear it. "Not yet" without a
gate attached is how a launch slips forever.

## After a go

1. Merge the proposal. Production redeploys on merge; there is no separate
   deploy step and no config to apply.
2. Watch `/health` and `/admin/alerts` for the first thirty minutes. The
   alert evaluator runs every five minutes, so give it two cycles before
   believing a clean board.
3. Run one real call yourself before telling anyone else it is live.
4. If it is wrong, `rollback.md`.
