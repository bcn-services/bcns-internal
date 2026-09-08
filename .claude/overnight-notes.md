# Overnight notes — 2026-09-07 alert fixer run

- Heartbeat failure root cause: heartbeat job never in SCHEDULES, so the commit step ran with nothing to add. Fixed on `heartbeat-chain` (PR #9); manual dispatch 34195792321 green, commit c8c8de6 landed on the branch.
- Commit-heartbeat step `if:` originally matched the cron string only, so a manual `job=heartbeat` dispatch committed nothing. Extended to `|| inputs.job == 'heartbeat'`.
- Gmail `pipeline` filter now also matches `to:alerts@bcn-services.com` (Work profile, verified after reload). Only browser action taken.
- GitHub Actions run-failed mail IS an alert source: only format with live examples; bcns-internal is just another repo to the fixer.
- Parser (`lib/alerts.mjs`) hand-parses README frontmatter; no yaml import in lib/. Client READMEs carry no `site:` field, so UptimeRobot host → repo needs `ALERT_REPO_MAP` until one is added.
- Fixer tells Claude NOT to commit; the fixer commits so `git status --porcelain` cleanly separates "fix" from "triage-only".
- Workstream B lives on branch `alert-fixer` off main, separate from the heartbeat PR.
- Verifier B (PASS) flagged: subject-named repo was trusted blindly. Now `resolveRepo` accepts `parsed.repo` only when it equals the fallback, a map value, or a client README repo. Claude child gets a scrubbed env (childEnv), gh/git get a 2-min timeout. Mislabel-if-Claude-commits left as is (cosmetic).
- Same-seat forward to alerts@ has no Delivered-To: poll's To: fallback now also matches alertsAddress; parser strips `Fwd:` and detects GitHub run-failed by subject.
- Mutation checks: routing fallback removed → 1 triage test red; known-repo check removed → 1 alerts test red. `git checkout <file>` on an uncommitted file to undo a mutation wipes the real edits too — use a stash or re-apply the mutation by hand.
- Live proof: forwarded 45e294b mail → poll (JOB=poll, DRY_RUN=false, ALERT_REPO set) → fixer cloned, Claude reproduced the SCHEDULES root cause, pushed alert/2f338ba42240, draft PR #11 opened; closed as duplicate of #9. Gmail marks a self-forward read, so poll's UNSEEN fetch skips it until marked unread — real GitHub/Sentry/UptimeRobot mail arrives unread, so no code change.
- Repo vars set: ALERT_REPO=bcn-services/bcns-internal, ALERT_REPO_MAP=l2detailz + l2detailz.com hosts → bcns-client-l2detailz (host key is a guess; l2detailz README has no site: field).
- 2026-09-08 follow-up: Alerts gated on the client README `status:` (live = complete/active/dormant; ALERT_REPO/_MAP repos opt in) plus main-branch-only for GitHub mail — CI history can't tell shipped from building, Nate's point; the never-green gh check was dropped for that reason. Fixer prompt gets a where-you-are block + client README path instead of --add-dir (skip-permissions already reads ~/os; the pointer is what saves tokens).
