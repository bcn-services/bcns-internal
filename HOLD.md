# ON HOLD — 2026-08-25

This project is paused. Read this before doing anything in the repo.

## What is still live

**Only the Supabase project `knmgyxlrhjxaydliucbs`.** An abbreviated version runs
against it. Its schema is still owned by *this* repo's `supabase/migrations/` —
add migrations here, apply from here, or the two will diverge and neither will
have an accurate migration history.

Nothing else runs. No deployment exists, no cron line is installed, no launchd
agent or crontab entry references this repo, and `.github/workflows/ci.yml` has
no `schedule` trigger — it fires only on push/PR to `main` and on manual
dispatch. Vercel was never connected, so there is nothing to tear down.

## State at hold time

- `main` holds everything. Branch `command-center` is merged and deleted.
- CI green: **845 tests / 139 suites / 0 fail**, typecheck clean.
- Migrations 0001–0016 applied to production and verified.
- Working tree clean, fully pushed.
- `email_outbox` holds `pending` rows. Nothing was lost; nothing was sent.

## Deliberately deferred — do not treat as forgotten

- **Second sending domain: not purchased.** It needs ~2 weeks of warming and the
  clock would expire before Phase 2 could use it. Buy it at resume time, in the
  same sitting as the mailbox below.
- **`bot@bcn-services.com` + app password: never created.** Until it exists every
  notice parks in `email_outbox`. Steps are in `docs/NOTIFICATIONS.md`.
- **Outreach lane machine: dormant on purpose.** Counting drafts as touches would
  fabricate contact history for leads nobody emailed.

## Dated risk

The GitHub PAT that lets CI install the private `@nseluga/*` packages **expires
2026-10-31**. A revisit after that date fails at install with a 401 until it is
rotated — see `reference-bcns-ci-setup.md` in `~/os/knowledge/memory/` for all
the places it lives.

Related: the `@nseluga/*` packages are owned by the personal `nseluga` GitHub
account, while CI authenticates as `nseluga-bcns`. That machine account has been
granted **Read** on `app-core`, `ui`, and `config`. If a *new* `@nseluga` package
is added, it needs the same grant or CI 403s.

## Where to pick up

Phase 0 stopped before Vercel. The plan is
`~/.claude/plans/write-yourself-a-plan-glittery-lobster.md` — resume at **Step F**
(import into the `bcns` Vercel team, Work Chrome profile only, IPv4 pooler for
`DATABASE_URL`). `REVIEW.md`'s click-through is **8 steps**; original steps 1 and 7
were cut with the surfaces they tested.
