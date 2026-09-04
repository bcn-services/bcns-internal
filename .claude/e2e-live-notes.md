# e2e-live run notes (2026-09-03, autonomous overnight)

A resumed session reads this first. One line per decision; stage checklist at the bottom.

## Decisions
- Branch `e2e-live` cut from `pipeline-v2`; carried work committed as 4549992, three wrap-sensitive tests fixed in the next commit.
- Local job runs: nothing loads `.env.local`; use `set -a; . .env.local; set +a; JOB=x pnpm job` (never print values).

## Checklist (✅/❌ + evidence)
- [x] 1 tests+lint — 368 pass / 0 fail, `pnpm lint` clean at d802aa8
- [x] 2 migration 0022 — applied, recorded in supabase_migrations.schema_migrations; 0023/0024/0025 applied via psql over the pooler 2026-09-04 ~17:15Z and recorded the same way (CLI `migration list --linked` hangs on a prompt)
- [x] 3 authcheck ok — runner event 522 `ok` {os cloned, voiceRules true, project bcns-leads}
- [x] 4 funnel drafted→onboarded — events: replied 06:30Z, command notes 06:41:51Z, quoted 06:45:05Z (bcns-os 335ade4), signed 06:59:45Z (bcns-os c2fff69, clients.signed_at 06:59:38Z), onboarded 07:07:55Z (bcns-os 6122a3c, private repo bcn-services/bcns-client-mudd-plumbing-test-claremont), notified :onboarded 07:09:31Z, 'Signed: Mudd Plumbing Test — your turn' in nseluga@bcn-services.com inbox 12:09 AM
- [x] 5 stop → suppressed — Mudd Stop Test suppressed_at 06:32:04Z (event 533 `suppressed` by keyword); row stays `sent` and vanishes from selectable_businesses, which is the design
- [x] 6 call_due → pitch — runner pitch event 650 (bcns-os d5e6000 pitch: mudd-bump-test-claremont, research.pitch_path set); notify event 681 → '[pipeline] call Mudd Bump Test — (909) 555-0142' 09:27 PT carries 'Pitch folder: clients/mudd-bump-test-claremont/pitch/'
- [x] 7 signed w/ two attachments refused — poll error {stage:contract, reason:'more than one attachment'} + forwarded 06:50:27Z; row stayed quoted (updated_at 06:45:05Z)
- [x] 8 bump path — Mudd Bump Test: touch events sent bump:true 07:11:30Z + 07:11:35Z (message_ids 0af42fa1…, bdc99fc5…), call_due 07:11:37Z touches=3, no third send; Gmail shows one 3-message thread 'a question about Mudd Bump Test'
- [x] 9 source+qualify+personalize live — runner: source 1 sourced, qualify 4 qualified/4 call_due/4 skipped (11 `Command failed: claude -p` errors ids 613-637 in run 33895340853 at 16:28Z, before the 16:32Z token refresh — the keychain OAuth copy had expired; 4 `fetch failed`; no-domain rows now call_due), personalize 5 drafted (run 33896083741) through the voice gate. Draft grammar fixed for future rows (predicate facts + wider verb lead); the 5 stored drafts keep the old wording
- [x] 10 runner leg — touch 33848080030 (event 626 sent), poll notes 33895656044 + signed 33896799682, notify 33896487921 + 33897817915, pitch 33848697973 (Mudd Bump Test), quote 33895757002 (378s, longest), onboard 33897348369 (287s, after 33896971838 failed on a missing GITHUB_TOKEN for the skill preflight). 26 runs today, 0 workflow failures, none over 8 min, no orphaned rows. Verifier (b): five of six on Mudd Runner Test; pitch ran on Mudd Bump Test because the notes→quoting path never passes call_due
- [x] 11 items 21/22/23 — built with tests on the branch (8a74ee4 triage, item-22 transport, 8509340 poll reads every mailbox). Live use of 22/23 still behind the second domain: trybcns.com row seeded paused by 0025, credentials on the runner, poll routes any mailbox address; item 21 never fired live (no alert mail arrived at alerts@, triage has 0 events)
- [x] 12 voice review — email: greeting/duplicate-bump/mock-up fixes (touch.mjs, template.mjs, os branch outreach-mockup-wording); pitch+quote: em/en dashes stripped by normalizeDashes before push; drafts: 'is has …' / 'is over 30,000 …' fixed via predicate facts
- [x] 13 progress/README/PR — LANE_PROGRESS.md status 2026-09-04 + rows 21/23; ~/os clients/internal/README.md bumped; NOTIFY_ALLOWED_RECIPIENTS restored to both addresses, DRY_RUN=true; PR opened, not merged (URL in the morning report)
- Gmail reply on a bot@ thread defaults From to the bot@ alias; poll refuses the sender. Always open the From chip and pick nseluga@ before replying with a command.
- Gmail web "unread" and IMAP \Seen disagree; when poll skips "no unread", clear \Seen over IMAP (imapflow messageFlagsRemove) instead of re-marking in the web UI.
- Live onboard exposed two bugs: /intake prints paths relative to osDir and onboard resolved them against cwd; /new-client-repo stamps `status: active`, which bumpReadmeStatus (lead-only) skipped. Both fixed in jobs/onboard.mjs; live row/README patched by hand (bcns-os 3ac3acb).
- `businesses.research` is stored both as a JSON string (33 rows) and as an object (39 rows); every reader parses both. Don't "fix" it tonight.
- Verifier (a) passed all funnel claims. Two notes: the "signed" contract PDF is byte-identical to the quote PDF (I attached a copy of the quote — the job stores whatever single PDF arrives, it does not diff it), and SEND_ALLOWED_RECIPIENTS lives in the scratch job wrapper, not .env.local.
- LANE.md says send + two bumps, then call_due on the fourth pass (touches=3). The kickoff spec expected call_due after touch 2. Ran per LANE: bumps at 07:11:30Z and 07:11:35Z (same thread, In-Reply-To), call_due 07:11:37Z with no send.
- Voice: bumps greeted "Hi," with a known owner name and both bumps were identical; template claimed "we've built a mock-up" against the skill's own CAN-SPAM rule. Fixed in jobs/touch.mjs + lib/template.mjs; skill copy on bcns-os branch outreach-mockup-wording (aba4d68, not merged).
- `git commit -am` in ~/os swept 10 of Nate's uncommitted files onto that branch; restored them to the main worktree and reverted them on the branch with a second commit (no force-push).

