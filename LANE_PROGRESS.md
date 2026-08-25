# Progress

LANE.md is the contract; this tracks where we are in it. If they disagree,
LANE.md wins for scope.

**Current position**
- Status: items 1–4 done, items 5–13 pending
- Next: item 5 — skill buttons and job-function gating
- Blockers: none
- Last updated: 2026-08-24

| Item | Status |
|------|--------|
| 1. Migration harness + production ledger backfill | done — every migration on disk now replays end to end on a throwaway database, and the production database finally records which migrations have been applied, so the next deploy will not try to run them all again |
| 2. Migration 0009 — automation schema | done — the database now knows the difference between work a person did and work an agent did, keeps every employee's inbox private even from an admin, and can record which leads are being contacted automatically and which are being handled by hand. A member can no longer forge an agent's audit trail. |
| 3. Agent verb layer | done — an agent can now look up and change leads, clients, tasks and activity through a fixed set of typed commands instead of a shell, and each command checks who is asking before it touches anything. Money figures are removed automatically for anyone who is not an admin. Two serious holes were found and closed: a crafted web address could have made the site-reader fetch private internal servers. |
| 4. Activity capture and parsing | done — a person can now type what happened in plain English ("called Mike at Coventry Tuesday, wants a quote by Friday") and the system turns it into a proper logged record, showing it for correction before anything is saved. Relative dates resolve against the person's own local date, not UTC. Closing a task now asks its assignee to log what happened. The review also found the activity history was not trustworthy: an admin could quietly edit or delete any past record, agent-written ones included, and most records had no author at all. It is now append-only and stamps the author itself, so history cannot be rewritten. Two lead actions that had been failing at runtime were fixed. |
| 5. Skill buttons and job-function gating | not started |
| 6. Inbox | not started |
| 7. Notification routing | not started |
| 8. Daily briefing | not started |
| 9. Job runner and first three jobs | not started |
| 10. Lead outreach lanes and sweep | not started |
| 11. README export generator | not started |
| 12. Admin configuration surface | not started |
| 13. Final integration pass and review handoff | not started |
