# CLAUDE.md — bcns outreach pipeline

## What this repo is

A **headless jobs runner** for the bcns cold-outreach pipeline. No server, no
frontend, no PM2, no Resend. GitHub Actions is the only scheduler: `clock.yml`
fires on cron, `jobs/run.mjs` maps the cron string to a job module, the job runs
once and exits. Data lives in the Supabase project `knmgyxlrhjxaydliucbs`
(Postgres only — no auth, no storage, no RLS-backed user sessions). Mail goes
out over SMTP through Google Workspace on `send.bcn-services.com`.

`LANE.md` is the build contract; `LANE_PROGRESS.md` tracks where we are in it.
When they disagree, LANE.md wins.

## Layout

- `jobs/<name>.mjs` — one job each, exporting `run(deps)`. Every external
  dependency arrives in `deps`; no module reaches for a global client.
- `lib/` — shared helpers. **`lib/db.mjs` is the only module that writes SQL.**
- `supabase/migrations/` — plain SQL, applied by a human via the Supabase CLI.
  Never edit an applied migration, never delete one; it is the only record of
  the live schema.
- `tests/` — `pnpm test` runs `tsx --test` over the files named in
  `package.json`. Every new test file gets added to that list.
- `docs/NOTIFICATIONS.md` — mailbox and app-password setup steps.

## Rules

- **Reads go through `selectable_businesses`, never `businesses`.** The view
  filters out suppressed rows; it is the opt-out boundary the whole system's
  safety rests on. `lib/db.mjs` enforces this with `assertSelectable`.
- **Never construct an email address from a domain.** An unverified guess is a
  bounce, and bounces destroy sending reputation.
- **Every job writes at least one `events` row** — job, kind, detail JSON. A job
  that did nothing writes a `skipped` event saying why.
- **`DRY_RUN` defaults to on.** A job opts into side effects explicitly.
- **A completion marker is written only after a real push.** A job that pushes
  to ~/os goes through `pushOrSkip` (`lib/osrepo.mjs`): a dry-run push writes a
  `skipped` event and the row keeps its stage and its research, so the next live
  tick redoes it. Marking a row done on a dry run makes it unreachable forever.
- **Tests are pure.** No network, no database, no filesystem outside a temp dir.
  Every boundary (Places, Claude, HTTP fetch, Postgres, SMTP) is a parameter with
  a fake supplied in the test. A test needing a live service is the wrong test —
  assert on the request the code *would* have made.

## Never

Send mail from a test or a dev run · apply a migration to production · commit to
`main` · force-push · `DROP`/`DELETE FROM` against a live database · read or
rewrite `.env.local` values.
