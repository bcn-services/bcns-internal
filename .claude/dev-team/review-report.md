# Review Report — DELTA (2026-08-31)
**HEAD:** 3a9a13e | **Scope:** item 12 only — jobs/poll.mjs, jobs/run.mjs, lib/db.mjs, tests/poll.test.mjs, tests/run-imap.test.mjs (5 files, committed blobs)
**Counts: Critical 0 | Important 1 | Minor 1**
**Dimensions Swept:** Correctness/false-negative 1 finding · Fault tolerance clean · Concurrency/idempotence clean · Security/secrets clean · Dependencies clean · Efficiency clean · Over-engineering 1 finding

## Prior findings — all closed at the committed blobs
CLOSED — Critical `String.fromCodePoint` RangeError — `3a9a13e:jobs/run.mjs:198-199`, range + surrogate guard present.
CLOSED — Important unbalanced `<style>`/`<!--` strip deleting the body — `3a9a13e:jobs/run.mjs:174-175`, inner runs now forbid a second opener.
CLOSED — Important no dead letter / infinite retry — `3a9a13e:jobs/poll.mjs:358-392`, MAX_ATTEMPTS counter keyed on `message_key`, forward-then-markSeen.
CLOSED — Important subject folding made bare-`stop` match benign subjects — `3a9a13e:jobs/poll.mjs:90`, both-ends anchor; all four benign subjects false.
Minors 1-2 needed no fix; unchanged.

## Delta hunks
`if (false)` → `if (!dryRun)` restored at all three suppress sites — `jobs/poll.mjs:401,440,504`; `if (false)` absent from all five blobs. Correct, no further comment.

## Findings

### Important
jobs/poll.mjs:90 — correctness / false negative — the both-ends anchor closed the false positives but silently dropped a class of real bare opt-out replies the old pattern caught: `stop it`, `stop this`, `please stop it`, `stop bothering me`, `stop harassing me`, `stop already`, `stop pls`, `stop, thanks` are all MISS now and MATCH under the pre-delta pattern (verified by execution against the committed blob); no other pattern covers them, and the failure is invisible — the stranger keeps getting mail. — Fix: add two narrow patterns beside it rather than re-widening this one: `/^[ \t]*(?:please[ \t]+)?stop[ \t]+(?:it|this|that|already|pls|please)\b[ \t.,!]*$/im` and `/\bstop\b[^\n]{0,20}\b(?:bothering|harassing|pestering|spamming)\b/i`.

### Minor
jobs/poll.mjs:66-97 — over-engineering / maintainability — a hand-maintained 21-regex list is the wrong structure for a recall-critical check now revised three times, each revision trading recall against precision with no undo on `suppressed_at`; the list has no way to state which phrasings it is required to catch, so a narrowing loses recall silently (see the Important above). — Fix: keep the list, but move the corpus that governs it into one exported table in the test file — `RECALL[]` (must suppress) and `PRECISION[]` (must not), each phrasing a row, the patterns asserted against both — so any future edit that loses a phrasing fails a named test instead of shipping. Do not restructure the matcher itself; not gating.

## STANDARDS.md Updates
none — no file created at the repo root, by instruction.
