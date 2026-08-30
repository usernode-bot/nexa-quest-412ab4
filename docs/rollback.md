# Rollback

## What rollback is on this platform

A revert PR. That is the whole mechanism, and it is worth being precise about
what it does and does not undo.

The platform rebuilds the production container on every merge to `main`.
There is no deploy step this repo controls, no previous image to pin, no
blue/green switch and no "roll back to build 47" button. To undo a change you
open a proposal that reverts the commit, it goes through the same vote and the
same merge-gating checks as any other proposal, and the merge redeploys
production from the reverted tree.

Two consequences follow, and they shape how every migration in this repo is
written.

## The database is not reverted

The revert changes the code. The database keeps whatever the forward
migration did to it. So a migration that dropped a column would leave the
reverted code reading a column that no longer exists, and rollback would take
the app from broken to more broken.

Hence the rule, which is not a style preference:

- **Migrations only ever add.** `CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- **Never drop a column or a table. Never rename one.** A rename is a drop
  and an add wearing a disguise.
- **Never narrow a type or add a `NOT NULL` without a default.** Old code
  that is still running mid-deploy, and reverted code that runs after, both
  have to be able to write the old shape.
- A column that is genuinely dead stops being written and stops being read.
  It stays in the schema. The cost of a dead column is a line in
  `lib/schema.js`; the cost of dropping one is an outage you cannot revert
  out of.

Retention does the cleanup that dropping would: utterances and translations
are pruned at 72 hours, latency samples at 7 days, error events at 14 days.

## No merged test may be deleted

`dapp.json` tests accumulate across proposals and gate every future merge. A
revert that deletes tests removes the evidence that the thing it is reverting
was ever broken, and quietly lowers the bar for everything after it.

If a reverted feature's test now fails because the feature is gone, that is
the revert being incomplete, not the test being wrong. Either the revert
should also remove the feature's route (in which case the test goes with the
feature in the same commit, which is a deletion the proposal is explicitly
about) or the test should keep passing. Deleting a test to make a revert green
is never the answer.

## Procedure

1. **Decide it is a rollback and not a fix.** A rollback is right when the
   change is wrong in a way you do not yet understand, or when the fix would
   take longer than the outage is acceptable for. A one-line fix forward is
   usually better and is always faster to reason about.
2. **Open the revert proposal.** `git revert <sha>` produces the commit.
   Title it so a voter can tell what is being undone without reading a diff.
3. **Say what broke, in the proposal body.** One paragraph: what users saw,
   which screen, which alert fired. This is the only record that will exist.
4. **Let the checks run.** A revert is subject to the same merge gate. If the
   checks fail on the revert, the revert itself is wrong.
5. **Ask an app admin to force-merge only if people are actively affected.**
   Force-merge exists for that and is visible in the merge log either way.
6. **Confirm.** `/health` returns the older `version`. `/admin/alerts` clears
   within two evaluation cycles, so give it ten minutes before believing it.
7. **Write the follow-up.** A revert with no follow-up issue is a change that
   will be made again by someone who did not know.

## What cannot be rolled back this way

- **Data already written.** Captions, feedback rows, alert history. Retention
  clears them on its own schedule; nothing else does.
- **A secret value.** Changing `LT_ADMIN_USERNAMES` is a separate action in
  the Secrets UI (or a `secret_change` proposal) and takes effect on the next
  deploy, not on the revert.
- **A platform-side problem.** If the bridge, the LLM proxy or the build
  pipeline is what broke, reverting this repo changes nothing. Escalate with
  `usernode-report-platform-issue` instead.
