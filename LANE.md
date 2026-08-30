# bcns Outreach Pipeline — First Draft

Rebuilds this repo from a paused Next.js app into a headless jobs runner for the
two-mailbox cold-outreach pipeline. Full reasoning, diagrams, and phase
sequencing live in the plan artifact — this file is the executable subset.

The repo is currently on hold (`HOLD.md`). Nothing connects to Supabase, CI is
disabled, and no process anywhere references it. That is the intended starting
state: this round strips the app and builds the pipeline's foundation.

**Scope of this round:** everything above the stop marker. Leads flow from Google
Places into the database, get qualified with an email address discovered, and the
clock that will drive everything is standing and tested. Sending, polling, and
reply parsing are below the marker and are not touched.

Repo context: `CLAUDE.md` at root (rewritten by item 1 — the current one is the
stale client-app template and describes nothing in this repo).

## Global rules — apply to every item

**Allowed without asking. Permission prompts are pre-approved.**
- All code in `~/bcns-internal`, on a lane branch
- Authoring SQL migrations as files
- `git commit` on the lane branch
- Installing the dependencies named in item 1

**Forbidden. Mark the item `blocked`, write why, move on — never work around.**
- Sending any email to any address, real or test. This round has no send path.
- Applying any migration to the production Supabase project `knmgyxlrhjxaydliucbs`.
  Migrations are authored as files and applied by a human.
- Calling the real Google Places API, the real Anthropic API, or fetching any real
  website. Every external dependency is injected and faked in tests.
- Reading or rewriting the values in `.env.local`. The file stays as-is.
- `DROP` or `DELETE FROM` against any live database, force-push, history rewrite,
  or any commit to `main`.
- Deleting anything under `supabase/migrations/`. The history is the only record
  of the live schema.

**Testing conventions.**
- `pnpm test` is `tsx --test tests/<file>.test.mjs …`. Every item that adds a test
  file adds it to that list in `package.json`.
- **Tests must be pure.** No network, no database, no filesystem outside a temp
  dir. Every external boundary (Places, Claude, HTTP fetch, Postgres, SMTP) is a
  function parameter with a fake supplied in the test.
- A test that needs a live service is the wrong test. Assert on the request the
  code *would* have made instead.

## Conventions this round establishes

- Jobs live in `jobs/<name>.mjs`, each exporting `run(deps)` and taking every
  external dependency in `deps`. No module reaches for a global client.
- Shared helpers live in `lib/`. `lib/db.mjs` is the only module that builds SQL.
- Every job writes at least one row to `events` — job name, kind, detail JSON.
  A job that did nothing writes a `skipped` event saying why.
- `DRY_RUN` defaults to on everywhere. A job must opt into side effects.

---

- task: Strip the repo to a headless jobs runner. Delete the Next.js app and
    everything that served it — `app/`, `lib/`, `tests/`, `public/`,
    `os-staging/`, `scripts/`, `middleware.ts`, `next.config.mjs`,
    `eslint.config.mjs`, `next-env.d.ts`, `tsconfig.tsbuildinfo`, `TEMPLATE.md`,
    `DEPLOY.md`, `REVIEW.md`, `STANDARDS.md`, `HOLD.md`. Rewrite `package.json`:
    drop `next`, `react`, `react-dom`, `@supabase/ssr`, `@supabase/supabase-js`,
    `server-only`, `@nseluga/ui`, and every Next-related dev dependency; add
    `imapflow`, `mailparser`, and `postgres`; keep `nodemailer` and `tsx`; replace
    the `scripts` block with `test`, `job`, and `lint`, where `test` lists only
    this round's new test files. Rewrite `CLAUDE.md` to describe what this repo
    actually is now — a jobs runner driven by GitHub Actions, no server, no
    frontend, no PM2, no Resend — replacing the stale client-app template text.
    Create empty `jobs/`, `lib/`, and `tests/` directories with a placeholder
    smoke test so `pnpm test` has something to run.
  guardrails:
    - Never delete or edit anything under `supabase/migrations/` — it is the only
      record of the live schema and later items depend on it
    - `.env.local`, `.env.example`, `.npmrc`, `.github/`, `pnpm-workspace.yaml`,
      `README.md`, `LANE.md`, and `LANE_PROGRESS.md` all survive untouched
    - `docs/` survives — `docs/NOTIFICATIONS.md` holds the mailbox and app-password
      setup steps that phase 1 still needs
    - Deletions are `git rm`, so every removal is recoverable from history
  done when:
    - `pnpm install` completes without error and `node_modules` contains
      `imapflow`, `mailparser`, and `postgres`
    - `pnpm test` runs the placeholder smoke test and exits zero
    - `git log --stat` shows zero changes under `supabase/migrations/`
    - No file outside `node_modules` imports `next`, `react`, or `@supabase/ssr`
  caution: true
  status: done

