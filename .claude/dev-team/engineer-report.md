# Engineer Report — item 12, third fix pass

**Branch:** item/0008-places
**HEAD:** 8e84198 (working tree only — nothing committed, per instruction)
**Date:** 2026-08-31

**Files changed (mine):**
- `jobs/run.mjs` — entity decode guard; non-crossing script/style + comment strips; corrected `ponytail:` comment; dropped `lsquo`/`ldquo`/`rdquo`
- `jobs/poll.mjs` — `MAX_ATTEMPTS`; bare-`stop` lookahead; dead-letter branch in the per-message catch
- `lib/db.mjs` — `messageFailureCount(sql, uid)`
- `tests/poll.test.mjs` — harness `messageFailureCount` fake + 4 regression tests

**Gate:** `pnpm test` → `# pass 237`, `# fail 0`, `# skipped 0` (floor 222). `pnpm lint` clean.
Poll-only subset: `tsx --test tests/poll.test.mjs tests/run-imap.test.mjs` → `# pass 95`.

**Not mine, present in the same worktree:** `jobs/notify.mjs`, `tests/notify.test.mjs` (untracked), `package.json`, `tests/clock.test.mjs` — a concurrent agent's item-13 work. Left untouched; it accounts for the 237-vs-222 delta.

## Findings

CRITICAL out-of-range numeric entity stalls every tick — FIXED at jobs/run.mjs:192-199 — `review: an out-of-range numeric entity cannot stall the tick` drives two messages through `run()` with the parse inside the mailbox drain: `read === 2`, both uids marked seen, the second still suppresses; unit asserts `&#x110000;`, `&#99999999999;`, `&#xD800;` stay literal and `&#x27;` still decodes.

IMPORTANT unbalanced `<style>`/`<!--` DELETES the body — FIXED at jobs/run.mjs:176-177, comment corrected at jobs/run.mjs:180-184 — `review: an unbalanced <style> or comment cannot delete the opt-out` runs both reviewer bodies through `run()` and asserts suppression + no stage move; balanced pairs still strip whole.

IMPORTANT `Stop by the office Thursday!` subject suppresses a live prospect — FIXED at jobs/poll.mjs:80 (`stop\b(?![ \t]+(?:by|in|over|round))`) — `review: an ordinary "Stop by..." subject does not suppress, a bare STOP still does`: benign subject reaches stage `replied` with no suppression, subject-only `STOP` and `UNSUBSCRIBE` still suppress, `OPT_OUT_PATTERNS.length` still pinned at 21.

IMPORTANT no attempt counter / dead letter, forward re-sent forever — FIXED at jobs/poll.mjs:328-350 + lib/db.mjs:223 — `review: a message that always throws is dead-lettered instead of retried forever`: `MAX_ATTEMPTS` pinned to literal 3, 6 forwards (2 humans x 3 attempts) then none, one `dead_letter` event `{uid:7, attempts:3}`, message marked seen and never re-fetched. Bookkeeping in the catch is itself wrapped so one bad message cannot end the tick.

Optional (non-gating): `lsquo`/`ldquo`/`rdquo` deleted at jobs/run.mjs:157-159; `rsquo` kept, its tests unchanged and green.

## Design notes

- Dead-letter state is counted from `events` (`job='poll'`, kind in `error`/`dead_letter`, `detail->>'uid'`) — the laziest durable option, no new table or column, and the SQL lives in `lib/db.mjs`. The call is `db.messageFailureCount?.()` so it only runs on the failure path.
- The surrogate range is excluded alongside the >U+10FFFF range: `String.fromCodePoint(0xd800)` does not throw but emits an unpaired surrogate, which the reviewer flagged as junk output.

## Guardrails

Opt-out still runs and commits before classification; commands still gated on the allow-list; unmatched prospect messages still forwarded. No new dependency, no network, no DB, no migration, no LANE.md edit, no root file. Nothing committed.
