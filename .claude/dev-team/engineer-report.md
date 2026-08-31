# Engineer Report — fix pass
**Branch:** item/0008-places
**Date:** 2026-08-31
**Gate:** `pnpm test` → `# tests 220` / `# pass 220` / `# fail 0` / `# skipped 0` (floor was 204). `pnpm lint` clean.
**Files changed:** `jobs/run.mjs`, `jobs/poll.mjs`, `tests/poll.test.mjs`, `tests/run-imap.test.mjs` (new, registered in package.json), `package.json`

CRITICAL html-only reply yields empty body — FIXED at jobs/run.mjs:158 (`htmlToText`, no new dependency: tag-strip helper in-repo) + jobs/run.mjs:183 (`text: parsed.text || htmlToText(parsed.html)`) + jobs/poll.mjs:351 (empty stripped body forwards instead of classifying) — tests/run-imap.test.mjs "an html-only message with no text field still yields a readable body" / "an unreadable html body yields an empty string"; tests/poll.test.mjs "review: an html-only reply with no text part still suppresses on an opt-out" and "…whose body reads empty is forwarded, never classified" (both drive `run(deps)` with a `toMessage`-built fixture that has html and NO text field).
IMPORTANT opt-out ignores the subject — FIXED at jobs/poll.mjs:332 via `isOptOutMessage` (subject + body) — "review: a subject-only UNSUBSCRIBE suppresses".
IMPORTANT no classifier is silent — FIXED at jobs/poll.mjs:367 (`degraded` event + forward every unclassified prospect reply) — "review: with no classifier the job says so and forwards the reply for a human".
IMPORTANT five regex recall gaps — FIXED at jobs/poll.mjs:78-85 (4 added patterns) — "review: the five measured recall gaps now match on the keyword pass" (each phrasing pinned as a literal, each also driven through `run(deps)` to a real suppression; a benign reply asserted still not an opt-out).
IMPORTANT empty allow-list forwards to nobody — FIXED at jobs/poll.mjs:251-266 (`error` + `errors++`, no `forwarded` event) — "review: an empty allow-list logs an error, not a forward nobody receives".
IMPORTANT unbounded fetch, no lock — FIXED at jobs/run.mjs:194 (`MAX_MESSAGES_PER_TICK = 100`, `drainMessages` caps a tick) + jobs/poll.mjs:316 (markSeen ordering, see the reversal section) — tests/run-imap.test.mjs "one tick drains at most MAX_MESSAGES_PER_TICK messages" (+ `assert.equal(MAX_MESSAGES_PER_TICK, 100)`); "review: a handler that throws leaves the message unseen, and the retry does not double-apply".
MINOR notes re-append on reprocess — FIXED at jobs/poll.mjs:430 (`new Set`) — "review: the same note re-processed twice is stored once".
MINOR local-part routing fallback — FIXED at jobs/poll.mjs:308-312 (full-address compare only) — "review: a bare local-part Delivered-To takes no privileged path".
MINOR mailbox lock leaks if setup throws — FIXED at jobs/run.mjs:222-228 (`logout()` on a failed `getMailboxLock`) — no test: guard is on a live-IMAP-only path, untestable without a connection.
MINOR `forwarded++` before any send — FIXED at jobs/poll.mjs:280 (increments only after a successful send) — "review: a forward nobody accepted is not counted as delivered".

## Notes
- One pre-existing test was RETARGETED, not weakened: `qa: the classifier is the backstop when the regex misses the phrasing` asserted `isOptOut("we don't want any more emails") === false`, which finding 3 deliberately reverses. It now pins an equally-unmatched phrasing (`Kindly refrain from further correspondence`) and still proves the classifier backstop end to end.
- No new dependency added; `html-to-text` deliberately NOT imported (mailparser transitive only).
- markSeen ordering: see `## markSeen reversal` below — the initial fix pass marked seen first; that was reversed on adjudication.

## markSeen reversal
- REVERSED per orchestrator adjudication: `markSeen` is back AFTER the handler returns — `jobs/poll.mjs:316` (the call lives in poll.mjs's message loop, not run.mjs). A handler that throws now leaves the message unseen and the next tick retries it; a duplicated forward is visible, a dropped opt-out is not.
- `MAX_MESSAGES_PER_TICK = 100` stands, untouched (`jobs/run.mjs:194`).
- No second dedupe mechanism added: the Minor `notes` fix at `jobs/poll.mjs:432` (`new Set`) already makes the only non-idempotent re-apply safe. Stage moves and `db.suppress` are idempotent by construction, so a retried message double-applies nothing. `email_threads.message_id` needs no new use.
- Test retargeted, not weakened: `review: a handler that throws leaves the message unseen, and the retry does not double-apply` — drives `run(deps)` twice with a `logEvent` that throws once after the `notes` patch has landed; asserts tick 1 leaves `seen` empty with one error and the note stored once, and tick 2 marks it seen with the note still stored exactly once.
- Gate after the reversal: `pnpm test` → `# tests 220` / `# pass 220` / `# fail 0` / `# skipped 0`. `pnpm lint` clean.