- task: Author the two schema migrations as files. `0017_reset.sql` drops the
    command-center application tables that migrations 0001–0016 created, leaving
    Supabase's own `auth` and `storage` schemas untouched. `0018_pipeline.sql`
    creates the pipeline schema: `businesses` (identity, `stage`, `next_touch_at`,
    `touches`, `suppressed_at`, `research jsonb`, `place_id`, `source_query`),
    `mailboxes` (address, domain, `daily_cap`, `sent_today`, `warmed_at`,
    `status`), `search_grid` (trade, town, state, `exhausted_at`, `last_run_at`,
    `new_rows_last_run`), `email_threads` (`message_id` primary key,
    `business_id`, direction, mailbox), `events` (bigserial, job, kind,
    `detail jsonb`), and `alerts` (unique `fingerprint`, repo, source, status,
    `pr_url`, `hits`). Add a partial unique index on `lower(email)`, a unique
    index on `place_id`, a partial index on `next_touch_at` for unsuppressed rows,
    a `stage` check constraint, and the `selectable_businesses` view defined as
    every column of `businesses` where `suppressed_at is null`. Seed `mailboxes`
    with exactly one row for `outreach@send.bcn-services.com`. RLS on with
    deny-all policies — every job connects as the service role.
  guardrails:
    - Author files only. Never connect to, or apply anything against, the live
      Supabase project — a human applies these
    - `suppressed_at` is a timestamp, never a stage value, and nothing in the
      schema provides a way to clear it
    - Never edit an already-applied migration; 0017 and 0018 are new files
  done when:
    - A test reads `0018_pipeline.sql` and asserts the `selectable_businesses`
      view filters on `suppressed_at is null`, and that `businesses` carries the
      `stage` check constraint listing all eleven stages
    - A test asserts `0018_pipeline.sql` creates a unique index over
      `lower(email)` and one over `place_id`
    - A test asserts `0017_reset.sql` contains no reference to the `auth` or
      `storage` schemas
    - Both files are valid SQL as judged by a parse that rejects unbalanced
      parentheses and unterminated statements
  caution: true
  status: done

- task: Build `lib/db.mjs`, the only module in the repo that writes SQL. It
    exposes read helpers (`dueBusinesses`, `businessByEmail`, `businessByPlaceId`,
    `qualifiedBacklog`), write helpers (`insertBusinesses`, `updateBusiness`,
    `suppress`, `recordThread`), and `logEvent(job, kind, detail)`. Every read
    helper targets the `selectable_businesses` view. Export a `assertSelectable`
    guard used internally that throws when a read query string references
    `from businesses` directly, so the suppression boundary cannot be bypassed by
    a later edit. The Postgres client is passed in, never constructed here.
  guardrails:
    - No read helper may query the `businesses` table directly — the view is the
      only read surface, and this is the invariant the whole system's opt-out
      safety rests on
    - `suppress()` is the only writer of `suppressed_at`, and it never writes null
    - Never construct a database connection inside this module
  done when:
    - A unit test drives every read helper with a fake client that records SQL,
      and asserts each query references `selectable_businesses` and none contains
      `from businesses`
    - A unit test asserts `assertSelectable` throws when handed a query string
      selecting directly from `businesses`
    - A unit test asserts `logEvent` writes one row carrying job, kind, and the
      detail object, and that it does so even when the detail object is empty
    - A unit test asserts `suppress()` called twice on the same business leaves
      the original timestamp unchanged
  caution: true
  status: done

