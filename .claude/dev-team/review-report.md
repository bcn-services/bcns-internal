# Review Report
**Branch:** item/0008-places
**Commit:** cd3d6bb
**Date:** 2026-08-31
**Files Reviewed:** 5 (jobs/poll.mjs, jobs/run.mjs, lib/db.mjs, tests/poll.test.mjs, package.json)
**Dimensions Swept:** Efficiency (1) · Reliability (2) · Scalability (1) · Safety & Security (1) · Fault Tolerance (3) · Data Integrity (4) · Over-Engineering (2, informational)

## Findings

### Critical
CRITICAL — jobs/run.mjs:180 — Data Integrity — `text: parsed.text ?? ''`: mailparser only html→text converts when the html node is root or a text/plain part exists (`node_modules/mailparser/lib/mail-parser.js:806`), so a `multipart/related` html-only reply (Outlook/Gmail reply carrying an inline image) yields `parsed.text === undefined` → empty body → `isOptOut` false, `isAutoReply` false, classifier sees an empty reply → `stage=replied`, no suppression, no forward. Exactly this item's invisible false negative. — Fix: `text: parsed.text || htmlToText(parsed.html ?? '')` (`html-to-text` is already a mailparser dependency), and in `handleProspect` forward any message whose stripped body is empty instead of classifying it.

### Important
IMPORTANT — jobs/poll.mjs:297 — Data Integrity — `isOptOut(message.text)` never inspects the subject, though `isAutoReply` does (line 101); a subject-only "UNSUBSCRIBE" / "Re: … STOP" with an empty or unrelated body is missed. — Fix: `isOptOut(`${message.subject ?? ''}\n${message.text ?? ''}`)`.
IMPORTANT — jobs/poll.mjs:313 — Reliability — with no `ANTHROPIC_API_KEY`, `claude` is null and the job proceeds silently with the regex as its sole opt-out defence; the five phrasings below become true false negatives with no signal anywhere. — Fix: log a `skipped`/`degraded` event when `claude` is null and forward every unclassified prospect reply for a human.
IMPORTANT — jobs/poll.mjs:59-77 — Data Integrity — measured `OPT_OUT_PATTERNS` recall gaps: "we don't want any more emails", "Please remove this email address from your distribution", "Please remove from your list", "Please cease all communication", "Please do not send us anything further". — Fix: add `/\bremove\b[^\n]{0,40}\b(list|distribution|database|mailing)/i`, `/\bcease\b[^\n]{0,20}\b(communication|contact)/i`, `/\bdo ?n[o']?t (?:want|need)\b[^\n]{0,25}\b(?:e-?mails?|contact)/i`, `/\b(?:do ?n[o']?t) send\b[^\n]{0,25}\b(?:anything|any)\b[^\n]{0,15}\b(?:further|more|else)/i`.
IMPORTANT — jobs/poll.mjs:239 — Reliability — `forward` loops over `allowedRecipients`; an empty or misparsed `NOTIFY_ALLOWED_RECIPIENTS` sends nothing, yet `result.forwarded` still increments and the event says `forwarded`. Every "needs a human" message — including unmatched opt-outs — reaches no human. — Fix: when the list is empty, log `error` with `reason: 'no allow-listed recipient'` and count it as an error, not a forward.
IMPORTANT — jobs/run.mjs:169 — Scalability / Fault Tolerance — `client.fetch({ seen: false })` is unbounded and the job takes no lock; a backlog can run past the 20-minute cron, so two pollers process the same unseen messages → duplicate forwards and duplicate `notes` appends. — Fix: cap the fetch (`limit`, e.g. 100) so a tick is bounded, and mark seen before handling rather than after.

### Minor
MINOR — jobs/poll.mjs:378-384 — Fault Tolerance — `notes` appends unconditionally; a message re-processed because the handler threw before `markSeen` (line 279) duplicates the note. — Fix: dedupe the appended note against the existing array.
MINOR — jobs/poll.mjs:271-273 — Safety & Security — routing falls back to a bare local-part comparison, so `Delivered-To: bot@anything.example` takes the teammate path and `outreach@anything.example` the prospect path. — Fix: compare full addresses only; anything else already falls through to `forward`.
MINOR — jobs/run.mjs:165 — Fault Tolerance — `getMailboxLock` is acquired inside `imap()`; if anything between it and the caller's `finally` throws, the lock and the IMAP connection leak until the process exits. — Fix: wrap the post-connect setup in try/catch and `client.logout()` on failure.
MINOR — jobs/poll.mjs:238 — Efficiency — `result.forwarded++` fires before any send is attempted, so the returned counter reports delivery the job did not achieve. — Fix: increment on a successful `send`.

### Over-Engineering (informational, non-gating)
OVER-ENG — jobs/poll.mjs:195-205 — `parseResearch` is duplicated verbatim from `jobs/touch.mjs:98`. — Fix: export it from touch.mjs and import.
OVER-ENG — jobs/poll.mjs:145 — `createNotifier` is generalised for item 13's reuse and is speculative until 13 lands; ceiling is a second deliver path if 13 diverges.

## QA Findings Adjudicated
- QA #1 (regex recall gaps) — **Important**, see poll.mjs:59-77 above. Not Critical: a matched-thread reply still sets `stage=replied`, which removes the row from `dueTouches` (lib/db.mjs:174) and from `personalize`'s `stage='qualified'` selection, so the sequence stops anyway. The residual harm is that `suppressed_at` is never written — the row stays in `selectable_businesses` and the opt-out record required to defend a future re-source or re-import does not exist.
- QA #2 (no classifier ⇒ regex is sole defence) — **Important**, see poll.mjs:313 above. Same bounded harm, but silent: nothing in the events stream says the second line of defence was absent for that tick.

## Known Failure Families — Checked
- Producer/consumer field mismatch: **clean**. mailparser's `ensureMessageIDFormat` (mail-parser.js:373-391) restores `<>` on both `inReplyTo` and every `references` entry, matching the `<uuid@bcn-services.com>` form `db.recordThread` stores and the `/<[^>]+>/g` `threadIds` extracts.
- Assertion pinned to an exported constant: **clean**. QA pins `NO_ANSWER_DAYS`/`ADVANCED_STAGES` to literals in a dedicated test.
- Negative side effect re-derived from adapter calls: **clean**. Every "changes nothing" assertion drives `run(deps)`.
- Secrets in logs/events/errors: **clean**. `IMAP_PASS`/`SMTP_PASS` reach only the client constructors; `logger: false`; no error path interpolates them.
- `NOTIFY_ALLOWED_RECIPIENTS` parsing: **clean**. run.mjs:105 trims and `filter(Boolean)`; `assertAllowed` lowercases both sides; empty string ⇒ nobody allowed; QA covered display-name and `.com.evil.example` lookalikes.

## STANDARDS.md Updates
Created `STANDARDS.md` at the project root — Jobs (skipped-event on missing dependency, `would_<verb>` dry-run event naming, record-before-send), Safety gates (one allow-list implementation, suppression precedes judgement, reads through the view), Tests (drive `run()` for negatives, literal assertions with constants pinned separately, register new test files in `package.json`).

Critical: 1 | Important: 5 | Minor: 4
