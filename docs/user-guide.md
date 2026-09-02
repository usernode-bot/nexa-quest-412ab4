# Using LIVE TRANSLATION

You speak your language. The other people hear it in theirs. That is the whole
product; everything below is detail.

## Starting a call

1. Open the app and pick what the call is for. There are four kinds, and the
   choice sets the room size and how the floor works:
   - **Onboarding** — walking someone through setup.
   - **Support call** — one agent, one user, two languages.
   - **Validator room** — several operators, three can hold the floor at once.
   - **Global townhall** — one speaker, a large audience listening.
2. Pick the language you speak and the language you want to read and hear.
   They can be the same; plenty of people join a call to listen.
3. Press start. You get a six-letter room code. Send it to whoever is joining.

## Joining a call

Enter the code on the lobby screen, pick your two languages, and join. You can
change either language mid-call from the language sheet; captions from that
point on follow the new choice.

## Not sure yet? Try the demo

There is a **Try the demo** button on the lobby. It replays a scripted
Indonesian and English conversation through the real caption and audio path,
with no room, no microphone and no cost. It is the fastest way to see what the
product does, and the fastest way to find out whether your device can speak
captions out loud.

## Speaking

Press the microphone and talk normally. A caption appears for you as you go
and for everyone else in their own language, usually within a second or two of
you finishing a phrase.

A few things worth knowing:

- **Finish your phrases.** The app translates when your browser decides you
  have stopped, so a trailing sentence left hanging sits there unsent.
- **Pause between speakers.** In a group room only three people can hold the
  floor at once, and in a townhall only the host speaks. Raise your hand and
  you will be let in.
- **Technical words are kept as they are.** UserNode, validator, staking, seed
  phrase, RPC, gas, slashing, epoch, mempool, and every number, version and
  address survive translation untouched. A translated wallet address is a lost
  wallet, so the app does not translate them.

## Typing instead of speaking

There is a text composer next to the microphone, and it is a first-class way
to use the app, not a fallback for failure. Use it when:

- You are somewhere you cannot talk.
- Your browser has no speech recognition. Firefox has none at all.
- You are inside the Usernode mobile app, where the microphone is currently
  not available to apps. The composer will be the primary input there and the
  app will say so.

Typed captions translate exactly like spoken ones.

## Listening

Three listening modes, in the language sheet:

- **Translation** — you hear only the translated caption.
- **Original** — you hear only the original speaker.
- **Both** — the default: the original is quietened under the translation.

Captions are spoken clause by clause as soon as each clause is finished, which
is why the voice starts before the whole sentence exists. A clause is never
read aloud until it can no longer change, so you will not hear the app correct
itself mid-word.

If your device has no voice for a language, that caption is shown as text and
says so. Nothing is lost, you just read it.

## When something does not work

- **A caption says translation is unavailable.** Either the app has no AI
  access in this environment, or you have not granted it, or your daily AI
  budget for this app is spent. The original text is always still there, and
  you can keep talking.
- **Captions stop arriving.** Do not reload. The app reconnects on its own and
  catches up from where it left off. Reloading works too, it is just slower.
- **The voice does not start.** The caption stays on screen and marks itself
  as not read aloud. Check your device volume and whether another tab is using
  the speaker.
- **Anything else.** Open the console icon in the platform header and send us
  what it shows in red, plus the room code and roughly what time it was.

## After the call

Leave the call and you will be asked how it went. It takes under a minute and
it is the main way the four use cases above get better. Say what actually
happened, including the caption that came out wrong.

## Privacy

What you say in a call is stored for 72 hours so late joiners and reconnects
can catch up, then deleted. It is never copied into a preview environment, it
never appears in a bug report, and the diagnostics the app collects are
capability flags and timings only, never words.
