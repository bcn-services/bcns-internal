# e2e-live run notes (2026-09-03, autonomous overnight)

A resumed session reads this first. One line per decision; stage checklist at the bottom.

## Decisions
- Branch `e2e-live` cut from `pipeline-v2`; carried work committed as 4549992, three wrap-sensitive tests fixed in the next commit.
- Local job runs: nothing loads `.env.local`; use `set -a; . .env.local; set +a; JOB=x pnpm job` (never print values).

## Checklist (✅/❌ + evidence)
- [ ] 1 tests+lint
- [ ] 2 migration 0022
- [ ] 3 authcheck ok
- [x] 4 funnel drafted→onboarded — events: replied 06:30Z, command notes 06:41:51Z, quoted 06:45:05Z (bcns-os 335ade4), signed 06:59:45Z (bcns-os c2fff69, clients.signed_at 06:59:38Z), onboarded 07:07:55Z (bcns-os 6122a3c, private repo bcn-services/bcns-client-mudd-plumbing-test-claremont), notified :onboarded 07:09:31Z, 'Signed: Mudd Plumbing Test — your turn' in nseluga@bcn-services.com inbox 12:09 AM
- [ ] 5 stop → suppressed
- [ ] 6 call_due → pitch
- [x] 7 signed w/ two attachments refused — poll error {stage:contract, reason:'more than one attachment'} + forwarded 06:50:27Z; row stayed quoted (updated_at 06:45:05Z)
- [ ] 8 bump path
- [ ] 9 source+qualify+personalize live
- [ ] 10 runner leg
- [ ] 11 items 21/22/23
- [ ] 12 voice review
- [ ] 13 progress/README/PR
- Gmail reply on a bot@ thread defaults From to the bot@ alias; poll refuses the sender. Always open the From chip and pick nseluga@ before replying with a command.
- Gmail web "unread" and IMAP \Seen disagree; when poll skips "no unread", clear \Seen over IMAP (imapflow messageFlagsRemove) instead of re-marking in the web UI.
- Live onboard exposed two bugs: /intake prints paths relative to osDir and onboard resolved them against cwd; /new-client-repo stamps `status: active`, which bumpReadmeStatus (lead-only) skipped. Both fixed in jobs/onboard.mjs; live row/README patched by hand (bcns-os 3ac3acb).
- `businesses.research` is stored both as a JSON string (33 rows) and as an object (39 rows); every reader parses both. Don't "fix" it tonight.
