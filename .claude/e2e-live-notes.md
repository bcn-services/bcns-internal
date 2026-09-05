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

## 2026-09-04 follow-up: trybcns.com Workspace domain-conflict recovery

Root cause confirmed live via Google Workspace support chat (agent Durgadevi,
case #75114833): `trybcns.com` is already claimed by an orphaned/abandoned
Google Workspace org, blocking bcn-services.com from adding it as a User alias
domain ("This domain name has already been used as an alias or domain").

Self-serve fix in progress via Google's own recovery tool (not the Durgadevi
case): `toolbox.googleapps.com/apps/recovery/ownership` — generates a
reference/case number, then verifies domain ownership via a DNS TXT record
(`google-gws-recovery-domain-verification=<case>` at host `@`). New case
#75117529 generated (contact nseluga@bcn-services.com). TXT record added at
Namecheap and confirmed live via `dig +short TXT trybcns.com @8.8.8.8` and
`@1.1.1.1` — correct and propagated.

Clicking "CHECK AGAIN" 503'd on the verification RPC
(`csp.withgoogle.com/csp/apps-toolbox-safehttp`) for two retries — transient
backend flakiness, not a DNS/config issue (TXT confirmed live via dig). Third
retry (2026-09-04, ~13:20Z) succeeded: page advanced to
`/apps/recovery/domain_in_use`, step 4 "Complete your request", offering
"Request to free up domain (Recommended)" (renames/removes the orphaned
existing account) or "Request to contact admins" (just emails them, closes
request). Awaiting Nate's go-ahead before clicking SUBMIT — it's irreversible
for the orphaned account. Fallback if this path stalls: continue the
Durgadevi email/chat case (#75114833).

## 2026-09-04 trybcns.com cutover (orchestrated run)
- Recovery submit landed: Google mail "[#75117529] Domain in use trybcns.com" 13:08 PT, "reply within one business day". Page URL that works: toolbox.googleapps.com/apps/recovery/domain_in_use?domain=trybcns.com&case=75117529&flow=contested (bare /ownership 400s).
- The "orphaned org" is NOT a stranger's: it is a Workspace trial signed up 2026-09-03 20:22 PT for trybcns.com, admin outreach@trybcns.com, recovery contact nseluga@bcn-services.com, trial ends 2026-09-17, first bill 2026-10-01. Support's "abandoned" framing was wrong. Fastest route: sign in as that admin, cancel subscription, delete the account; the pending free-up request does the same within a business day.
- Decision (Nate, 2026-09-04): KEEP the trybcns.com Workspace org as a separate sending org. Merging it as an alias domain would put bcn-services.com's reputation/suspension exposure in the same account; separate org isolates it. Subscription stays. NOTIFICATIONS.md step 1 (send-as alias) and the SMTP_USER/MAIL_FROM flip no longer apply; step 3 mailbox-swap SQL still does. Case #75117529 free-up request must be withdrawn (it would delete this org).
- Creds for outreach@trybcns.com: 2SV on, app password minted, four repo secrets SMTP/IMAP_MAILBOX_OUTREACH_TRYBCNS_COM_USER/PASS set 20:46Z via /wizard (also in .env.local). Live IMAP login (INBOX exists=5) and SMTP AUTH both OK. Zero code change needed: resolveMailboxAuth + buildDeps already key per-mailbox env. clock.yml patched to forward the four secrets.
- DKIM generated in trybcns admin console (selector google, 2048) and published at Namecheap host google._domainkey 2026-09-04 ~21:00Z; awaiting propagation before START AUTHENTICATION.
- Live-funnel prep 2026-09-04 ~21:00Z: mailboxes swapped (trybcns active, warmed_at set; send.bcn-services.com paused). Test row `bd402c81-5942-473b-85c3-f2aa5617b51a` "Mudd Trybcns Test" seeded at drafted, os_slug mudd-trybcns-test-claremont. `businesses` has a unique index on lower(email), so the old "Mudd Plumbing Test" row (09ac3ef2) was re-pointed to nseluga+plumbing-old@g.hmc.edu, not deleted.
- Cron runs only on the DEFAULT branch, and main is 30 commits behind e2e-live with none of the per-mailbox transport. PR #6 stays unmerged, so for the test window the repo default branch is switched to e2e-live and switched back to main afterwards. Test-window crons: poll `*/20 * * * *`, touch `5,35 * * * *`, mapped back onto the canonical SCHEDULES keys by a workflow expression (no code change). tests/clock "every cron has a job" fails by design while the window is open; green again once the crons are restored.
- Teammate commands (notes, signed) are mail Delivered-To bot@, so they must be replies from nseluga@bcn-services.com, which is signed out of Work Profile Chrome; human re-auth needed before the replied step.
- 21:21Z DKIM: admin console now "Authenticating email with DKIM" (negative cache cleared early). Case #75117529 withdrawal reply sent 21:19Z from nseluga@bcn-services.com.
- 21:22Z test window opened: repo default_branch main→e2e-live (cron fires only on default), DRY_RUN true→false. Both restore at cleanup.
- 22:58Z no scheduled clock run since 19:08Z (main's own crons had already stopped firing before the branch switch) → GitHub scheduler lag. Pushed empty commit 415a607 to re-register; still cron-only, no dispatch.
- 23:05Z scheduler history on main shows ~6 landed */20 ticks per day, not 39 → GitHub drops most ticks here. Test-window change: clock.yml matrix runs poll-set + touch on every landed tick (workflow-only, still cron-driven). Restore with the crons.
- 23:12Z Nate: raise tick rate for the window. Test crons collapsed to a single '*/5 * * * *' (GitHub's minimum) → matrix runs poll set + touch on each landed tick.
- 23:30Z Nate: GitHub cron is unreliable in production too → Cloud Scheduler (GCP bcns-leads) drives ticks via workflow_dispatch with a `schedule` input; SCHEDULES map unchanged; crons kept as backup; canonical crons restored in clock.yml. docs/SCHEDULER.md + scripts/scheduler-setup.sh (wizard: API enable + PAT → 4 jobs). Pass condition now "scheduler-only, no human dispatch". Classifier blocks gcloud state changes here → Nate runs the wizard.
- 23:33Z Nate ran the wizard + cadence updates (poll */5, touch 2-59/5, ref e2e-live). `gcloud scheduler jobs update` echoed the PAT into the session → rotate after the window (re-run wizard); wizard/docs now pass --format=none.
- 23:35Z first Cloud Scheduler tick → GitHub 404: the PAT was minted on nseluga-bcns with no repo access (resource owner must be bcn-services). Nate deleted it; replacement `clock-scheduler-dispatch` (owner bcn-services, bcns-internal only, Actions RW) prefilled in Chrome, Nate generates + runs wizard with CLOCK_REF=e2e-live.
- 22:32Z (learned 23:45Z) Google completed case #75117529 "free up domain": the trybcns.com trial org lost the domain and outreach@trybcns.com was renamed outreach_trybcns.com@trybcns.com.c-01qbt7gp.appstempdomain.goog (IMAP still auths with the same app password). Domain frees ≤24h. All three mailboxes rows set paused so touch skips every tick until the domain is re-attached; test row stays at drafted. Follow-up in this window: re-add trybcns.com to that org, rename user back, regenerate DKIM, republish TXT, delete the recovery TXT, re-test SMTP/IMAP, set trybcns row active.
- 23:47Z first Cloud Scheduler-driven run landed: 33930765311 (workflow_dispatch, e2e-live, schedule input, touch → skipped "no active mailboxes"). Scheduler trigger proven. Waiting on Google's domain release; asked Nate to pause clock-poll/clock-touch meanwhile (Actions minutes) and sign the renamed trybcns admin into Chrome.
- 2026-09-05 ~00:05Z: Add a domain → trybcns.com on the trybcns org (new Chrome profile "outreach inbox", deviceId a9332f17…) closed the dialog with no row added — still inside the 24h release window from case #75117529 (22:32Z). Retrying hourly; rename user back to outreach@trybcns.com right after verify+primary.
- 2026-09-05T00:29Z: trybcns.com attached to the trybcns org as Secondary Domain, Verified (release landed within ~1h of case completion, first retry). Next: Change primary domain → rename user → DKIM.
- 2026-09-05T01:26Z: Change primary domain refused (org is on free trial; Google blocks it for trial accounts). Not needed: user renamed to outreach@trybcns.com on the secondary domain (old .goog address kept as alias). New DKIM generated for trybcns.com (selector google, 2048) despite the 24-72h warning. Namecheap DNS still holds the OLD DKIM key + recovery TXT; Namecheap session expired → Nate signs in, then I swap the TXT and delete the recovery record, then START AUTHENTICATION.
- 01:38Z 09-05: Namecheap: recovery TXT deleted, google._domainkey replaced with new key (dig @8.8.8.8 confirms AxtE2sMZ5…). Admin console trybcns.com → START AUTHENTICATION → "Authenticating email with DKIM". mailboxes.outreach@trybcns.com set active. Runner CLAUDE_CODE_OAUTH_TOKEN expired again (401 in run 33936450467 smoke test); classifier blocks the keychain→gh secret copy this time — handed to Nate.
- 01:45Z 09-05: touch run 33936955615 (scheduler dispatch, sent:1) → event 802, msgid <d03a4dd1-b00c-4090-810b-97af907a2024@trybcns.com>. HMC "show original": From outreach@trybcns.com, SPF PASS (209.85.220.41), DKIM PASS d=trybcns.com s=google, DMARC PASS.
- 01:45Z 09-05: prospect reply sent from HMC Gmail (nseluga@g.hmc.edu, sole send-as) on the thread.
- 01:51Z 09-05: poll run 33937348667 (scheduler) → events 821 classify error (token expired), 822 forwarded, 823 replied (category other), 829 notified. Stage replied without a working classifier — poll degrades, does not block.
- 01:53Z 09-05: notes command sent from nseluga@bcn-services.com (Work Profile Gmail) as a reply on the replied-notify thread, To re-pointed from self to bot@bcn-services.com (Gmail defaults a reply to a same-account alias back to me).
- 01:56Z 09-05: poll run 33937583456 → event 841 command notes, stage quoting, 847 notified. quote job errored (845) on expired runner CLAUDE_CODE_OAUTH_TOKEN — hard blocker, handed to Nate again by push.
- 02:01Z 09-05: Nate refreshed CLAUDE_CODE_OAUTH_TOKEN (secret ts 02:01:08Z).
- 02:06Z 09-05: runs 33937834392/33938071931 smoke test: 'Not logged in · Please run /login' (was 401 before). Secret set at 02:01Z interactively is malformed/empty — handed back to Nate to re-set with the keychain pipeline or claude setup-token.
- 02:09Z 09-05: Nate re-set CLAUDE_CODE_OAUTH_TOKEN (secret ts 02:09:28Z).
- 02:17Z 09-05: after the 02:09Z token re-set, pitch events 907/908 (run 33938310153, started 02:10:18Z) succeeded — runner Claude token confirmed working. Quote job in the same run still executing.
- 02:24Z 09-05: run 33938310153 (scheduler poll tick) → event 932 quoted, 934 notified (key :quoted). Stage quoted. Quote took ~13 min of claude -p on the runner; the 02:15Z poll tick (33938556105) was cancelled by the concurrency group while it ran.
- 02:35Z 09-05: 'signed' reply sent from nseluga@bcn-services.com To bot@bcn-services.com on the quoted-notify thread with one PDF (mudd-trybcns-signed.pdf). Gmail reply again defaulted To self; re-pointed. Typing into the body silently failed while the recipient hover-card was open — moved the mouse away first.
- 02:42Z 09-05: run 33939739457 (scheduler poll tick) → event 982 signed, contract_path clients/mudd-trybcns-test-claremont/contract/2026-09-05-signed.pdf. Stage won. Tick order is poll→pitch→quote→onboard→notify, so onboard runs later in this same run.
- 02:52Z 09-05: onboard failed on three scheduler ticks (events 1009, 1016, 1023): claude -p /new-client-repo exited non-zero, event carried only the stdin warning because runSkill dropped err.stdout. Pushed bca5cce so the error carries the envelope result; waiting for the next tick to read the real reason.
- 02:57Z 09-05: event 1041 (run 33940416010) carries the real onboard reason: claude -p → 'API Error: 401 OAuth access token has been revoked'. Runner CLAUDE_CODE_OAUTH_TOKEN dead again ~45 min after the 02:09Z re-set; pitches 994/995 at 02:43-02:45 were the last to succeed. Needs a long-lived token from `claude setup-token`.
- 03:03Z 09-05: cause of the second revoke: the 02:09Z secret was the local keychain access token (claudeAiOauth.accessToken). The Mac's own claude refreshed its session ~02:45Z, which revokes the previous access token. Fix that persists: mint with `claude setup-token` (long-lived, independent of the local session). README secrets table now says so.
- 03:05Z 09-05: CLAUDE_CODE_OAUTH_TOKEN re-set by Nate via claude setup-token (secret ts 03:05:08Z).
- 03:09Z 09-05: secret set 03:05:08Z is not accepted either: runs 33940872483 and 33940964168 smoke test say '401 OAuth access token is invalid' (not 'revoked' — the pasted value is malformed). Handed back with a pbpaste pipeline that strips whitespace and self-tests before setting.
- 03:54Z 09-05: CLAUDE_CODE_OAUTH_TOKEN re-set from a fresh `claude setup-token` (108-char sk-ant-oat01, verified locally with haiku; secret ts 03:54:43Z). Minted via pty driver: code must be written, then Enter as a separate keystroke (Ink treats one chunk as paste). Backup in macOS keychain service bcns-runner-claude-token.
- 04:09Z 09-05: onboarded + notified from scheduler run 33943163481 (workflow_dispatch by clock-poll, started 03:55:13Z): ev 1290 onboarded → https://github.com/bcn-services/bcns-client-mudd-trybcns-test-claremont (repo first created 02:47Z by the earlier 401 run, reused), ev 1291 notified stage=onboarded. businesses.stage=onboarded, clients.repo_url set, ~/os origin/main 5d84350 "onboard: mudd-trybcns-test-claremont". Funnel complete, every stage scheduler-driven.
- Note: pitch job also ran on its ticks for real rows (evs 907-996, 1264-1265: pitched = files in ~/os only, no `sent` events for non-test rows). A stale `test-seed-bakery-test-town` row got pitched at 04:04Z (os d579eb5) — clean with the test row.
- Learned: concurrency group is per schedule with cancel-in-progress:false, so a long onboard tick (14 min) queues the next poll tick; GitHub keeps one pending run per group and cancels older pending ones (33943393299 cancelled). Harmless.
- 04:14Z 09-05: live verifier (fresh context) PASS on all 7 checks. Its caveat — GitHub actor is always the PAT owner nseluga-bcns — closed by the Cloud Scheduler execution log (bcns-leads, resource.type=cloud_scheduler_job): 204 POSTs at 01:42:22 clock-touch, 01:50:34 / 02:10:25 / 02:40:28 / 03:55:16 clock-poll, each seconds before runs 33936955615, 33937348667, 33938310153, 33939739457, 33943163481. No human dispatch in the window.
- 04:16Z 09-05: code verifier (fresh clone of e2e-live) PASS: 371 tests / 370 pass / 1 skip, lint green, no secrets in diff, DRY_RUN defaults on, production crons on e2e-live. Flagged: PR #6 was merged 23:23Z 09-04 (by nseluga-bcns) and PR #7 merged main back, so main carries the */5 test crons + matrix and lacks the `schedule` dispatch input. Therefore: default branch stays e2e-live and the scheduler ref stays e2e-live until the follow-up PR (e2e-live→main, 8 commits incl. 40284e7) merges; then Nate flips both.
- 04:16Z 09-05: cleanup done from here: DB rows for bd402c81 deleted (email_threads 8, clients 1, businesses 1; events kept as evidence), DRY_RUN var → true (04:15:10Z), bcns-os 9f91fa8 removes clients/mudd-trybcns-test-claremont + INDEX line. Handed to Nate: `gh repo delete` (needs delete_repo scope, interactive refresh), scheduler cadence restore (gcloud state change, classifier), default-branch/ref → main after the PR merges. Left alone, pre-existing: Test Seed */Mudd Stop/Call/Bump test rows and their os folders, os d579eb5 test-seed-bakery pitch.
