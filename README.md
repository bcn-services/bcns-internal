---
type: jobs-runner
delivery: github-actions
name: bcns-outreach-pipeline
status: built, not yet live
---

# bcns outreach pipeline

A **headless jobs runner** for the bcns cold-outreach funnel. No server, no
frontend, no containers, no PM2. GitHub Actions is the only scheduler:
`clock.yml` fires on cron, `jobs/run.mjs` maps the cron string to one or more
job modules, each job runs once and exits.

Data lives in the Supabase project `knmgyxlrhjxaydliucbs` — Postgres only, no
auth, no storage, no user sessions. Mail goes out over SMTP through Google
Workspace on `send.bcn-services.com` and comes back in over IMAP.

`LANE.md` is the build contract and `LANE_PROGRESS.md` tracks position in it.
When they disagree, LANE.md wins. `CLAUDE.md` is the short version of this file
for agents.

## The funnel

One row in `businesses` moves through `stage` as the jobs pick it up:

```
sourced → qualified → drafted → sent ─┬→ replied      (a reply arrived)
                                      └→ call_due     (three touches, no reply)

call_due → /pitch → quoting → quoted → won → onboarded
                                          ↘ lost
```

`replied`, `won` and `lost` are written by `poll` — from the prospect's own
reply, or from an internal one-word command (`won 2400`, `no`). `call_due` is
reachable both from `touch` exhausting its three touches and from a command.

`suppressed_at` is orthogonal to all of it. It is a timestamp, never a stage,
and nothing in the schema can clear it.

## The jobs

Each is `jobs/<name>.mjs` exporting `run(deps)`. Every external dependency
arrives in `deps` — no module reaches for a global client, which is what makes
the whole suite testable without a network.

| job | schedule | what it does |
|---|---|---|
| `source` | Mon 13:00 | Picks one grid cell, searches Places, inserts unknown businesses as `sourced`. Reads the Google budget first and refuses to spend if it can't. |
| `qualify` | Mon 13:00, after `source` | Fetches the site, one Claude call, extracts a **published** email plus facts and a fit judgement. Verifies the address over SMTP `RCPT TO` without sending. → `qualified` |
| `personalize` | weekdays 13:30 | One Claude call producing the single generated sentence the template has a hole for. Validates the rendered draft; a failure leaves the row at `qualified` to retry. → `drafted` |
| `touch` | weekdays 14:00 | The sender. First touches out of the `drafted` buffer, then bumps. Three touches max, then the row becomes `call_due`. → `sent` |
| `poll` | every 20 min, 8–20 weekdays | Drains the `pipeline` IMAP label. Turns each reply into a suppression, a stage move, or a forward to a human. |
| `pitch` | every 20 min, after `poll` | A `call_due` row gets `/pitch` run against it; the artifact lands in `~/os` under `clients/<slug>/`. |
| `quote` | every 20 min, after `pitch` | A `quoting` row with a teammate's `notes` reply gets `/quote`. → `quoted` |
| `onboard` | every 20 min, after `quote` | A signed `won` row gets `/new-client-repo` + `/intake`. → `onboarded` |
| `notify` | every 20 min, last | Tells the internal humans what the tick left behind. Writes no business row, ever. |
| `heartbeat` | with the Monday run | Writes a dated file under `outputs/heartbeat` and commits it, so GitHub doesn't disable the schedules after 60 days of inactivity. |
| `authcheck` | manual dispatch | Proves the keyless GCP token exchange worked and reports whether the `~/os` clone landed. Calls no Google API. |

A job that is not built yet is skipped by `main()`, not a failed tick. A job
that exists and throws **does** fail the run — a broken pipeline must not look
green.

## Safety invariants

These are the rules the system's correctness actually rests on. Breaking one is
not a bug you notice; it is a bug a stranger notices, weeks later.

- **Reads go through `selectable_businesses`, never `businesses`.** The view
  filters out suppressed rows and is the opt-out boundary for the whole system.
  `lib/db.mjs` enforces it at runtime with `assertSelectable`.
- **Never construct an email address from a domain.** An unverified guess is a
  bounce and bounces destroy sending reputation. A business with no discoverable
  address is a calling lead, not a dead one.
- **Two recipient lists, deliberately not one.** `SEND_ALLOWED_RECIPIENTS` gates
  which *prospects* `touch` may mail. `NOTIFY_ALLOWED_RECIPIENTS` gates which
  *internal humans* get forwards, and is the only set whose one-word replies
  (`no`, `stop`, `won 2400`) are obeyed as commands. Merging them would deliver
  internal mail to a prospect and let that prospect drive the pipeline. Both
  fail closed: unset means nobody, never everybody.
