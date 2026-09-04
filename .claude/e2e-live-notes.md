# e2e-live run notes (2026-09-03, autonomous overnight)

A resumed session reads this first. One line per decision; stage checklist at the bottom.

## Decisions
- Branch `e2e-live` cut from `pipeline-v2`; carried work committed as 4549992, three wrap-sensitive tests fixed in the next commit.
- Local job runs: nothing loads `.env.local`; use `set -a; . .env.local; set +a; JOB=x pnpm job` (never print values).

## Checklist (✅/❌ + evidence)
- [ ] 1 tests+lint
- [ ] 2 migration 0022
- [ ] 3 authcheck ok
- [ ] 4 funnel drafted→onboarded
- [ ] 5 stop → suppressed
- [ ] 6 call_due → pitch
- [ ] 7 signed w/ two attachments refused
- [ ] 8 bump path
- [ ] 9 source+qualify+personalize live
- [ ] 10 runner leg
- [ ] 11 items 21/22/23
- [ ] 12 voice review
- [ ] 13 progress/README/PR
