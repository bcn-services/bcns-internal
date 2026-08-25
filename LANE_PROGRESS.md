# Progress

LANE.md is the contract; this tracks where we are in it. If they disagree,
LANE.md wins for scope.

**Current position**
- Status: items 1–7 done (7 partly blocked), items 8–13 pending
- Next: item 8 — the daily briefing
- Blockers: item 7's send half — no mail provider is configured. Configuring Resend needs an interactive signup. See docs/NOTIFICATIONS.md.
- Last updated: 2026-08-24

| Item | Status |
|------|--------|
| 1. Migration harness + production ledger backfill | done — every migration on disk now replays end to end on a throwaway database, and the production database finally records which migrations have been applied, so the next deploy will not try to run them all again |
| 2. Migration 0009 — automation schema | done — the database now knows the difference between work a person did and work an agent did, keeps every employee's inbox private even from an admin, and can record which leads are being contacted automatically and which are being handled by hand. A member can no longer forge an agent's audit trail. |
| 3. Agent verb layer | done — an agent can now look up and change leads, clients, tasks and activity through a fixed set of typed commands instead of a shell, and each command checks who is asking before it touches anything. Money figures are removed automatically for anyone who is not an admin. Two serious holes were found and closed: a crafted web address could have made the site-reader fetch private internal servers. |
| 4. Activity capture and parsing | done — a person can now type what happened in plain English ("called Mike at Coventry Tuesday, wants a quote by Friday") and the system turns it into a proper logged record, showing it for correction before anything is saved. Relative dates resolve against the person's own local date, not UTC. Closing a task now asks its assignee to log what happened. The review also found the activity history was not trustworthy: an admin could quietly edit or delete any past record, agent-written ones included, and most records had no author at all. It is now append-only and stamps the author itself, so history cannot be rewritten. Two lead actions that had been failing at runtime were fixed. |
| 5. Skill buttons and job-function gating | done — employees can now run a skill straight from the page where that work happens: pitch and quote on a lead or client, intake on a client, lead generation and system-improvement for admins only. Which buttons a person sees follows their job: sales and admins see the client-facing ones, developers see none, because every developer skill needs a cloned repo. Hiding a button is only tidiness — the server still refuses a run the person is not allowed to make, whatever the browser claims. Every run is recorded with who started it and how it ended. |
| 6. Inbox | done — every employee now has a private inbox in the app, newest first, with unread marks and a count in the sidebar. Items link to whatever they are about, and replying to one logs the contact through the same review-before-saving step as the capture box. Privacy is enforced by the database itself, not by the page: nobody, admin included, can read or alter anyone else's inbox. The count in the sidebar is cached, so it does not query on every page you open. |
| 7. Notification routing | done, except sending — the system now decides on its own whether something belongs in your inbox, your email, or both. Email goes out for exactly three things: a scheduled run that failed, a task assigned to you, and a lead saying they want to meet. Briefings, successful runs and agent proposals stay in the inbox only. Everything reaches the inbox no matter what. No mail provider is set up yet, so emails are written out in full and parked in a queue rather than lost — once Resend is configured they can be sent. docs/NOTIFICATIONS.md has the 12 steps. |
| 8. Daily briefing | not started |
| 9. Job runner and first three jobs | not started |
| 10. Lead outreach lanes and sweep | not started |
| 11. README export generator | not started |
| 12. Admin configuration surface | not started |
| 13. Final integration pass and review handoff | not started |
