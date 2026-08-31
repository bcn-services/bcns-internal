## VERDICT: PASS

**Task:** item 12 — `jobs/poll.mjs`, reply poller + parser
**Branch:** item/0008-places (existing worktree) | **Date:** 2026-08-31 | **Gate mode:** tests
**Suite:** `pnpm test` → `# tests 204 / # pass 204 / # fail 0 / # skipped 0` (engineer 180, baseline floor 131)

## Criteria Checked
- opt-out sets `suppressed_at` even when classification throws — `an opt-out is suppressed even when the classifier throws` (drives `run()`, classifier throws, `suppressions=[{b1,'reply opt-out'}]`, `updates=[]`) — PASS
- out-of-office reply changes no stage — `an out-of-office reply changes no stage` (drives `run()`, `updates=[]`, `suppressions=[]`, `result.auto=1`) — PASS
- `Reply "stop"` inside a quoted region does not suppress — `a reply quoting our own stop footer replies, it does not suppress` + qa `a bare "> stop" quote line…` (both drive `run()`) — PASS
- `won 2400` allow-listed sets `stage=won`, same line from unknown sender changes nothing — `won 2400 from an allow-listed sender sets stage=won` / `the same line from an unknown sender changes nothing` (both drive `run()`) — PASS

## Guardrails
- opt-out commits before classification — proven by execution (throwing classifier) + `qa: suppression is committed before the classifier is even reached` asserts call order `['suppress']`, classifier never called — PASS
- command only from allow-listed sender, else forwarded — empty allow-list, stranger, and 4 lookalike-sender forms all change nothing and forward — PASS
- unmatched prospect message forwarded, never guessed — `a prospect reply matching no thread is forwarded` + qa unmatched-opt-out variant — PASS

## Mutation Test (each mutation applied, suite run, reverted; `jobs/poll.mjs` byte-identical after)
- `isOptOut` → always false: RED, 36 fail
- allow-list gate `isAllowedSender` → always true: RED, 5 fail
- `stripQuoted` → identity: RED, 2 fail
- ordering swapped (classifier awaited before the opt-out block): RED, 3 fail incl. the throwing-classifier test
- No safety path stayed green under mutation.

## Audits
- Vacuous assertions: none. Opt-out/allow-list assertions are literals; `NO_ANSWER_DAYS`/`ADVANCED_STAGES` pinned to literals in a dedicated test, so mutating a constant fails there first.
- Negative-side-effect tests: every "changes nothing"/"no stage"/"does not suppress" assertion goes through `run()`; none re-derives from adapter inspection.
- Producer/consumer fields: `db.recordThread` writes `(message_id, business_id, direction, mailbox, subject)`; `db.threadByMessageIds` selects `message_id, business_id`; fixtures use exactly those snake_case names. No mismatch.
- Regressions: `git diff -- tests/` is empty — no pre-existing test removed or weakened. `package.json` diff adds `tests/poll.test.mjs` only.

## Tests Added (24, appended to tests/poll.test.mjs)
- 13 additional adversarial opt-out phrasings ("Please stop sending me these emails", "quit emailing me", "Kindly remove my address", multi-line buried opt-out, etc.)
- `qa: an opt-out buried under a friendly opening still suppresses through run()` — classifier says `interested`, suppression wins anyway
- `qa: an opt-out above a quoted region survives stripQuoted` — guards against over-eager stripping
- `qa: the classifier is the backstop when the regex misses the phrasing` — pins a known regex gap and locks the second line of defence
- `qa: suppression is committed before the classifier is even reached` — asserts call order, not statement order
- `qa: a lookalike sender domain honours no command` — 4 spoof forms incl. display-name and `.com.evil.example`
- `qa: a spoofed "stop" on bot@ from a stranger suppresses nothing`
- `qa: won 2400 … with no matching thread changes nothing`, `qa: a command on a suppressed business is not applied`, `qa: Delivered-To routing is case insensitive`, `qa: a prospect opt-out with no thread is forwarded`

## Findings (non-blocking — no `done when:` criterion or guardrail unmet)
- Recall gaps in `OPT_OUT_PATTERNS`, measured: "we don't want any more emails", "Please remove this email address from your distribution", "Please remove from your list", "Please cease all communication", "Please do not send us anything further" all return false. Each is caught only if the classifier runs and answers `opt_out`.
- `deps.claude` is wired in `run.mjs` only when an API key is present; with no key the regex is the *sole* opt-out defence and those five phrasings become true false negatives. Suggest a `skipped` event (or refusing to advance a stage) when `poll` runs without a classifier.
- Judgement call review: bare `not interested` as opt-out is defensible (false positive is visible via forward); classifier-failure still setting `stage=replied` errs toward stopping mail — safe; unbounded `client.fetch({ seen: false })` is a throughput risk only, no correctness impact.

## Not Verifiable
- The IMAP adapter (`createImap` in `jobs/run.mjs`) — a live connection is forbidden by LANE.md. Everything downstream is a pure function of the plain objects it yields, and the object shape it produces (`from` = bare address, lowercase-matched `deliveredTo`, `headers` subset) was read and matched against the fixtures.
