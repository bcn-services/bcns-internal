# ON HOLD — 2026-08-25

This project is paused. Read this before doing anything in the repo.

## What is still live

**Only the Supabase project `knmgyxlrhjxaydliucbs`.** An abbreviated version runs
against it. Its schema is still owned by *this* repo's `supabase/migrations/` —
add migrations here, apply from here, or the two will diverge and neither will
have an accurate migration history.

**Nothing in this repo connects to it any more.** At hold time the only live
connection was a `next dev -p 3100` server running on Nate's machine; it was
killed. Nothing restarts it — there is no launchd agent, no crontab line, no
Claude Code scheduled job, and no PM2 process anywhere on the machine that
references this repo or that project ref.

**Nothing here can reach Claude either.** `.env.local` has `AI_ENABLED="0"` and
carries no Anthropic key at all, so `lib/agent/runner.ts` — the one path that
spawns the Claude Code CLI — cannot fire even if the app is started by hand.

**CI is disabled.** `.github/workflows/ci.yml` is `disabled_manually`; pushes to
`main` queue nothing. It never touched the production database (it stands up a
throwaway Supabase stack, and the only repo secret is `GH_PACKAGES_TOKEN` — no
database credential and no API key is stored in Actions). It was switched off to
stop red-run noise, not for safety. The last run on `main` failed in the shadow
stack's container (`supabase db reset` → `error running container: exit 1`) —
infrastructure, not code; the commit before it ran 845/845 green. Deliberately
not chased.

### To reconnect on resume

    gh workflow enable ci      # in ~/bcns-internal
    corepack pnpm dev          # localhost:3100

Set `AI_ENABLED=1` and add an Anthropic key only when the agent layer is wanted
again.

## State at hold time

- `main` holds everything. Branch `command-center` is merged and deleted.
- CI green: **845 tests / 139 suites / 0 fail**, typecheck clean.
- Migrations 0001–0016 applied to production and verified.
- Working tree clean, fully pushed.
- CI disabled; dev server killed; AI off. See above.
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
