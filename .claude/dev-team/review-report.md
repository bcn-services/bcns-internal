# Review Report — DELTA
**Branch:** item/0008-places
**HEAD:** cf32895 (tree at 8e84198; LANE.md/LANE_PROGRESS.md only, no code delta)
**Scope:** delta cd3d6bb..cf32895
**Files Reviewed:** 2 code (`jobs/run.mjs`, `jobs/poll.mjs`) + 2 test files by report
**Dimensions Swept:** Correctness/false-negative clean-except-below · Fault tolerance 2 findings · Concurrency/idempotence clean · Security (secrets, spoofing) clean · Dependencies clean (`imapflow`,`mailparser`,`nodemailer`,`postgres` only; package.json diff is the test list) · Efficiency clean · Over-Engineering 1 informational

## Prior findings
CONFIRMED FIXED — CRITICAL html-only body — `jobs/run.mjs:183` + `jobs/poll.mjs:351`; verified `htmlToText` by execution, not by report.
CONFIRMED FIXED — IMPORTANT subject in opt-out match — `jobs/poll.mjs:332` (`isOptOutMessage`); see new finding N3 for its cost.
CONFIRMED FIXED — IMPORTANT missing classifier — `jobs/poll.mjs:367` `degraded` event + unconditional forward.
CONFIRMED FIXED — IMPORTANT 4 new patterns — `jobs/poll.mjs:78-85`, list is 21, verified live.
CONFIRMED FIXED — IMPORTANT empty allow-list — `jobs/poll.mjs:251-266` `error`/`errors++`, no `forwarded` event, no send.
CONFIRMED FIXED — IMPORTANT unbounded fetch — `jobs/run.mjs:194` `MAX_MESSAGES_PER_TICK = 100`, `drainMessages` caps.
CONFIRMED FIXED — 4 Minor: notes `new Set` (`poll.mjs:432`), full-address routing (`poll.mjs:308`), `logout()` on failed lock (`run.mjs:222`), `forwarded++` after delivery (`poll.mjs:280`).

## markSeen reversal — assessment
The reversal is right; I withdraw the ordering half of my original finding. Against an invisible false negative, an at-least-once queue is the correct shape and a duplicate forward is a visible, self-correcting cost.
No re-apply or double-send path beyond the accepted duplicate forward: `db.suppress` is guarded, stage patches are absolute SETs, and the `Set` closes the only append. The gap QA's sequential replay cannot see is not idempotence, it is *termination* — see N2.

## Findings (new)

### Critical
CRITICAL — jobs/run.mjs:185 — `String.fromCodePoint(Number(...))` throws `RangeError` on an out-of-range numeric entity (`&#x110000;`, `&#99999999999;`), verified by execution. The throw is raised inside `drainMessages`, i.e. `client.messages()` at `jobs/poll.mjs:288`, which sits in a `try`/**`finally`** with no `catch` — it escapes `run()`, so no message in the mailbox is processed, nothing is marked seen, and every subsequent tick re-fetches the same message and dies again. Any sender can permanently stall the entire opt-out pipeline with one entity. — Fix: guard the decode, `const n = Number(...); return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m` (this also drops the lone-surrogate output `&#xD800;` currently produces).

### Important
IMPORTANT — jobs/run.mjs:158,170 — the `ponytail:` claim at `jobs/run.mjs:177` that an unclosed `<style>` is additive noise that "cannot cause a MISS" is FALSE, and it fails in the deleting direction. The pair strip `/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi` is non-greedy and unbalanced-open-tolerant: `<style>a{}<div>please remove me from your list</div><style>b{}</style><p>ok</p>` → `"ok"` — the body is DELETED, the opt-out is silently missed. The comment strip has the identical bug: `<!--x<div>remove me from your list</div><!-- y --><p>ok</p>` → `"ok"`. Both verified by execution. — Fix: forbid crossing a second opener — inner `(?:(?!<\1\b)[\s\S])*?` for the tag pair and `(?:(?!<!--)[\s\S])*?` for comments — then correct the comment at `jobs/run.mjs:177` (the attribute-`>` half of it I confirmed genuinely additive).
IMPORTANT — jobs/poll.mjs:316 — with markSeen last there is no attempt counter and no dead letter: a message whose handling throws deterministically (the N1 crash, an oversized body, a DB constraint) is retried every tick forever, re-sending its forward to every allow-listed human on each one. "The next tick retries it" is unbounded, and the failure is loudest exactly when a human can least act on it. — Fix: after N failed attempts on a uid, mark seen and log a distinct `dead_letter` event instead of retrying (a uid→count map on the tick result, or a `poll_failures` column; the lazy version is to markSeen on the second consecutive failure for the same uid).
IMPORTANT — jobs/poll.mjs:332 — folding the subject into the match makes the bare-`stop`-line pattern (`poll.mjs:76`) reachable from ordinary subject lines: `isOptOutMessage({subject:'Stop by the office Thursday!'})` → `true`, verified. That silently and permanently suppresses a live prospect, and unlike the pattern-list precision losses QA logged, this one is created by this delta rather than merely exposed by it. — Fix: `stop\b(?![ \t]+(?:by|in|over|round))` on that one pattern.

### Minor
MINOR — jobs/run.mjs:178 — closing inline tags up trades one miss for another: `<b>un</b>subscribe` now matches, but `<b>Remove</b><i>me</i> from your list` → `"Removeme from your list"`, which `\bremove\b` misses. Close-up is the browser-correct semantic (the sender sees "Removeme" too), so this is the right side of the trade — recording it so the classifier backstop is understood to be carrying it. — Fix: none required.
MINOR — jobs/run.mjs:150 — the unbalanced-tag scan is O(n²) on a large html body with no closing tag; irrelevant at reply sizes, noted only so the N2 fix is not sized for it. — Fix: none.

### Over-Engineering (informational, non-gating)
INFO — jobs/run.mjs:156 — `lsquo`/`ldquo`/`rdquo` earn nothing: no pattern matches on a double quote or an opening single quote, and `rsquo` alone closes the measured gap. Three dead map entries. — Fix: keep `rsquo`, drop the other three, or leave them; either is fine.

## Secrets
Clean. `IMAP_PASS`/`SMTP_PASS` stay inside `createImap`/`createTransport` config at `jobs/run.mjs:113-140` and reach no event, log or error string. The new `degraded` and `error` paths log only `stage`, `reason`, `from`, `subject`, recipient and `err.message`.

## STANDARDS.md Updates
none — no file created at the repo root, by instruction.

Critical: 1 | Important: 3 | Minor: 2
Prior findings not fixed: 0
