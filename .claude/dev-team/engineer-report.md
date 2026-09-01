# Engineer Report
**Task:** Split `NOTIFY_ALLOWED_RECIPIENTS` into a send list and an internal list; give `personalize` a cron cell
**Branch:** `outreach-pipeline` (main checkout — no worktree, per the task brief)
**Date:** 2026-08-31

## Design Decisions
- `deps.allowedRecipients` now reads `SEND_ALLOWED_RECIPIENTS` and is consumed only by `touch`'s `deliver` gate; `deps.internalRecipients` reads `NOTIFY_ALLOWED_RECIPIENTS` and is consumed only by `poll`/`notify` forwarding and `isAllowedSender`.
- Renamed the parameter in `poll`/`notify`/`createNotifier` to `internalRecipients` rather than leaving both names live, so a caller that passes the wrong list is a missing-parameter bug (empty = fail closed) instead of a silent widening.
- `assertAllowed(to, allowed, listName = 'SEND_ALLOWED_RECIPIENTS')` — the default serves `touch`, the only caller that passes nothing; the two internal call sites pass `'NOTIFY_ALLOWED_RECIPIENTS'` so a refusal always names the variable the operator must edit.
- Both lists parse through one local `list()` helper in `buildDeps` and both fail closed when unset — unset is nobody, never everybody.
- `personalize` is scheduled `'30 13 * * 1-5'` (weekdays, not Mondays only) so a draft that failed validation gets a retry tick rather than waiting a week.
- The `clock.yml` drift test is table-driven both ways (every cron has a `SCHEDULES` key, every `SCHEDULES` key has a cron) instead of a pinned three-item list, since a pinned list is what let `personalize` go unscheduled.

## Files Changed
- `jobs/run.mjs` — added the `'30 13 * * 1-5': 'personalize'` schedule; split the recipient env parse into `SEND_ALLOWED_RECIPIENTS` → `allowedRecipients` and `NOTIFY_ALLOWED_RECIPIENTS` → `internalRecipients`, both fail-closed.
- `jobs/touch.mjs` — `assertAllowed` takes a `listName` third parameter (default `SEND_ALLOWED_RECIPIENTS`) so the refusal text names the right variable.
- `jobs/poll.mjs` — `createNotifier`, the forward loop and `isAllowedSender` now take `internalRecipients`; both internal `assertAllowed` calls pass `'NOTIFY_ALLOWED_RECIPIENTS'`; header comment rewritten to say the command list is the internal one and explicitly not the send list.
- `jobs/notify.mjs` — `run` takes `internalRecipients`; header comment names both lists.
- `.github/workflows/clock.yml` — added `- cron: '30 13 * * 1-5'   # personalize` and `SEND_ALLOWED_RECIPIENTS: ${{ vars.SEND_ALLOWED_RECIPIENTS }}` (no value set anywhere).
- `LANE.md` — corrected the four places that named `NOTIFY_ALLOWED_RECIPIENTS` as `touch`'s send gate; marked both findings FIXED with what replaced them.
- `tests/clock.test.mjs` — replaced the pinned three-cron assertion with the two-way drift test; added the `personalize` dispatch assertions and a `buildDeps` test covering both lists set, each unset independently, and both unset.
- `tests/touch.test.mjs` — `assertAllowed` message assertions moved to `SEND_ALLOWED_RECIPIENTS` plus an explicit `listName` case; new tests that an internal-only address cannot be mailed by `touch` and that an empty send list refuses however full the internal list is.
- `tests/poll.test.mjs` — harness passes `internalRecipients`; new tests that a prospect on the send list has `won 2400` forwarded rather than honoured and receives no forward, and that an empty internal list forwards to nobody and records an error.
- `tests/notify.test.mjs` — harness and `createNotifier` calls pass `internalRecipients`; new tests that internal mail goes only to the internal list and that an empty internal list mails nobody.
- `tests/pipeline.test.mjs` — the end-to-end run now keeps the two lists disjoint (prospects on the send list, the teammate on the internal list), which is the live-pilot shape.

## Deferred / Out of Scope
- `docs/NOTIFICATIONS.md` — its `NOTIFY_ALLOWED_RECIPIENTS` references are all about internal notification delivery and stay correct. The file is otherwise stale against a different codebase (`email_outbox`, `lib/agent/verbs/types.ts`, `tests/mailer-smtp.test.mjs` — none exist here); rewriting it is its own item.
- The other four LANE findings from the 2026-08-31 run (notify batch threading, the dedupe key not re-arming, `mailboxes.sent_today` never resetting) are untouched.
- `buildDeps` still supplies no `readVoiceRules`, so a scheduled `personalize` run logs `skipped: no voice rules reader injected` and falls back to the fixed blocks. Pre-existing, not introduced here, but it is the next thing to fix if the 13:30 cell is meant to produce voiced drafts.

## Flags for Reviewer
- `touch` still burns a mailbox slot before the refusal is recorded (`claim()` runs after `assertAllowed`, but the claimed row is counted) — pre-existing, asserted by an existing test.
- `poll`'s forward loop mails every internal recipient in series inside the message drain; a slow SMTP hop multiplies by the list length against the 20-minute tick.
- `assertAllowed`'s `listName` is a plain string with no enum; a future third caller can pass a variable name that does not exist.
- Two repo variables now have to stay in step with the workflow; nothing asserts that `clock.yml` exports every env var `buildDeps` reads.