- task: Stand up the clock. Add `.github/workflows/clock.yml` with three cron
    entries — `*/20 8-20 * * 1-5` for poll, `0 14 * * 1-5` for touch, and
    `0 13 * * 1` for source — plus a `workflow_dispatch` input for running any job
    by name, and a concurrency group keyed on the schedule so two ticks of the
    same job never overlap. Add `jobs/run.mjs`, a dispatcher that maps the incoming
    cron string (or dispatch input) to a job module, runs it, and exits non-zero on
    an unknown name. Add `jobs/heartbeat.mjs`, which writes a dated file to
    `outputs/heartbeat` and is what the weekly source run commits to keep GitHub
    from disabling the schedule after sixty days of repo inactivity. Every job runs
    under `timeout-minutes: 10`.
  guardrails:
    - The workflow must not reference any secret that does not yet exist — it is
      committed before the secrets are set, and must parse regardless
    - Never add a cron more frequent than every twenty minutes; anything tighter
      exceeds the free Actions allowance
    - `jobs/run.mjs` never catches and swallows a job's error — a failed job must
      fail the workflow run
  done when:
    - A test parses `clock.yml` as YAML and asserts exactly the three cron
      expressions above, a `workflow_dispatch` trigger, and a concurrency block
    - A unit test asserts the dispatcher maps each of the three cron strings to
      the correct job name, and exits non-zero for an unrecognised one
    - A unit test asserts `heartbeat` writes a file whose contents include the
      run date and that running it twice in one day leaves one file
  status: done

- task: Build weekly sourcing over a search grid, with exhausted-cell detection.
    Add `lib/grid.mjs` holding the trade-by-town grid as data (start with the eight
    trades and the Connecticut and Rhode Island towns the `leads` skill already
    names) and two pure functions — `pickNextCell(cells)`, which returns the least
    recently run cell that is not exhausted, and `evaluateRun(cell, results)`,
    which marks a cell exhausted when a run returns more than ninety percent
    already-known `place_id`s. Add `jobs/source.mjs`: check the Places monthly
    budget first and stop without calling Places if the remaining allowance is
    short, pick a cell, search it, drop results whose `place_id` is already known,
    insert the rest at stage `sourced`, record the outcome on the grid row, and
    write an `events` row either way. The Places client and the budget reader are
    injected.
  guardrails:
    - The grid is data this repo owns — never let the job invent a trade or a town
      that is not already a row in the grid
    - The monthly Places budget is checked before the first call and between
      pages; a job that cannot read the budget must not spend
    - Never re-insert a `place_id` that already exists; dedupe before writing
  done when:
    - A unit test with a fake Places client returning entirely known `place_id`s
      asserts the cell is marked exhausted and that `pickNextCell` never returns
      it again
    - A unit test asserts `pickNextCell` returns the least recently run
      unexhausted cell, and returns null when every cell is exhausted
    - A unit test with a fake budget reader below the required allowance asserts
      the Places client is never called and a `skipped` event is written
    - A unit test asserts inserted rows carry `place_id`, `source_query`, and
      stage `sourced`, and that a result already in the database is not inserted twice
  status: done

