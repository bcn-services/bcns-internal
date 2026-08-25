# Progress

LANE.md is the contract; this tracks where we are in it. If they disagree,
LANE.md wins for scope.

**Current position**
- Status: item 1 done, items 2–13 pending
- Next: item 2 — migration 0009, the automation schema
- Blockers: none
- Last updated: 2026-08-24

| Item | Status |
|------|--------|
| 1. Migration harness + production ledger backfill | done — every migration on disk now replays end to end on a throwaway database, and the production database finally records which migrations have been applied, so the next deploy will not try to run them all again |
| 2. Migration 0009 — automation schema | not started |
| 3. Agent verb layer | not started |
| 4. Activity capture and parsing | not started |
| 5. Skill buttons and job-function gating | not started |
| 6. Inbox | not started |
| 7. Notification routing | not started |
| 8. Daily briefing | not started |
| 9. Job runner and first three jobs | done — scheduled work now has a proper home: a job opens a record, runs, and always closes that record even when it crashes, so a job can never silently vanish. Three jobs exist: a daily check that every hosted client site is up, a weekly warning 30 days before any credential expires, and a daily detector for onboarding clients who have gone quiet for a week. Clients with no website recorded are reported as 'cannot be monitored' rather than quietly counted as healthy. Running a job twice in the same window produces one notification, not two, proven against genuinely simultaneous runs. Nothing is scheduled yet — the cron lines are written down in docs/JOBS.md for when the droplet exists. |
| 10. Lead outreach lanes and sweep | not started |
| 11. README export generator | not started |
| 12. Admin configuration surface | not started |
| 13. Final integration pass and review handoff | not started |