- **Opt-out detection is weighted for recall and commits before the
  classifier.** A false positive is visible and recoverable; a false negative is
  invisible forever.
- **`DRY_RUN` defaults to on.** A job opts into side effects explicitly.
- **A completion marker is written only after a real push.** Pushes go through
  `pushOrSkip` (`lib/osrepo.mjs`); a dry-run push writes a `skipped` event and
  the row keeps its stage, so the next live tick redoes it. Marking a row done
  on a dry run makes it unreachable forever.
- **Every job writes at least one `events` row** — job, kind, detail JSON. A job
  that did nothing writes a `skipped` event saying why.
- **Never edit or delete an applied migration.** `supabase/migrations/` is the
  only record of the live schema; a human applies them with the Supabase CLI.

## Layout

- `jobs/` — one job each, plus `run.mjs`, the dispatcher that owns the schedule
  map and builds `deps` from the environment alone.
- `lib/` — shared helpers. **`lib/db.mjs` is the only module that writes SQL.**
  - `places.mjs` bearer-token Places search · `budget.mjs` month-to-date Places
    spend, asked of Google and failing closed · `grid.mjs` the trade × town
    search grid this repo owns · `claude.mjs` / `skills.mjs` shell out to the
    Claude Code CLI · `template.mjs` the cold-email copy (authoring source is
    `~/os/skills/outreach/SKILL.md` — change that first) · `trim.mjs` caps page
    text before it reaches a prompt · `verify.mjs` MX + `RCPT TO` probe that can
    never issue `DATA` · `osrepo.mjs` pushes skill output back to `~/os`.
- `supabase/migrations/` — plain SQL. 0001–0016 are the retired command-center
  schema; `0017_reset.sql` drops it and `0018_pipeline.sql` onward are the
  pipeline.
- `tests/` — `pnpm test` runs `tsx --test` over the files named in
  `package.json`. **Every new test file must be added to that list.**
- `docs/NOTIFICATIONS.md` — mailbox and app-password setup.

## Capabilities are env-gated

`buildDeps` constructs each capability only when its credential is present, so
what a job is handed is inspectable without a database or a Google token in
sight. A missing credential means the job is not given that capability and
writes its own `skipped` event — never a crash.

| variable | gates |
|---|---|
| `DATABASE_URL` | `sql`, `db`, `logEvent`, the grid readers |
| `GCP_PROJECT` + a minted OIDC token | `places`, `readBudget` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude` (the CLI, billed to the subscription — there is no API-key path) |
| `MAIL_FROM` | the address-verification probe |
| `SMTP_PASS` | the outbound transport |
| `IMAP_PASS` | the inbox reader |
| `OS_DIR` pointing at a real directory | `runSkill`, `commitAndPush`, the voice rules |
| `SEND_ALLOWED_RECIPIENTS` / `NOTIFY_ALLOWED_RECIPIENTS` | who may be mailed at all |
| `DRY_RUN` | side effects; **on unless explicitly `"false"`** |

## Running

```bash
pnpm install
pnpm test          # 334 tests, pure — no network, no DB, no mail
pnpm lint          # node --check over every .mjs

JOB=authcheck pnpm job        # run one job by name
SCHEDULE='0 14 * * 1-5' pnpm job   # or by the cron string it answers to
```

Tests are pure by rule. Every boundary — Places, Claude, HTTP, Postgres, SMTP,
IMAP — is a parameter with a fake supplied by the test. A test that needs a live
service is the wrong test; assert on the request the code *would* have made.

`ci.yml` runs lint + tests on every push and PR, and needs no secrets because of
the above.

## Status

Built and green, **not yet running live.** Every tick to date has been a dry
run. Before a first real send:

- `DRY_RUN` is still on, and both recipient allow-lists gate every send
  independently of it.
- **`clock.yml` passes no `IMAP_PASS`**, so `poll` has no inbox reader and
  writes a `skipped` event every tick — the whole reply path is currently inert.
  `ONBOARD_NOTIFY_TO` is likewise unset, so the onboard handover mail reaches
  nobody.
- Known open items are tracked in `LANE.md` under "Found during the 2026-08-31
  autonomous run" — notably that a mailbox slot claimed by a send that then
  throws is never released (fails safe: it under-sends), and that the notify
  dedupe key does not re-arm on stage re-entry.

## Never

Send mail from a test or a dev run · apply a migration to production · commit to
`main` · force-push · `DROP`/`DELETE FROM` against a live database · read or
rewrite `.env.local` values.
