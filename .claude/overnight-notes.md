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
