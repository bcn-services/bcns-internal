## VERDICT: PASS

**Task:** item 12 — `jobs/poll.mjs` reply poller, DELTA re-verification cd3d6bb..bed05dc
**Branch:** item/0008-places | **HEAD:** bed05dc | **Date:** 2026-08-31 | **Gate mode:** tests
**Suite:** `pnpm test` → `# tests 220 / # pass 220 / # fail 0 / # skipped 0` (floor 204 → 220, no decrease)

## Criteria re-confirmed at HEAD (all driven through `run(deps)`, out-of-band probe, not the committed suite)
- opt-out sets `suppressed_at` with a throwing classifier — `suppressions=[{b1,'reply opt-out'}]`, `updates=[]`, first db call `suppress` — PASS
- out-of-office changes no stage — `updates=[]`, `suppressions=[]`, `auto=1`, stage stays `sent` — PASS
- quoted `Reply "stop"` does not suppress — `suppressions=[]`, `suppressed_at=null` — PASS
- `won 2400` allow-listed → `stage=won`; same line from `stranger@evil.example` → `stage=call_due`, `updates=[]`, `forwarded=1` — PASS

## Guardrails
- opt-out runs+commits before classification — PASS (throwing classifier still suppresses; `isOptOutMessage` is the first branch of `handleProspect`)
- command only from an allow-listed sender, else forwarded — PASS (stranger + bare local-part `bot@anything.example` both change nothing and forward)
- unmatched prospect message forwarded, never guessed — PASS (no-thread, empty-body and no-classifier paths all forward)

## Fix verification (by execution)
- 1 CRITICAL htmlToText — html-only `multipart/related` nested `<table><td><div>` opt-out suppresses through `run(deps)`; `<img>`-only body forwards and the classifier is never called (throwing classifier not reached) — PASS
- 2 subject inclusion — subject-only `UNSUBSCRIBE`/`STOP` suppress; quoted `> Subject: UNSUBSCRIBE` and `Fwd: STOP` in body do NOT (isOptOut stripQuoted runs on subject+body) — PASS
- 3 null classifier — `degraded` event + `forwarded=1` (2 recipients) through `run(deps)` with `claude:null` — PASS
- 4 recall gaps — all five phrasings `isOptOut===true` and each drives a real `suppress` through `run(deps)`; `OPT_OUT_PATTERNS.length` pinned to literal 21, actual 21 — PASS
- 5 empty allow-list — `forwarded=0`, `errors=1`, zero `forwarded` events, zero sends — PASS
- 6 `MAX_MESSAGES_PER_TICK=100` pinned to a literal; `drainMessages` caps 150→100 — PASS
- 7 markSeen reversal — replayed every branch (prospect opt-out / non-opt-out / forward, teammate won·notes·yes·no answer·stop) twice through `run(deps)`: row state byte-identical after tick 2, `errors=0`; and with a throwing handler each branch leaves `seen=[]`, tick 2 re-applies nothing and marks seen. `db.suppress` idempotent by `suppressed_at is null` guard (lib/db.mjs:113); poll.mjs never calls `recordThread`, so no duplicate `email_threads` insert exists to escape. Engineer's no-second-dedupe claim CONFIRMED.

## Mutation test (one at a time, suite run, `git checkout --`; `jobs/poll.mjs` and `jobs/run.mjs` byte-identical after — hashes re-verified, tree clean)
- `htmlToText` → `''`: RED 3 fail · subject inclusion → body only: RED 1 · null-classifier forward → silent: RED 1
- each of the 4 new opt-out patterns deleted: RED 2 / 1 / 1 / 1. No safety path stayed green.

## Regression audit (`git diff cd3d6bb..bed05dc -- tests/`)
- 6 removed lines total, all in the two declared retargets; no test deleted, none weakened. poll.test.mjs 41→51 tests, +6 in the new tests/run-imap.test.mjs (registered in package.json, confirmed running).
- Retarget (a) still asserts a genuinely unmatched phrasing is `false` then proves the classifier suppresses it end to end — equivalent proof. Retarget (b) is a pure addition; both pre-existing markSeen assertions (`h.seen` = `[7]` and `[]`) survive unchanged.
- LANE Forbidden: no network/DB/FS-outside-tmp, no migrations, no `.env.local`, no new dependency; package.json diff is the test list only. My own probes lived in /tmp and are not committed.

## Findings (non-gating — no `done when:` criterion or guardrail unmet)
- `htmlToText` decodes only named/decimal entities: `don&#x27;t` and `don&rsquo;t` survive undecoded and miss the new "don't want ... emails" pattern (raw curly `’` misses too — pre-existing apostrophe class). Classifier remains the backstop. Fix: decode `&#x..;` and map `rsquo`→`'`.
- `htmlToText` turns an inline tag inside a word into a space (`<b>un</b>subscribe` → `un subscribe`), so a styled-mid-word opt-out misses. Unclosed `<style>` leaks CSS as text and an attribute containing a literal `>` leaks attribute text — both add noise, neither ever ate body text in probing.
- New pattern false positives are contrived only ("remove the extra chair from the list"); the two benign strings named in the brief ("remove me from the CC", "not interested in the premium tier") are matched by PRE-EXISTING patterns, unchanged by this delta. Subject inclusion makes the pre-existing `stop … list` pattern reachable from a subject ("Re: non-stop flights list" → true). Consistent with the documented recall-over-precision choice at poll.mjs:56.
- A retried tick re-sends a forward email to every allow-listed human (the accepted cost of the reversal); `no answer` re-applies a `now`-relative `next_touch_at` shifted by one tick.

## Not Verifiable
- none. (Live IMAP/SMTP remain untestable by LANE, but their pure halves — `toMessage`, `htmlToText`, `drainMessages` — are now covered directly.)
