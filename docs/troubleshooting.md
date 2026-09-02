# Troubleshooting

Organised by symptom, because that is what somebody arrives with. Each entry
names the screen that confirms it.

## "Nothing happens when I press the microphone"

**Confirm:** `/admin/compat`, the speech recognition row and the microphone
row.

- **No speech recognition.** Firefox has none at all, and some WebViews do
  not expose it. The typed composer is the answer and the app should already
  be showing it as the primary input.
- **Microphone unreachable in the frame.** The row says so distinctly, and it
  is not the user's permission setting. The platform does not delegate
  microphone to app frames; an undelegated capability rejects with the same
  code a refusal produces. Do not send anyone to their device settings. Typed
  input is the supported path inside the Usernode app.
- **Microphone denied by the user.** Then it is a device setting, and the
  compat row will say denied rather than unreachable.

## "I am talking but nothing appears"

**Confirm:** the room screen, then `/admin/alerts` for `silent_room`.

- Is the room in transcript-only mode? Then captions appear in the original
  language and nothing is translated, on purpose.
- Are you muted by the host, or waiting in the hand queue? Both say so on
  screen.
- Does a typed caption go through? If yes, it is capture, not delivery. If no,
  it is delivery, and `/admin/errors` will have the code.
- The recogniser only sends when it decides you have stopped. A long unbroken
  monologue can sit unsent for a while; pause between sentences.

## "Captions are slow"

**Confirm:** `/admin/metrics`, the three latency legs.

Read which leg is carrying it.

- **Capture high.** The browser's recogniser, which is the operating system's.
  Nothing in this app moves it. Compare devices.
- **Translate high.** Check `queueDepth` on `/health`. A deep queue means
  fan-out is backed up (a busy room with several target languages); a normal
  queue with slow proxy times is the model being slow, which is upstream.
- **Deliver high.** Check whether holds are happening. A direct or group room
  should be long-polling; if the compat screen shows a hold far shorter than
  eight seconds, something between the browser and the app is capping request
  duration and every caption is waiting a full tick. Large rooms never
  long-poll, by design.

## "Captions stopped and then all arrived at once"

Expected, and the reconnect working. The client polls with a cursor; a
network drop just means the next request carries an older cursor and catches
up. There is no separate reconnect path to break. If the burst contained
duplicates, that is a bug worth an issue with the room code.

## "The caption says translation is unavailable"

**Confirm:** `/admin/metrics`, the failure breakdown, which groups by cause.

- `llm_disabled` — no LLM proxy in this environment. Always true in staging
  previews. In production it is an incident.
- `grant_required` — the user has not granted this app AI access, or revoked
  it. The UI offers the consent dialog; the platform owns that dialog and the
  app cannot approve itself.
- `app_cap_exceeded` — the user's daily cap for this app is spent. Resets at
  midnight UTC.
- `budget_exceeded` — the user's whole daily AI budget is spent.

None of these block the speaker. The original text is always delivered.

## "No sound, but the captions are there"

**Confirm:** `/admin/compat`, the synthesis and voices rows.

- **No voice for that language on this device.** The caption falls back to
  text and marks itself as not read aloud. It is a device voice pack, not a
  bug. Record which language, because it determines what we can promise.
- **Listening mode is set to original, or to translation when you expected
  both.** Three modes, in the language sheet.
- **The synthesiser never started.** The client reports this itself as
  `audio_start_timeout` or `audio_watchdog` in `/admin/errors`. Usually
  another tab holding the audio device, or a mobile browser that requires a
  user gesture before it will speak.
- **The original is too loud under the translation.** That is the ducking
  sink; if it is not working the compat screen's audio context row will say
  so.

## "It forgot my language"

**Confirm:** `/admin/compat`, the local storage row.

A browser refusing storage to a cross-origin frame is a normal degradation in
some WebViews. Preferences are also stored server-side per user, so this
usually only affects a signed-out or first-load state.

## "The interface is in the wrong language"

The app resolves interface language in this order: the preference saved in
your profile, then your platform language setting, then the device language,
then English. A platform setting of "no preference" means no preference, not
English, so the device gets a say.

Add `?lang=id` or `?lang=en` to any URL to force it for that view. That is
display-only and writes nothing.

## "I cannot see the admin screens"

Your username is not in `LT_ADMIN_USERNAMES`. It is a comma-separated list in
the Secrets panel, case-insensitive, effective on the next deploy, and empty
means nobody. `/admin/metrics` still renders for you with cost and grants
replaced by a note; `/admin/errors` and `/admin/feedback` will show the same
note in place of their lists.

## "A caption was translated wrong"

Get the room code and roughly the minute; utterances are kept 72 hours.
Protocol nouns are supposed to survive verbatim, so "validator" coming back as
a generic word is a real bug and belongs in an issue, with the term and the
language pair but **not** the surrounding conversation.

Caption text stays in the tracker. It does not go into a GitHub issue and it
is never in a diagnostic snapshot.

## "The page is blank in a staging preview"

Almost always missing seed data rather than a bug. Staging starts from a copy
of production with every private table empty, so anything the screen needs has
to be seeded. Check the demo rooms (`DEMOSUP`, `DEMOTEAM`, `DEMOHALL`) render
first.

## "The app will not load at all"

`/health` first. `shutting_down` means a deploy is in progress and it will be
back in a few seconds. `unhealthy` with `db: failing (n)` means the database
is unreachable and the app cannot do anything about it. If `/health` itself
does not answer, the container is down and that is platform-side.
