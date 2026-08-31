## VERDICT: PASS

**Task:** item 12 — `jobs/poll.mjs` reply poller, gating re-verification of G1 + G2 at HEAD
**Branch:** item/0008-places | **HEAD:** 3a9a13e | **Date:** 2026-08-31 | **Gate mode:** tests
**Suite (committed content — worktree byte-identical to `3a9a13e` for all five item-12 files, verified by `diff` against `git show`):** item-12 subset `# tests 131 / # pass 131 / # fail 0`.

## G1 — disabled opt-out write: CLOSED
- Committed blob `3a9a13e:jobs/poll.mjs` — all three `db.suppress` sites read `if (!dryRun)` at lines 401 / 440 / 504; `if (false)` occurs 0 times.
- Leftover-mutation sweep over the committed blobs of all five files (`jobs/poll.mjs`, `jobs/run.mjs`, `lib/db.mjs`, `tests/poll.test.mjs`, `tests/run-imap.test.mjs`): no `if (false)`, no `if (true)`, no `test.skip`/`it.skip`/`.only(`, no commented-out `assert.`, no TODO/FIXME/XXX. Constants unmutated: `MAX_ATTEMPTS === 3`, `MAX_MESSAGES_PER_TICK === 100` (`jobs/run.mjs:230`, untouched by the delta), `OPT_OUT_PATTERNS.length === 21`.
- The 16 previously-RED tests are green at the committed content, incl. `an opt-out is suppressed even when the classifier throws`, `qa: suppression is committed before the classifier is even reached`.

## G2 — bare-stop pattern: CLOSED, both directions, driven through `run(deps)`
- Regressed phrasings now suppress end-to-end: `stop stop stop`, `STOP PLEASE`, `stop now` → `suppressions === [{id:'b1',reason:'reply opt-out'}]`, `suppressed_at` set — PASS.
- All four benign subjects (`Stop light replacement quote`, `Stop press: we are hiring`, `Stop guessing, start measuring`, `Stop worrying about SEO`) reach `stage='replied'` with `suppressed_at === null` and zero suppress calls — PASS.
- Full 28-phrasing recall corpus (15 `OPT_OUTS` + 13 `QA_OPT_OUTS`) plus the 4 `NOT_OPT_OUTS` — 0 regressions.
- **New-false-positive hunt (the widened alternation):** `please`/`Please`/`PLEASE`/`Please!`/`please.`/`please please`, `now`/`Now`/`NOW`/`now now`/`Now!`/`now.`, `please now`, `now please`, `Now, please!` — all `isOptOut === false` (the `(?=[^\n]*\bstop\b)` lookahead gates every match on a real `stop`). `Please`, `Now`, `please please`, `now now` as full subjects, and a bare `now` line inside a friendly body, all reach `run(deps)` with zero suppressions.
- **Separator run-together check:** `stopnow`, `stopplease`, `nonstop`, `stopwatch` — `false` (the `\bstop\b` lookahead blocks them). `stop,now` / `stop.now` / `stop!now` — `true`, and those ARE opt-outs, not false positives.
- No benign one-word or benign multi-word subject is admitted by the widened alternation. No new permanent-suppression risk found.

## `done when:` criteria (re-run through `run(deps)` at committed content)
- opt-out sets `suppressed_at` even when classification throws — `an opt-out is suppressed even when the classifier throws` (#23) + `qa: suppression is committed before the classifier is even reached` (#67) — PASS
- out-of-office reply changes no stage — `an out-of-office reply changes no stage` (#27) — PASS
- `Reply "stop"` in a quoted region does not suppress — `an opt-out only inside a quoted region is not the sender speaking` (#3), `qa: an opt-out above a quoted region survives stripQuoted` (#64) — PASS
- `won 2400` allow-listed sets `stage=won`, same line from unknown sender changes nothing — #35 + #36 — PASS

## Guardrails
- Opt-out runs and commits before classification — PASS (#23, #67; `if (!dryRun)` restored in the commit).
- Command only from an allow-listed sender, else forwarded — PASS (#36, #37, #38, #42, #70).
- Unmatched prospect message forwarded, never guessed — PASS (#33, #47, #73, #75, #78).

## Delta audit (`git diff 2da8f3e..3a9a13e`)
- `jobs/poll.mjs`: exactly two hunks — the stop pattern + comment, and `if (false)` → `if (!dryRun)`. `tests/poll.test.mjs`: +12/−1, the bare-STOP subject array gains the three literals. Nothing else in `jobs/`, `lib/`, or `tests/` changed. Everything previously verified at `39529aa`/`2da8f3e` is byte-identical and was not re-derived.
- **Regression audit (`git diff 2da8f3e..3a9a13e -- tests/`):** no test deleted or weakened; the single removed line is the array literal that the 8-element version replaces. Subset count 131 → 131, no decrease.

## Mutation test
- **None performed this round.** The two fixes were mutation-tested by the operator; I verified instead that the committed blobs are free of leftover mutation edits and that the worktree is byte-identical to `3a9a13e` for all five item-12 files. No file was modified — `git status` over `jobs/`, `lib/`, `tests/poll.test.mjs`, `tests/run-imap.test.mjs` is empty; all probes ran from `/tmp` and were deleted. Nothing committed.

## Not Verifiable
- none.
