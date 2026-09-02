# Roadmap, Q3 to Q4

Two lists. The first is work this repo can actually do. The second is work
that needs a platform capability that does not exist, where the correct next
action is an escalation, not a branch.

The split is not a matter of effort. Everything in the second list is blocked
because apps on this platform may not call third-party audio or telephony
vendors directly, may not ask users for API keys, and the platform LLM proxy
is Anthropic text-only. Building around that is not clever, it is a fork of
platform infrastructure that stops receiving fixes.

## Buildable here

### Transcript export
A call already has everything needed: `utterances`, their translations, the
floor history and the participant roster. Export is a room-scoped read plus a
formatter, and the interesting decisions are policy, not code. Host-only or
any participant? Original only, one target language, or every language side by
side? Retention is 72 hours, so an export is the only durable record and that
should be stated on the button rather than discovered later.

Sizing: small. One endpoint, one screen, one `dapp.json` test.

### Per-speaker caption lanes
`lib/floor.js` already tracks up to three concurrent speakers on the group
tier and the feed already knows who said what. Today the feed is one column in
time order, which is right for two people and confusing for three. Lanes are a
rendering change over data that already exists.

Sizing: small to medium, entirely client-side, plus a screenshot-state deep
link so the layout is reviewable.

### Korean, Vietnamese and Hindi
Declared as coming soon in `lib/config.js` so the sheet already shows the
roadmap. Promoting one is a config change plus the honest part: a voice
availability pass per platform, because a language with no device voice is a
subtitles-only language and the sheet should say so before someone picks it.
`/admin/compat` already reports the installed voice list, which makes this
measurable rather than guessed.

Sizing: small per language, dominated by the voice survey.

### Per-room analytics
`daily_usage` rolls up across the app. A host finishing a call cannot see how
their own call went. The same three legs, the same failure causes, scoped to
one room and shown to its host. All the columns exist; this is a query and a
screen.

Sizing: medium. Worth doing after the pilot, when there is enough real data
for the numbers to mean something.

### Offline service worker
An app whose own service worker served its document on a previous online visit
is opened offline by the shell instead of the placeholder. For this app that
means the lobby, the demo and a cached read of a recent room, never `/api/*`,
which must always reach the network. Two things to design for: an offline load
carries no token at all, so identity comes from the app's own storage and must
never be destroyed when the token is absent; and the frame reloads when the
connection returns, so anything unsent has to be persisted rather than held in
memory.

Sizing: medium, and the failure modes are subtle. Not before the pilot.

## Blocked, do not start, escalate instead

### Telephony dial-in
The room screen already announces it as coming soon. A dial-in leg needs the
platform to own a telephony bridge; an app cannot hold carrier credentials and
cannot be handed a media stream. Escalate with
`usernode-report-platform-issue` describing the capability, not a workaround.

### Speech to speech
`lib/engine/realtime.js` reports `platform_capability_missing` and that is the
whole status. The LLM proxy is text-only and app storage is images only, so
there is no sanctioned path for audio in or out. The current architecture,
recognition in the browser and synthesis in the browser, exists precisely
because of this and is the right shape until the platform offers an audio
capability.

### Call recording
Needs durable audio storage. Platform file storage accepts PNG, JPEG, GIF and
WebP only, sniffed from the bytes. There is no encoding trick that makes this
allowed, and doing it anyway would put call audio somewhere the platform's
own privacy model does not cover. Note also that this app's whole privacy
story is that no audio ever crosses the network; recording changes the product,
not just the storage.

### Speaker diarization
Separating who spoke in a shared-microphone room is an audio-domain problem,
so it inherits the same block. The floor manager is the deliberate substitute:
the app knows who is speaking because someone took the floor, not because it
analysed a waveform. That substitute is good enough that diarization is worth
wanting only if a room ever has one microphone and several people.

## What to do with the second list

One escalation per distinct capability, filed once. The helper de-duplicates
against open reports, so re-drafting the same request adds nothing. Say what
the app needs it for and which flow hit it. Then carry on with the first list.
