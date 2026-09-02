# Scaling

## What this document is

An inventory of everything in this app that assumes **exactly one container**,
so that whoever eventually runs two knows what breaks. It is not a plan to run
two. Horizontal scaling is the platform's to provide, this app cannot request
it, and nothing here should be built speculatively.

What the app can do is use the one container well, and that part is real work
that has been done.

## The axis that actually costs

Participants are not the expensive dimension. Distinct **target languages**
are: a room with 200 listeners who all read English costs one translation per
utterance, and a room with 4 listeners in 4 languages costs four. That is why
`MAX_TARGET_LANGS: 4` is the hard cap, enforced at join time and again as a
`slice` in the fan-out, and why the `large` tier can carry 200 people.

The tiers exist for the second-order costs, which are per-participant:

| Tier | Max | Long poll | Roster | Why |
|---|---|---|---|---|
| `direct` | 4 | yes | full | A held request per listener is nothing at this size. |
| `group` | 12 | yes | full | Still nothing; three floor slots. |
| `large` | 200 | **no** | aggregate | A held request per listener is exactly what does not scale to hundreds, and a row-per-participant roster stops being sendable. |

## In-container work that has been done

- **A shared per-room long-poll waiter.** Listeners in the same room do not
  each poll the database. One watcher per room re-runs a single
  `SELECT seq` on a tick and wakes every waiter attached to it, so the query
  cost of a held room is per room, not per listener. Waking is abandoned the
  moment `shuttingDown` flips, so a deploy still drains in about 3 seconds.
- **Long polling, not `LISTEN/NOTIFY`.** A listening connection would be held
  out of the pool per viewer. A held HTTP request costs a socket and nothing
  else.
- **Explicit pool bounds.** `max: 20`, `idleTimeoutMillis: 30000`,
  `connectionTimeoutMillis: 5000`, and `SET statement_timeout = 5000` on every
  connection, so one pathological query cannot hold a connection forever.
- **Serial per-(room, target) queues with an in-flight shed backstop**, plus
  `translator.sweepQueues()` from housekeeping to drop queues for rooms that
  have gone away.
- **A hard timeout on the proxy call** (`AbortController`, 12 s), and a
  separate time-to-first-token deadline (4 s) so a stalled stream fails as a
  caption state rather than occupying a slot.
- **Compression and cache validators.** `compression` is mounted before the
  static handler; `app.js` and `audio.js` are served with an ETag and
  `Cache-Control: no-cache` so they revalidate rather than re-download;
  `/api/config` gets `max-age=300`. There is no CDN and there will not be one,
  so a 304 is the whole optimisation.

## Process-local state: what a second container would break

Everything in this section lives in a JavaScript `Map` in one process. With
one container that is correct and cheap. With two, each copy would hold half
the truth.

### `lib/engine/proxy-text.js`

| State | Holds | With two containers |
|---|---|---|
| `contexts` | The last few turns of a room's conversation, used as translation context | Each container has half the conversation. Translations get less coherent, not wrong. |
| `queues` | Per-(room, target) serial job queues | Two containers would each run a serial queue for the same pair, so two translations of the same utterance could interleave. The `seq` write is the ordering authority, so the visible effect is wasted spend rather than corruption. |
| `inflight` | Which (room, target) pairs are running | The shed backstop counts only local work, so the real concurrency doubles. |
| `globalInflight` | Total concurrent proxy calls | Same: the cap becomes per container, not global. This is the one with a cost attached. |

### `lib/cost.js`

| State | Holds | With two containers |
|---|---|---|
| `state` | The current budget rung per room (the shed ladder) | Two containers can disagree about which rung a room is on, so a room could shed on one and not the other. |
| `sessions` | Open cost-session ids per room | A session opened on container A is not closable by container B; the ledger row would be left open until housekeeping. |
| `lastSeen` | Last activity per room, for session close | Same. |

### Elsewhere

- `lib/alerts.js` keeps consecutive-breach counters per rule in memory. They
  are hysteresis, not a record: a restart re-arms every rule, which costs at
  most one extra evaluation cycle before an alert reopens. With two
  containers each would keep its own streak and the alert would open on
  whichever crossed first, which is acceptable but no longer means "two
  consecutive evaluations".
- `lib/stream.js` keeps the per-room watcher map. Two containers would each
  poll `seq` for the same room. That is a doubling of a very cheap query, not
  a correctness problem: the database is the shared truth.
- `server.js` caches the `/health` database probe and its consecutive-failure
  strike count per process. Correct per container by definition.

### The shape of a fix, if it ever becomes necessary

Not to be built now. Recorded so the next person does not have to rediscover
it:

- `contexts` would move to a table keyed by room, read with the utterance.
- `queues`, `inflight` and `globalInflight` would need an advisory lock per
  (room, target) and a counter row for the global cap.
- `cost.state` and `cost.sessions` are already backed by `room_sessions`; the
  Maps are a write-behind cache and would become read-through.
- The long-poll watcher would stay per container. It is already
  database-backed and duplicating it is harmless.

## What the platform holds, not this repo

Listed so nobody looks for it here:

- **Deployment and zero-downtime rollout.** The platform rebuilds the
  container on merge. The app's contribution is a correct SIGTERM handler and
  a `/health` that reports `shutting_down` before the drain.
- **Rollback.** A revert PR. See `rollback.md`.
- **CDN.** None. Compression and cache validators are the substitute.
- **Prometheus / Grafana / external error tracking.** The in-app dashboard is
  the monitoring and `error_events` is the error tracker.
- **Horizontal scaling.** Not available, not requestable. Hence this document.
- **Secret storage.** The platform Secrets UI, declared in `dapp.json`.