- task: Build qualification — one fetch, one Claude call, per business. Add
    `lib/trim.mjs`, which converts an HTML page to plain text, strips `script`,
    `style`, `nav`, and `footer` content, collapses whitespace, and caps the result
    at 7000 characters. Add `jobs/qualify.mjs`: for each business at stage
    `sourced`, fetch the homepage and one likely contact page, trim both, and make a
    single Claude call returning an email address, three to five specific facts
    about the business, and a fit judgement. Write the facts to `research`, the
    address to `email`, and move the row to stage `qualified`. A business with no
    discoverable email moves to stage `call_due` with its phone preserved — it is a
    calling lead, not a dead one. The fetcher and the Claude client are injected.
  guardrails:
    - Never guess or construct an email address from the domain — an unverified
      guess is a bounce, and bounces are what destroy sending reputation
    - The text sent to Claude is capped; a large page must never produce a large
      prompt
    - A site that fails to fetch produces no email and no facts — never a fabricated
      one. The row stays at `sourced` and an error event is written
  done when:
    - A unit test asserts `trim` on a 500KB HTML page yields at most 7000
      characters and that the output contains no `script` or `style` content
    - A unit test with a fake fetcher and a fake Claude client asserts a qualified
      row carries an email and at least three entries in `research`
    - A unit test asserts a business whose page yields no email lands at stage
      `call_due` with its `phone` value unchanged and its `email` still null
    - A unit test asserts a fetch that throws leaves the row at stage `sourced`
      and writes one `error` event naming the business
  caution: true
  status: done

> **⚠️ AUTONOMOUS RUN — STOP HERE**

- task: Verify discovered email addresses before any of them are ever mailed — MX
    lookup plus an SMTP `RCPT TO` probe that disconnects without sending, with the
    resolver and the SMTP socket injected.
  guardrails:
    - The probe must never transmit a message body
  done when:
    - A unit test with a fake resolver asserts a domain with no MX record is
      rejected without opening a socket
    - A unit test asserts the probe issues `RCPT TO` and then `QUIT`, never `DATA`
  status: not started

- task: Build personalization — the single Claude call that produces the cold
    email copy and the demo slot values together, using hand-written example emails
    as the voice reference, keeping a buffer of ready-to-send drafts.
  guardrails:
    - One Claude call per business, never a generation call plus a humanizer pass
    - Every factual claim in the email traces to a field in `research`
  done when:
    - A unit test asserts one Claude call per business
    - A unit test asserts a business with fewer than three `research` facts is
      skipped rather than written with thin copy
  status: not started

- task: Build the sender — round-robin across `mailboxes` rows with remaining
    daily capacity, per-mailbox warming ramp, jittered send times.
  guardrails:
    - A mailbox at its `daily_cap` is never selected, and the cap is never exceeded
      by a concurrent run
    - The thread row and the counter update commit in the same transaction as the send
  done when:
    - A unit test asserts a mailbox at capacity is skipped and the next is chosen
    - A unit test asserts the warming ramp yields the per-mailbox cap for a given
      `warmed_at` age
  status: not started

- task: Build the poller and the reply parser — IMAP over the `pipeline` label,
    thread mapping by `In-Reply-To` then `References`, routing by `Delivered-To`,
    with suppression checked before any other branch.
  guardrails:
    - Opt-out detection runs and commits before classification, always
    - An unmatched message is forwarded for a human to read, never guessed at
  done when:
    - A unit test asserts a message containing opt-out intent sets `suppressed_at`
      even when classification throws
    - A unit test asserts an out-of-office reply changes no stage
  status: not started

- task: Build the four notification emails — batch approval, call task, meeting,
    and quote handoff.
  status: not started

- task: Build alert triage — `alerts@` messages become draft pull requests,
    never merges, capped at three triage runs per day.
  guardrails:
    - Never push to `main` and never merge a pull request
  status: not started

---

## Not yet specified

- Whether the demo template is one layout with swapped content or a small set
  chosen by trade — revisit after the personalization item, when real output
  exists to judge
- How `search_grid` gets seeded beyond the initial Connecticut and Rhode Island
  towns — revisit once one real sourcing run shows the duplicate rate
- What the fit judgement from qualification is actually used for; it is recorded
  this round and acted on in no item

## Out of scope

- Retiring the Google Sheet funnel and porting `sheets.py stats` onto SQL —
  agreed, but it is `~/os` work, not this repo's
- Google Workspace aliases, DNS records, GitHub secrets, Workload Identity
  Federation, and applying migrations — all require a human at a console
- Multiple sending domains and mailboxes — the schema supports it from day one
  with a single seeded row; buying and warming them is a later, funded decision
- Any web interface. This repo has no server in it after item 1