## Post-compaction decisions (2026-09-04, runner leg onward)
- qualify: a row with no domain is a calling lead (`call_due`, reason 'no domain'), not an error retried every tick.
- pitch/quote: `normalizeDashes` rewrites em/en dashes to ', ' in every .md the skill wrote, before the push. The skill rule alone was ignored by the model every time.
- personalize: qualify now asks for verb-led predicate facts; VERB_LEAD/NUMBER_LEAD widened so "has customer testimonials" and "over 30,000 roofs" read as sentences.
- onboard on the runner needs `GITHUB_TOKEN` = GH_PACKAGES_TOKEN (the /new-client-repo preflight wants a classic PAT with read:packages); the job error now quotes what the skill said.
- notify writes a `skipped` event on a quiet tick (every-job-logs rule).
- Runner Claude auth is a copy of the local keychain OAuth token (~2-3h). Refreshed 16:32Z and 16:45Z. Human: `claude setup-token` for a long-lived one.
- trybcns.com conversion, code side done: 0025 seeds `outreach@trybcns.com` paused; `SMTP_MAILBOX_OUTREACH_TRYBCNS_COM_USER/_PASS` on the runner and in .env.local (same seat, same app password); poll treats every `mailboxes` address as a prospect address; docs/NOTIFICATIONS.md "Switching the outreach domain" has the human steps. Not done because each needs a password re-challenge or mails a code to an address outside the allow-list: send-as alias, DKIM generation, SPF/DKIM/DMARC at Namecheap, the status swap.
- The new client repo's own deploy workflow fails at `migrate` (two GitHub mails 16:52Z/16:54Z): expected, it has none of the five per-repo secrets. Not part of tonight's scope.
- PR: https://github.com/bcn-services/bcns-internal/pull/6 (open, not merged). README bump is bcns-os c8de32b, pushed from the scratch clone: ~/os main is behind origin and `git pull` there aborts because untracked local pitch folders (perez, sos, statewide, fleet) collide with what the runner pushed. Left exactly as found, README bump sits there as an unstaged modification identical to the pushed one.

## 2026-09-04 follow-up: pitch on replied rows

Nate: the meeting notice should already carry the pitch so nobody runs it by
hand before the call. Pitch now selects `call_due` and `replied` rows
(`PITCH_STAGES`); it runs before notify on the same tick, so `meetingEmail`
prints `Pitch folder:` like the call task does. Tests 369 pass. Not fired live
yet — the next replied row on a live tick proves it.
