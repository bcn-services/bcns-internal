## VERDICT: FAIL

**Task:** item 12 — `jobs/poll.mjs` reply poller, delta re-verification 39529aa..2da8f3e
**Branch:** item/0008-places | **HEAD:** 2da8f3e | **Date:** 2026-08-31 | **Gate mode:** tests
**Suite (HEAD 2da8f3e as committed):** item-12 subset → `# tests 131 / # pass 115 / # fail 16` — RED.
**Suite (working tree = HEAD + the one-line restore below):** `# tests 131 / # pass 131 / # fail 0`, twice.

## Failures (gating)
- **G1 — HEAD 2da8f3e ships a disabled opt-out write.** `jobs/poll.mjs` line 398 in the commit reads `if (false) await db.suppress(sql, businessId, 'reply opt-out')`; the working tree has `if (!dryRun)` UNCOMMITTED. `done when:` #1 (an opt-out reply sets `suppressed_at`) fails at HEAD: 16 subset tests RED, incl. `an opt-out is suppressed even when the classifier throws`, `qa: suppression is committed before the classifier is even reached`, `review: a subject-only UNSUBSCRIBE suppresses`. Root Cause: a mutation-test edit was committed instead of reverted. **bug** — restore `!dryRun` and commit. Guardrail "opt-out runs and commits before classification" is violated at HEAD.
- **G2 — the bare-stop anchor costs real recall.** `/^[ \t]*(?:please[ \t]+)?stop[ \t]*[.!]*[ \t]*$/im` now returns false for `stop stop stop`, `STOP PLEASE`, `stop now` — each true under the old form and matched by NO other pattern (`isOptOut` false). All three are bare-stop replies a prospect sends; a missed opt-out is the item's flagged failure mode. Root Cause: the anchor closes the trailing slot entirely rather than restricting it. **bug** — allow a trailing `please|now` / repeated `stop` tail, or bound the tail to words that cannot start a noun phrase.

## Fix 1 — dead letter (verified by execution through `run(deps)`, working-tree content)
- uid reuse no longer reproduces: uid 7 dead-letters, a fresh Message-ID on uid 7 survives one transient failure, is re-fetched, and its `unsubscribe` sets `suppressed_at` — PASS.
- forward BEFORE markSeen, order asserted: `['forward:nseluga@…','forward:bchung@…','dead_letter','markSeen']` — PASS. Throwing forward → `forwarded:false` + `forward_error`, still marked seen — PASS.
- transient 2-fails-then-success → stage `replied`, `seen=[7]`, 0 dead letters — PASS.
- **`uid:<n>` fallback probe — the miniature bug DOES reproduce.** Two different Message-ID-less messages on uid 7: after the first dead-letters, the second is dead-lettered on its FIRST transient failure, `suppressed_at` stays null, opt-out never runs. It is NOT a silent loss — both allow-listed humans are forwarded the full message before markSeen (`order tail` = forward, forward, dead_letter, markSeen). Acceptable as shipped; the guardrail holds. Follow-up, not gating: key on mailbox+uidvalidity+uid when Message-ID is absent.
- **No time bound confirmed:** `select count(*) … kind in ('error','dead_letter') and detail->>'message_key' = $1` over an append-only `events` — a message legitimately retried months later inherits every historical failure for the same Message-ID and can dead-letter on its first fault. Real, bounded by the forward. **design-level** follow-up: add `and at > now() - interval '1 day'`.

## Fix 2 — bare-stop (both directions)
- All four benign subjects reach `replied`, `suppressed_at === null`, no suppression call — PASS.
- Full recall corpus (15 `OPT_OUTS` + 13 `QA_OPT_OUTS`, 28 phrasings) — 0 regressions.
- Edge probe: `STOP.`, `Stop!`, `Stop.  `, `stop. `(trailing space), `stop\r\n`, `stop!!!`, `please stop`, `Please STOP.`, `STOP` + signature, `stop` on its own line in a friendly reply, `STOP` + `>` quoted text — all still true. `stop stop stop`, `STOP PLEASE`, `stop now` — false → G2.

## Mutation test (one at a time, restored byte-identical, hash-verified `a389a32…` / db-OK)
- `message_key` → `uid` in `lib/db.mjs` → RED 130/1 · markSeen moved before the forward → RED 130/1 (`qa: a dead letter reaches the allow-listed humans before markSeen`) · anchored stop pattern → old prefix form → RED 127/4. No changed safety path stayed green.

## Byte-identity of already-passed work (confirmed from the diff, not re-tested)
- The delta touches only: the stop pattern, `messageKey()`, the error/dead-letter block in `jobs/poll.mjs`, `messageId` in `toMessage`, and the count key in `lib/db.mjs`. Entity range guard, unbalanced-tag strip, `htmlToText`, `MAX_MESSAGES_PER_TICK`, markSeen ordering on the success path, the other 20 patterns — untouched.

## Constants (pinned to literals throughout)
- `MAX_ATTEMPTS === 3`, `OPT_OUT_PATTERNS.length === 21`, `MAX_MESSAGES_PER_TICK === 100` — all asserted separately; every opt-out / allow-list / dead-letter probe assertion uses literals.

## Guardrails
- opt-out before classification — **FAIL at HEAD** (G1); PASS on the working-tree content.
- command only from an allow-listed sender, else forwarded — PASS.
- unmatched prospect message forwarded, never guessed — **PASS**, the old dead-letter violation is closed.

## Regression audit (`git diff 39529aa..2da8f3e -- tests/`)
- `tests/poll.test.mjs` +166/−6; no test deleted or weakened (the 6 removals are the uid→message_key rekey and a STRENGTHENED dead-letter assertion, 6→8 forwards with `message_key`/`forwarded` pinned). Subset 123 → 131, no decrease.

## Not Verifiable
- none. All probes out-of-band in /tmp; nothing committed; tree left exactly as found.
