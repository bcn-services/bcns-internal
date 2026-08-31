# Engineer Report
**Task:** item 12 — `jobs/poll.mjs`, the reply poller and parser
**Branch:** item/0008-places (existing worktree, not re-created)
**Date:** 2026-08-31
**Gate:** `pnpm test` → `# tests 180 / # pass 180 / # fail 0 / # skipped 0` (baseline 131; +49, nothing deleted or weakened)
**Uncommitted (orchestrator commits):** jobs/poll.mjs, tests/poll.test.mjs, jobs/run.mjs, lib/db.mjs, package.json

## Design Decisions
- Opt-out is a pure regex pass (`isOptOut`) that runs and commits `db.suppress` before the classifier is ever reached — no classifier construction, call or result can cost a suppression.
- `isOptOut` is weighted for recall: 17 patterns, plus bare `not interested`, on the argument that a false positive is visible (the suppression is also forwarded to both humans) and a false negative never is.
- `stripQuoted` is deliberately narrow (5 cut markers) — over-eager stripping deletes the sentence that would have matched an opt-out, which is this item's stated failure mode.
- Auto-replies are caught by header (`Auto-Submitted`) and regex before the classifier, so an OOO spends no Claude call and moves no stage.
- `ADVANCED_STAGES` guard: a late prospect reply never walks `meeting/quoted/won/lost` back to `replied`.
- Sender allow-listing reuses `assertAllowed`/`RecipientRefused` from touch.mjs rather than a second normalisation; an empty list honours nobody.
- Forward path reuses touch.mjs `buildMime`/`assertAllowed` + template.mjs `toHtml`/`SIGNATURE`; a forward writes its `events` row first and mails second, so SMTP being down never drops a message.
- `DRY_RUN` on writes nothing and leaves messages unread (`would_suppress`/`would_reply`/`would_command`), matching touch.mjs.

## Files Changed
- `jobs/poll.mjs` — new: `stripQuoted`, `isOptOut`, `isAutoReply`, `parseCommand`, `threadIds`, `readCategory`, `isAllowedSender`, `createNotifier`, `run(deps)`.
- `lib/db.mjs` — added `threadByMessageIds` (ordered by `array_position`, so In-Reply-To beats References) and `businessById` (through the view).
- `jobs/run.mjs` — added `createImap` (ImapFlow + mailparser, `pipeline` label, unseen only) wired as `deps.imap` when `IMAP_PASS` is set, plus `notifyFrom` / `outreachAddress`.
- `package.json` — `tests/poll.test.mjs` appended to the explicit `test` file list.
- `tests/poll.test.mjs` — new: 49 tests, all driving `run()` for every side-effect and no-side-effect assertion.

## Verification
- Ordering proven by execution, not comments: `classify` throws → `suppressed_at` still set, `updates` empty.
- Every opt-out/allow-list assertion is a literal; `NO_ANSWER_DAYS === 2` and `ADVANCED_STAGES` are separately pinned to literals so mutating a constant fails the suite.
- Fixtures use the real `email_threads` columns `touch.mjs` writes (`message_id`, `business_id`, `direction`, `mailbox`, `subject`) and the real `businesses` columns from `0018_pipeline.sql`.

## Deferred / Out of Scope
- `notify` job (item 13) — `createNotifier` is exported for it to reuse rather than a second deliver path.
- The IMAP adapter itself is untested (a real boundary, no live connection permitted); everything downstream is a pure function of the plain objects it yields.
- No migration touched; nothing applied to any database.

## Flags for Reviewer
- `not interested` as a bare opt-out trigger is a deliberate recall-over-precision call — worth a second opinion.
- Classifier failure still sets `stage=replied` (sequence stops) in addition to forwarding; the alternative is leaving the row mailable.
- `client.fetch({ seen: false })` is unbounded — a large backlog is one long tick; a `limit` belongs here if the label ever fills.
- Forward fan-out is one send per allow-listed recipient per message; a batch of opt-outs is a burst of internal mail.
