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
