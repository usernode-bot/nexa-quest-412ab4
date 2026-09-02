# Pilot plan

## Size and shape

Five to ten testers, run over two weeks. Composition matters more than count:

- **At least two Indonesian-first speakers** who are not comfortable working
  in English. They are the people the product exists for, and they are the
  only ones who can tell us whether the Indonesian side reads naturally
  rather than like a machine.
- **At least two English-first speakers**, ideally in a different time zone
  from the first group, so the validator scenario is a real cross-time-zone
  call rather than two people in one room.
- **At least one person on the Usernode mobile app**, not a desktop browser.
  That is where the microphone limitation bites and where we most need to
  know whether typed input carries a whole conversation.
- The rest fill gaps in the browser matrix in `testing-checklist.md`.

## One session per pinned use case

The four use cases are not a loose list, they are `ROOM_PURPOSES` in
`lib/config.js` and the lobby is built out of them. Each one gets at least
one real session with real participants.

| Use case | Shape | What we are testing | Passes when |
|---|---|---|---|
| **Onboarding** | 1 operator + 1 new node runner, direct tier | Whether someone can be walked through setup with no shared language | The new runner completes the setup steps without switching to English or another tool |
| **Support** | 1 agent + 1 user, direct tier | Turn-taking latency in a back-and-forth | Neither side talks over the other more than once, and no question needs repeating |
| **Validator room** | 3-5 operators, group tier | Three floor slots under real interruption | The floor changes hands cleanly; nobody is stuck with a hand up |
| **Global townhall** | 1 host + 8 or more listeners, large tier | Read-only comprehension at scale, aggregated roster | Listeners in at least three languages follow a ten-minute talk and can answer questions about it |

Run the townhall last. It is the one that most needs the other three to have
shaken the bugs out first.

## Before each session

1. Every participant opens `/admin/compat` on the device they will use, and
   sends a screenshot. Two minutes, and it explains most of what goes wrong
   later.
2. Anyone who has not granted AI access does so when prompted. A declined
   grant means captions come back unavailable, which looks like an outage and
   is not one.
3. The host notes the room code and the start time so the session can be
   matched against `/admin/metrics` afterwards.

## During

- The host watches the caption feed, not the metrics screen. Metrics are for
  after.
- Anything that looks wrong gets said out loud and noted with the room code
  and roughly the minute. That is enough to find the utterance later.
- Nobody reloads to fix a stall. A stall that recovers on its own is data; a
  stall someone reloaded through is nothing.

## After each session

- Every participant fills in `/feedback` from the ended screen. It is
  prefilled with the room and purpose, so it takes under a minute.
- The host reads `/admin/metrics` for the session window and records the
  readiness verdict, the three latency legs and any open alert.
- Any P0 or P1 goes straight to an issue. Everything else waits for the
  weekly pass so we are not chasing single reports.

## Priority definitions

Agree these before the pilot starts, because arguing about severity during
an incident is how a pilot loses a week.

- **P0** — a call cannot happen. Nobody can join, no captions at all, the app
  will not load, or something private is visible to somebody it should not
  be. Fix before the next session.
- **P1** — a call happens but the product does not work. Captions arrive too
  late to hold a conversation, a launch language is systematically wrong,
  audio never starts on a common device. Fix within the pilot.
- **P2** — friction. Wrong wording, a confusing control, a voice that sounds
  bad but works. Batch these.
- **P3** — polish and ideas. These become roadmap input, not pilot work.

## Weekly pass

Once a week during the pilot: read `/admin/feedback` (averages overall and by
purpose), `/admin/errors` (grouped by code and source) and `/admin/alerts`.
Three screens, fifteen minutes. Write down the one thing that would most
improve the next week and do that.

## Exit

The pilot ends when every use case has run at least once with no open P0 and
no unfixed P1, and the go/no-go criteria in `go-no-go.md` have been walked
through with the numbers actually on screen.
