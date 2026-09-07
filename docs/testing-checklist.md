# Cross-browser and cross-device testing checklist

Every row here has a counterpart on the in-app device check at
`/admin/compat`. That screen is deliberately the source of truth: it probes
the real browser on the real device and prints what it found, so a tester
does not have to interpret anything. Open it first on each device in the
matrix, screenshot it, then work down this list.

There is no automated cross-browser suite and there is not going to be one.
The platform runs headless Chromium against the `dapp.json` tests on every
proposal, which catches "does it render". It cannot tell you whether Safari's
speech recogniser hears Indonesian. The compat screen turns each real browser
into a self-reporting test instead, which is the honest version of the same
coverage.

## The matrix

Run every row. `n/a` in a cell is a result, not a skip.

| # | Browser / device | Speech in | Voice out | Long poll | Notes |
|---|---|---|---|---|---|
| 1 | Chrome, desktop (Win) | expect yes | expect yes | expect yes | Reference platform. |
| 2 | Chrome, desktop (macOS) | expect yes | expect yes | expect yes | |
| 3 | Edge, desktop | expect yes | expect yes | expect yes | Same engine as row 1, different voice pack. |
| 4 | Safari, desktop (macOS) | expect yes | expect yes | expect yes | Recogniser is the OS one; needs dictation enabled. |
| 5 | Firefox, desktop | **expect no** | expect yes | expect yes | See "Firefox" below. |
| 6 | Safari, iOS (iPhone) | expect yes | expect yes | check | Also checks the safe-area insets. |
| 7 | Chrome, Android | expect yes | expect yes | check | |
| 8 | Usernode app WebView, iOS | check | check | check | The mic row is the one to read. |
| 9 | Usernode app WebView, Android | check | check | check | |

### Per-row procedure

1. Open `/admin/compat`. Record every row of `#compat-table`.
2. Open `/demo`. It needs no microphone, no room and no AI budget, so it is
   the fastest way to see whether captions render and whether the device
   speaks them. Confirm captions appear and the reading voice starts. Then:
   switch the watching language to Japanese and confirm the captions redraw
   in it, switch to the townhall script and confirm the roster groups by
   language rather than by person, and open `/demo?play=0` to check the
   finished call renders in one paint with nothing still spinning.
3. Create a real room from the lobby, pick Bahasa Indonesia as what you speak
   and English as what you hear (swap on the second device).
4. Speak three sentences containing a protocol noun ("validator", "seed
   phrase", "RPC") and a number. Confirm the noun and the number survive
   verbatim in the translation.
5. Type one caption in the composer. Typed input must work on every row of
   the matrix, including the ones with no microphone.
6. Turn the device's network off for fifteen seconds mid-call, then on.
   Captions must catch up without a reload and without duplicates.
7. Switch listening mode through all three values (translation, original,
   both). Confirm the audio follows.
8. Leave the call, then submit `/feedback` from the ended screen.
9. Back on `/demo`, press **Try it with your own voice** and confirm it opens
   a practice call of your own. Pressing it a second time must return to the
   same room rather than making another one.

## What each compat probe means for this checklist

| `/admin/compat` row | Cross-references |
|---|---|
| Speech recognition | Rows 1-9, step 4. A `no` here means the tester uses the typed composer for the whole session and the row is still valid. |
| Microphone reachable | The one probe that can report "cannot ask" rather than yes/no. See below. |
| Speech synthesis | Step 2 and step 7. |
| Voice for each launch language | A device with no Indonesian voice falls back to text for Indonesian captions. Record which languages had no voice; that is the input to which languages we can promise audio for. |
| Audio context / ducking | Step 7 with both modes on. |
| Local storage | Refusal here means preferences do not persist between visits, which shows up as "it forgot my language" in feedback. |
| Long poll | Records the last observed hold in milliseconds. A hold much shorter than the server's 8 s ask means something between the device and the app caps request duration; captions still arrive, just a tick later. |
| Safe-area insets | Rows 6-9 only. A zero here on a notched phone means the bottom bar will sit under the home indicator. |

## Firefox

Firefox implements no Web Speech recognition at all. Not a bug in this app,
not something a permission grants: the API is absent. So on row 5 the app
must fall back cleanly to the typed composer, and the compat screen must say
why rather than showing a dead microphone button. Test that it does. Firefox
users are first-class readers and typists, they are just not speakers.

## The microphone finding

The platform delegates exactly three capabilities to an app frame:
`geolocation`, `clipboard-write` and `pointer-lock`. Microphone is not among
them. An undelegated capability does not produce a distinct error and does not
prompt, it rejects in a couple of milliseconds with `PERMISSION_DENIED`, which
is the identical code a browser uses when a person taps "block".

So on rows 8 and 9 in particular, expect the compat screen to report the
microphone as unreachable in the frame rather than as denied by the user, and
expect the typed composer to be the visible primary input. Do not tell testers
to check their device permissions when this happens. It is not their setting.
It has been escalated to the platform as a missing capability; until it is
delegated, typed input is the supported path inside the Usernode app.

## Recording results

One row per device in the pilot tracker, with: the compat screenshot, which
steps passed, and any caption that came out wrong (source language, target
language, what was said, what appeared). Caption text goes in the tracker, not
in a GitHub issue, and never in a diagnostic snapshot.
