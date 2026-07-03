# NEXA QUEST — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About NEXA QUEST

NexaQuest is a lightweight Web3 quest, loyalty, reward & identity hub:
users complete daily quests and campaigns, earn XP/levels/streaks and
soulbound-style badges, and redeem points for rewards. Positioning is
"a modern Web2 loyalty app that happens to run on Web3" — clean,
premium, beginner-friendly. The full product spec lives in the
session's spec doc; the repo implements it slice by slice.

## App-specific conventions

- UI is bilingual (Bahasa Indonesia default, English optional). All
  static UI copy goes through the `t(key)` helper in
  `public/index.html` — every new UI string must be added to BOTH the
  `id` and `en` dictionaries in the same change.
- Language preference is stored per user in `user_profiles.language`
  (`'id'`/`'en'`, default `'id'`), updated via
  `PATCH /api/profile/language`, with localStorage as a display cache.
- `user_profiles.total_xp` is derived from `xp_transactions` (the
  source of truth) — always award XP through the `awardXp` helper in
  `server.js`, never by writing the counter directly.
- Staging-private tables (schema-only in staging): `referrals`,
  `reward_redemptions`, `wallet_reputation_history`,
  `campaign_budgets`. Budgets are split out of `campaigns` on purpose
  so campaign titles/status stay public for the Explore UI.
- `user_badges` is non-transferable by design: no transfer column, no
  transfer endpoint — keep it that way.
- Visual direction: clean/premium, dark mode default, indigo accent,
  line icons, no neon/AI-gradient look. Avoid new dependencies for
  cosmetic features (i18n is hand-rolled on purpose).
- Frontend is a path-routed vanilla-JS SPA in `public/index.html`;
  the server's catch-all serves the shell for any authenticated GET.
