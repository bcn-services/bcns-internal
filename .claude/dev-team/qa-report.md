## VERDICT: FAIL

**Task:** item 12 — `jobs/poll.mjs` reply poller, FINAL DELTA re-verification bed05dc..39529aa
**Branch:** item/0008-places | **HEAD:** 39529aa | **Date:** 2026-08-31 | **Gate mode:** tests
**Suite:** item-12 subset `tests/{poll,run-imap,db,touch}.test.mjs` → `# tests 123 / # pass 123 / # fail 0`, stable across 3 runs. Counts 131→220→222→123(subset); no decrease. All probes out-of-band in /tmp, nothing committed, `jobs/` `lib/` `tests/` clean.

## Criteria re-confirmed at HEAD (each driven through `run(deps)`)
- opt-out sets `suppressed_at` with a throwing classifier — `suppress=[[b1,'reply opt-out']]`, `updates=[]`, `suppressed=1`, `seen=[1]` — PASS
- out-of-office changes no stage — `updates=[]`, `suppress=[]`, `auto=1`, row stage stays `sent`, classifier never called — PASS
- quoted `Reply "stop"` does not suppress — `suppress=[]` — PASS
- `won 2400` allow-listed → `stage=won`; `stranger@evil.example` → `updates=[]`, `forwarded=1`, stage stays `call_due` — PASS

## Guardrails
- opt-out runs+commits before classification — PASS (throwing classifier still suppresses)
- command only from an allow-listed sender, else forwarded — PASS
- unmatched prospect message forwarded, never guessed — **FAIL** — the new dead-letter path marks seen and drops without forwarding, and F4-key below makes it fire on an innocent message's FIRST failure

## Failures (gating)
- **F4 counting key is unsound** — `lib/db.mjs:223` counts `events` by `detail->>'uid'` only: no mailbox, no uidvalidity, no time bound, and `events` is append-only forever. Reproduced twice through `run(deps)`: uid 7 dead-letters after 3 deterministic failures, then a NEW unrelated message reusing uid 7 (uidvalidity reset or second mailbox) that hits ONE transient failure is dead-lettered immediately — `dead_letter_count=2`, `updates=[]`, marked seen, never re-fetched, never forwarded. An opt-out in that message is lost silently: the exact invisible false negative this item exists to prevent. Root Cause: the dedupe key is not unique to a message. **bug** — key on `mailbox+uidvalidity+uid`, or bound the count to the current tick window.
- Consequence: `done when:` #1 (opt-out sets `suppressed_at`) is not guaranteed for a prospect reply landing on a re-used uid — the message is dropped before `isOptOutMessage` ever runs.

## Fix verification by execution (68 probe assertions, 63 pass)
1. CRITICAL entity range guard — **PASS**. `&#x110000;` `&#99999999999;` `&#xD800;` stay literal, no throw; `&#x10FFFF;` `&#0;` decode; `&#;` `&#x;` `&#-1;` `&#xZZ;` `&bogus;` literal; `&#x27;` `&amp;` `&nbsp;` `&rsquo;` decode. `drainMessages` over a 2-message tick containing `&#x110000;` returns both, and `run(deps)` suppresses the second — `errors=0`, `seen=[10,11]`. Entity→`’`→fold-to-ASCII chain matches `don't want ... emails`.
2. IMPORTANT unbalanced pair strip — **PASS**. Both reviewer bodies now suppress; balanced `<style>`/`<script>`/comment still strip whole. 15-case deletion hunt (nested opener, opener in an attribute value, `<style>` never closed, `-->` inside a script string, CDATA, uppercase `<STYLE>`, unclosed `<!--`, attr containing `>`, script-inside-comment) — every one preserves the body and suppresses. No remaining deleting/mangling input found.
3. IMPORTANT `stop` lookahead — **PASS on the named case, narrowed not closed**. `Stop by the office Thursday!` reaches `replied` with `suppress=[]` and `updates=[[b1,{stage:'replied',next_touch_at:null}]]`; subject-only `STOP`/`UNSUBSCRIBE` still suppress; `stop by all means, but stop emailing me` still true; `stop in the future` correctly excluded from that pattern and still true when a real opt-out phrase follows. `OPT_OUT_PATTERNS.length` pinned to literal 21.
4. IMPORTANT dead letter — core behaviour **PASS**, key **FAIL** (above). Across 6 ticks: exactly 3 `error` events, exactly 1 `dead_letter` with `attempts:3`, `seen=[42]` once, never re-fetched. Transient 2-fails-then-success processes normally with 0 dead letters. A repeatedly failing SMTP forward is marked seen after tick 1, so forwards do not repeat (`sends=1`).

## Findings (non-gating)
- IMPORTANT — `jobs/poll.mjs:80` residual false positives of the same class the fix addressed: any ≤30-char line or subject starting `stop <verb>` still suppresses permanently. Reproduced: `Stop light replacement quote`, `Stop press: we are hiring`, `Stop guessing, start measuring`, `Stop worrying about SEO` → all `isOptOutMessage === true`. The lookahead enumerates four prepositions; the failure mode is the open verb slot, not the preposition slot. Suppression has no undo.
- Assertion discipline: every opt-out / allow-list / dead-letter probe assertion is pinned to a literal, with separate `assert.equal` on each constant — `MAX_ATTEMPTS === 3`, `OPT_OUT_PATTERNS.length === 21`, `MAX_MESSAGES_PER_TICK === 100`, all confirmed.

## Mutation test (one at a time; `git checkout --` between; hashes byte-identical to base after all four, tree clean)
- entity range guard removed → RED 122/1 · `(?!<\1\b)`+`(?!<!--)` inner guards reverted to `[\s\S]*?` → RED 122/1 · `stop` lookahead removed → RED 122/1 · `MAX_ATTEMPTS` 3→9999 → RED 122/1. No safety path stayed green.

## Regression audit (`git diff bed05dc..39529aa -- tests/`)
- +168/−1 poll.test.mjs, +8/−0 run-imap.test.mjs. The single removed line is `import { toMessage }` widened to `import { toMessage, htmlToText }`. No test deleted, none weakened.

## Judgement call — `htmlToText`
Replace it. Not sound enough to ship as-is: two review rounds produced one Critical (RangeError DoS stalling every tick) and one Important (silent body deletion) from the same 40-line regex chain, and both were invisible-false-negative shaped — the one failure mode this pipeline cannot detect at runtime. My hunt found no remaining deleting input, but the file's own comments still concede three known-wrong behaviours (`<b>Remove</b><i>me</i>` → `Removeme`, unclosed `<style>` leaking CSS as text, attribute `>` leaking attribute text), and each fix has been a new inline-regex special case rather than a parser. `html-to-text` is already resolved in `node_modules` via `mailparser`; declaring it directly is one line. Recommend swapping once LANE item 1 fixes the direct dependency set. Not changed here.

## Not Verifiable
- none.
