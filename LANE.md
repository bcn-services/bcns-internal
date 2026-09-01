# bcns Outreach Pipeline

Rebuilds this repo from a paused Next.js app into a headless jobs runner for the
cold-outreach pipeline. This file is the contract; the "Pipeline Wiring"
artifact (2026-08-30) is the explanation. Older artifacts are superseded.

**Status 2026-08-31:** items 1–7 are on `main`; `outreach-pipeline` was
fast-forwarded in and the branch is level with `main`. Migrations 0017/0018 are
applied to production. The clock fires and `authcheck` is green. Nothing else
has run live: `run.mjs` injects only `sql, db, logEvent, loadCells, saveCell,
dryRun`, so `source` no-ops on a missing budget reader and `qualify` is in no
schedule at all. Mail is fully set up — aliases, app password, the `pipeline`
filter, and `SEND_ALLOWED_RECIPIENTS`/`NOTIFY_ALLOWED_RECIPIENTS` as repo
variables — and blocks nothing.

**Status 2026-09-01:** items 1–14 merged (PR #3); PR #4 `pipeline-fixes` holds
the daily-cap reset, the qualify crash fix and migrations 0019–0021. Nothing has
run live. Design change 2026-09-01: **there is no approval step.** `touch` sends
on schedule; a `call_due` row gets a `/pitch` folder; Brandon's `notes` reply
runs `/quote`; his `signed` reply with the PDF runs `/new-client-repo` +
`/intake` and mails Nate. Every artifact lands in `bcns-os` under
`clients/<slug>/`; mail carries paths and instructions, never attachments.

**Scope of this round:** items 15–20, above the stop marker, are the autonomous
run. Item 21 below it waits.

**Mail architecture (decided 2026-08-30, supersedes "two mailboxes"):** one
Google Workspace seat — Nate's — with two aliases. `outreach@send.bcn-services.com`
is the send-as address for cold mail (DKIM signs as `send.`, DNS live).
`bot@bcn-services.com` receives Brandon's replies and sends internal notices. A
Gmail filter labels every reply `pipeline`. One app password on Nate's account
is both `SMTP_PASS` and `IMAP_PASS`. Trade-off accepted: a reputation strike
lands on Nate's account; mitigated by `SEND_ALLOWED_RECIPIENTS`, the warming
ramp, and a per-mailbox cap. The `mailboxes` table already abstracts the sender,
so moving `outreach@send` to a non-Google host (Zoho, ~$1/mo) later is a row
change, not a rewrite. No second Google seat.

Repo context: `CLAUDE.md` at root.

## Global rules — apply to every item

**Allowed without asking. Permission prompts are pre-approved.**
- All code in `~/bcns-internal`, on a lane branch
- Authoring SQL migrations as files
- `git commit` on the lane branch
- Installing the dependencies named in item 1

**Environment gotcha.** `gh` 404s on this repo: the `read:packages` PAT exported
as `GITHUB_TOKEN` in `~/.zprofile` shadows the keyring account, and GitHub
answers an unsatisfiable scope with 404, not 403. Prefix `GITHUB_TOKEN=` for
anything repo-scoped. A 404 here means the token, not a missing repo.

**Forbidden. Mark the item `blocked`, write why, move on — never work around.**
- Executing a send — opening SMTP to a real server, or issuing `DATA` outside a
  fake. Building a send path is in scope: items 11 and 13 do exactly that. Every
  test fakes the transport, and `DRY_RUN` stays on.
- Applying any migration to the production Supabase project `knmgyxlrhjxaydliucbs`.
  Migrations are authored as files and applied by a human.
- Calling the real Google Places API, the real Anthropic API, or fetching any real
  website. Every external dependency is injected and faked in tests.
- Reading or rewriting the values in `.env.local`. The file stays as-is.
- `DROP` or `DELETE FROM` against any live database, force-push, history rewrite,
  or any commit to `main`. (Nate merges to `main` by hand — GitHub only honours
  `workflow_dispatch` and cron on the default branch.)
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

**Headless-skill CLI contract (shared with `~/os`, lane `headless-skills`).**
Every skill call is `claude -p "<slash command>" --output-format json`, run with
`cwd=$OS_DIR`, with `~/.claude/skills` symlinked to `$OS_DIR/skills` on the
runner. A headless skill never prompts, never opens a browser, never reads the
Master Client List sheet, exits non-zero on failure, and prints one line per
file written as `WROTE: <abs path>`, plus `REPO: <url>` or `DRYRUN: <cmd>`
where relevant. Jobs parse only those lines. Commands:

```
/pitch <slug> --facts <json-file> --page-text <txt-file> --no-browse [--no-demo]
/quote <slug> --notes <md-file> --yes
/new-client-repo <slug> --brief <md-file> --yes [--dry-run]
/intake <slug> --yes
```

All four write only under `$OS_DIR/clients/<slug>/`. `<slug>` is
`businesses.os_slug`. Until `~/os` ships the flags, every job here is tested
against a fake `runSkill` only — that is by design, not a gap.

## Conventions this round establishes

- Jobs live in `jobs/<name>.mjs`, each exporting `run(deps)` and taking every
  external dependency in `deps`. No module reaches for a global client.
- Shared helpers live in `lib/`. `lib/db.mjs` is the only module that builds SQL.
- Every job writes at least one row to `events` — job name, kind, detail JSON.
  A job that did nothing writes a `skipped` event saying why.
- `DRY_RUN` defaults to on everywhere. A job must opt into side effects.
- `~/os` reaches the runner as a git clone, not a vendored copy — decided
  2026-08-31. `clock.yml` checks out `bcn-services/bcns-os` to `$OS_DIR`, gated
  on the `OS_REPO` variable and authenticated by the `OS_TOKEN` secret — a
  fine-grained PAT, because the `bcn-services` org disables deploy keys. Both
  are set. The clone stays optional: every job that wants `~/os` tests for the
  directory and degrades — a missing `~/os` is a `skipped` event, never a
  throw.
- The Claude Code CLI is installed by `clock.yml`. `lib/claude.mjs` shells out
  to a `claude` binary that `ubuntu-latest` does not ship, so items 9, 10 and 12
  all fail on a runner without that step.

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
  status: done

- task: Verify discovered email addresses before any of them are ever mailed — MX
    lookup plus an SMTP `RCPT TO` probe that disconnects without sending, with the
    resolver and the SMTP socket injected.
  guardrails:
    - The probe must never transmit a message body
  done when:
    - A unit test with a fake resolver asserts a domain with no MX record is
      rejected without opening a socket
    - A unit test asserts the probe issues `RCPT TO` and then `QUIT`, never `DATA`
  status: done

- task: Wire sourcing to the real world. Add `lib/places.mjs` — a Places API
    (New) text-search client that takes the Workload Identity access token from
    `GOOGLE_OAUTH_ACCESS_TOKEN` (no API key) and exposes `search(query)` returning
    `{place_id, name, phone, website, address, rating, review_count}` rows — and
    `lib/budget.mjs`, a `readBudget()` that ports `~/os/skills/leads/places.py
    budget` (Cloud Billing / usage read for the month). Inject both from
    `jobs/run.mjs` so the Monday cron actually runs `source`.
  guardrails:
    - No Places API key anywhere; the token comes from the auth step or the job skips
    - The unit tests still never touch the network — the HTTP `fetch` is a parameter
  done when:
    - A unit test with a fake `fetch` asserts `search` builds a Places API (New)
      text-search request carrying the bearer token and the field mask, and maps
      the response to the row shape above
    - A unit test asserts `readBudget` returns `{remaining, month}` from a fake
      billing response and throws (never returns a number) on a malformed one
    - `run.mjs`'s deps object carries `places` and `readBudget` when the token is
      present, asserted by a test that builds deps with a fake env
  status: done

- task: Wire qualification into the clock. Add `qualify` to `SCHEDULES` under the
    Monday cron, run after `source` in the same tick, and inject `fetchPage`
    (a capped `fetch` wrapper) and `claude` (from `lib/claude.mjs`) from
    `jobs/run.mjs`. Then run `verify` (item 7) over each newly qualified row in the
    same job and move a row whose address fails to `call_due`.
  guardrails:
    - `qualify` never runs without both deps present — a missing one is a `skipped`
      event, not a throw
    - `claude` is only ever the Claude Code CLI on the OAuth token; no API key
  done when:
    - A test asserts the Monday cron string maps to `source` then `qualify`, in order
    - A unit test asserts a row whose verify result is `invalid` lands at `call_due`
      with `email` cleared and `phone` intact, and a `unknown` result leaves the row
      `qualified`
    - Existing passing tests remain passing
  status: done

- task: Build personalization — `jobs/personalize.mjs`, one Claude call per
    business that fills the single generated sentence in the template held in
    `~/os/skills/outreach/SKILL.md` (copy the template into `lib/template.mjs`; the
    skill is the authoring source, this repo is the runtime copy). The voice
    reference is `$OS_DIR/knowledge/library/bcns-voice/voice-rules.md`, present
    only when the `~/os` clone step ran — fall back to the fixed blocks alone.
    Never `nate-emails.md`: it is gitignored and reaches no runner, ever. Write
    the result to `research.draft` and stage `drafted`, keeping a buffer of at
    most 25 drafts ahead of the sender. No demo, no link, no attachment.
  guardrails:
    - One Claude call per business, never a generation call plus a humanizer pass
    - Every claim in the generated sentence traces to a field in `research`
    - The fixed blocks of the template are byte-identical in every draft; only the
      generated sentence and the slots vary
    - Never emit a URL, a price, a named competitor, or a demo claim
  done when:
    - A unit test asserts one Claude call per business
    - A unit test asserts a business with fewer than three `research` facts is
      skipped rather than written with thin copy
    - A unit test asserts a draft containing `http`, `$`, or `demo is ready` is
      rejected and an `error` event written
    - A unit test asserts the buffer stops at 25 undelivered drafts
  status: done

- task: Build the sender — `jobs/touch.mjs` on the 14:00 weekday cron. Each run
    picks rows due today: first sends from the `drafted` buffer, and bumps where
    `next_touch_at` has passed. Round-robin across `mailboxes` rows with remaining
    daily capacity, per-mailbox warming ramp from `warmed_at`, jittered send times
    over the hour. A send sets `stage=sent`, `touches+=1`, `next_touch_at=+7d`,
    and records the thread. Bumps reply in the same thread (`In-Reply-To`), under
    40 words, no new argument. After the second bump with no reply the row moves to
    `call_due`. SMTP as `outreach@send.bcn-services.com` via `SMTP_PASS`.
  guardrails:
    - A mailbox at its `daily_cap` is never selected, and the cap is never exceeded
      by a concurrent run
    - The thread row and the counter update commit in the same transaction as the send
    - Never send to a row with `suppressed_at` or a row that has replied
    - The allow-list is a hard gate, independent of `DRY_RUN`. With `DRY_RUN` on
      nothing opens SMTP at all; with it off the only reachable recipients are
      `SEND_ALLOWED_RECIPIENTS` — never the internal
      `NOTIFY_ALLOWED_RECIPIENTS`. An address outside it is refused before the
      connection opens. Nate removes the gate by hand when he is ready to mail
      a stranger — no job, env default, or later item may widen it
    - Exactly two bumps; a third touch is a `call_due` transition, never a send
  done when:
    - A unit test asserts a mailbox at capacity is skipped and the next is chosen
    - A unit test asserts the warming ramp yields the per-mailbox cap for a given
      `warmed_at` age
    - A unit test asserts a row at `touches=3` with no reply lands at `call_due`
      and no SMTP command is issued for it
    - A unit test asserts a bump carries `In-Reply-To` of the first message
    - A unit test with `DRY_RUN` off asserts an address outside
      `SEND_ALLOWED_RECIPIENTS` is refused before any SMTP connection opens,
      and that an allow-listed address is not
    - A unit test asserts the message is `multipart/alternative` carrying
      `lib/signature.html` and `lib/signature.txt` verbatim as its two parts
  status: done

- task: Build the poller and the reply parser — `jobs/poll.mjs` on the 20-minute
    cron, IMAP over the `pipeline` label via `IMAP_PASS`, thread mapping by
    `In-Reply-To` then `References`, routing by `Delivered-To`. Prospect replies
    (to `outreach@send`): suppression checked first, then one Claude call
    classifies; any non-opt-out reply sets `stage=replied` and stops the sequence.
    Teammate replies (to `bot@`, from an address in `NOTIFY_ALLOWED_RECIPIENTS`):
    parse the first line as a command — `yes`, `no`, `no answer`, `stop`,
    `won <amount>`, `notes` — and apply it to the business the thread maps to.
    Strip quoted regions before any keyword match.
  guardrails:
    - Opt-out detection runs and commits before classification, always
    - A command is only honoured from an allow-listed sender; anything else on
      `bot@` is forwarded for a human, never guessed at
    - An unmatched prospect message is forwarded for a human to read, never guessed at
  done when:
    - A unit test asserts a message containing opt-out intent sets `suppressed_at`
      even when classification throws
    - A unit test asserts an out-of-office reply changes no stage
    - A unit test asserts `Reply "stop"` inside a quoted region does not suppress
    - A unit test asserts `won 2400` from an allow-listed sender sets `stage=won`
      and the same line from an unknown sender changes nothing
  caution: true
  status: done

- task: Build the notification emails — `jobs/notify.mjs`, run at the end of each
    `poll` tick, sending as `bot@bcn-services.com` to Nate and Brandon only: batch
    approval (tomorrow's drafts, reply `yes`/`no`), call task (a `call_due` row
    with phone, facts, and the `/pitch` script when `~/os` is available), meeting
    (a `replied` row with the thread), and quote handoff (a `quoting` row with
    Brandon's notes). Each row is notified once per stage; the send is recorded
    in `events`.
  guardrails:
    - Recipients are only ever `NOTIFY_ALLOWED_RECIPIENTS`; a prospect address is
      never a notify recipient
    - Notify never changes a business's stage — it reads what `poll` and `touch`
      wrote
  done when:
    - A unit test asserts a `call_due` row produces exactly one call-task email
      across two consecutive runs
    - A unit test asserts an email addressed to any address outside the allow-list
      is refused before SMTP is opened
    - A unit test asserts the four templates render with the row fields and none
      contains a prospect email address as a recipient
  status: done

- task: Build the end-to-end test — `tests/pipeline.test.mjs`, one test that
    drives `jobs/run.mjs`'s deps object through the whole path in order: `source`
    finds a business, `qualify` gives it an email and facts, `personalize` drafts,
    `touch` sends, `poll` reads the reply, `notify` reports it. Every boundary is
    the same injected fake the unit tests already use — Places, Claude, fetch,
    Postgres, SMTP, IMAP — so the test stays pure. This is the only item that
    proves the jobs agree on the row shapes they hand each other.
  guardrails:
    - No new production code. A failure here is a bug in items 8–13, fixed there
    - The fakes are the existing ones; never add a live service to make it pass
  done when:
    - A test walks one business from `sourced` to `replied` through every job in
      schedule order and asserts the stage after each
    - A test asserts an opt-out reply mid-path sets `suppressed_at` and that no
      later job in the same run selects that row again
    - `pnpm test` runs it and the whole suite exits zero
  status: done

- task: Build the headless-skill runner and the os push helper. `lib/skills.mjs`
    exports `runSkill({ command, cwd, run })` — wraps the existing `run` from
    `lib/claude.mjs` (same `claude -p … --output-format json` invocation), adds a
    `cwd` option so the CLI runs inside `$OS_DIR`, and parses stdout for lines of
    the exact forms `WROTE: <abs path>`, `REPO: <url>`, `DRYRUN: <cmd>`,
    returning `{ wrote: [], repo, dryrun }`. `lib/osrepo.mjs` exports
    `commitAndPush({ exec, dir, paths, message })` — `git add <paths>`,
    `git commit -m`, `git pull --rebase`, `git push`, in that order, via the
    injected `exec`. `clock.yml` gains, after the `~/os` checkout step, a step
    that symlinks `$OS_DIR/skills` to `~/.claude/skills` and sets
    `git config user.name "bcns bot"` / `user.email "bot@bcn-services.com"`
    inside `$OS_DIR`. `buildDeps` in `jobs/run.mjs` injects `runSkill`,
    `commitAndPush` and `osDir` (from `OS_DIR`).
  guardrails:
    - Only the three line prefixes above are parsed; nothing else in Claude's
      output is trusted or acted on
    - `commitAndPush` never runs `push --force`, never touches `main` of this
      repo, and never runs at all when `DRY_RUN` is on (it logs the would-be
      command instead)
    - The Claude CLI is never actually invoked in a test; `run` is a fake
  done when:
    - A unit test asserts `runSkill` returns the parsed `wrote` paths from a fake
      stdout and throws, naming the command, when the fake exits non-zero
    - A unit test asserts `commitAndPush` calls the fake `exec` in the order
      add → commit → pull --rebase → push, and that a throw from push propagates
      with no further calls
    - A unit test asserts `commitAndPush` under `DRY_RUN` makes zero `exec` calls
      and returns the would-be command list
    - `tests/clock.test.mjs` still passes and the new `clock.yml` step is
      present between the os checkout and the job step
  status: done

- task: Remove the approval loop and author migration 0022. `jobs/notify.mjs`
    drops `drafted` from `NOTIFY_STAGES` and deletes the batch approval mail;
    `jobs/poll.mjs` drops the `yes` command (`no`, `no answer`, `stop`, `won`,
    `notes` stay), so `yes` falls through to the unknown-command forward.
    `supabase/migrations/0022_pipeline_v2.sql` adds `businesses.os_slug text
    unique`, `clients.signed_at timestamptz`, `clients.contract_path text`,
    `clients.repo_url text`, and extends the stage CHECK with `quoted` and
    `onboarded`. `touch` keeps sending from `drafted` unchanged.
  guardrails:
    - The migration is a file only — never applied, never edited after this item
    - `approved` stays in the CHECK so existing rows remain valid; nothing writes it
  done when:
    - A unit test asserts a `yes` reply from an allow-listed sender is forwarded
      as an unknown command and changes no stage
    - A unit test asserts `notify` writes no `notified` event and sends no mail
      for a `drafted` row
    - The migration file is listed wherever the existing migration tests
      enumerate files, and the schema test that replays migrations on a temp DB
      (if present) still passes
    - Existing passing tests remain passing
  status: not started

- task: Build the pitch job — `jobs/pitch.mjs`, run on the poll tick. For each
    row from `selectable_businesses` at `call_due` with no `research.pitch_path`:
    set `os_slug` if null (kebab of name + city; on unique-violation append the
    last 6 chars of the place id); write `research.facts` as JSON and the stored
    page text as a `.txt` to a temp dir; call
    `runSkill('/pitch <slug> --facts <json> --page-text <txt> --no-browse')`
    with `cwd: osDir`; `commitAndPush` the returned `wrote` paths with message
    `pitch: <slug>`; store `research.pitch_path = clients/<slug>/pitch/`; write
    event `pitched`. `qualify` must persist the fetched page text on the row
    (`research.page_text`, truncated to 20k chars) if it does not already.
    `SCHEDULES` for the poll cron becomes `['poll','pitch','quote','onboard','notify']`
    (quote/onboard modules may be stubs until their items land). The `call_due`
    template in `notify` carries `Pitch folder: clients/<slug>/pitch/` and the
    `pitchAvailable` homedir check is deleted.
  guardrails:
    - One pitch per business, ever — a row with `pitch_path` set is skipped
    - A failed `runSkill` writes an `error` event with the command and stderr
      and leaves the row's stage and `research` untouched
    - The pitch is the general bcns service pitch built from stored facts and
      page text; the job never fetches a website
  done when:
    - A unit test asserts the exact `/pitch` command string built for a fixture
      row, including the slug and both temp-file paths
    - A unit test asserts a throwing fake `runSkill` yields an `error` event and
      no change to the row
    - A unit test asserts the `call_due` mail body contains `clients/<slug>/pitch/`
    - `tests/clock.test.mjs` asserts the poll cron maps to the five-job list
  caution: true
  status: not started

- task: Build the quote job — `jobs/quote.mjs`, run on the poll tick. For each
    row at `quoting` with `research.notes` and no `research.quote_path`: write
    the notes to a temp `.md`; `runSkill('/quote <slug> --notes <md> --yes')`;
    `commitAndPush` the `wrote` paths with message `quote: <slug>`; insert a
    `clients` row (migration 0020 shape) if none exists for the business; set
    `stage = quoted`, `research.quote_path`; write event `quoted`. `notify` gains
    a `quoted` stage with template "Quote ready for <name>" to
    `NOTIFY_ALLOWED_RECIPIENTS` carrying the quote path(s) and the instruction:
    send it to the client yourself; when they sign, reply to this mail with the
    word `signed` and the signed PDF attached.
  guardrails:
    - Nothing here mails the prospect; the quote reaches them only by Brandon's hand
    - Re-running on a `quoted` row is a no-op with a `skipped` event
  done when:
    - A unit test asserts the exact `/quote` command string for a fixture row
    - A unit test asserts the `clients` insert happens exactly once across two
      runs on the same row
    - A unit test asserts the `quoted` mail names the quote path and contains
      the word `signed`
  caution: true
  status: not started

- task: Handle the signed contract in `poll`. A message from an allow-listed
    sender whose body's first word is `signed`, on a thread whose business is at
    `quoted`, and carrying exactly one `application/pdf` part of at most 10 MB:
    write the part to `$OS_DIR/clients/<slug>/contract/<YYYY-MM-DD>-signed.pdf`,
    `commitAndPush` it with message `contract: <slug>`, set
    `clients.signed_at = now()`, `clients.contract_path`, `stage = won`, write
    event `signed`. `lib/mail.mjs`'s IMAP parse must expose attachment parts
    (content type, size, bytes) to `poll`; today attachments are never read.
  guardrails:
    - Only `application/pdf` is ever written to disk; any other MIME type, a
      second attachment, or a size over 10 MB refuses the whole message with a
      forward to the humans and an `error` event
    - `signed` with no attachment is forwarded, never applied
    - The `won <amount>` command keeps working unchanged
  done when:
    - A unit test asserts the happy path from a fake IMAP message with one PDF
      part: file written under a temp `osDir`, stage `won`, `signed_at` set
    - A unit test asserts `signed` with no attachment applies nothing and forwards
    - A unit test asserts a `text/html` attachment or an 11 MB PDF is refused with
      an `error` event and nothing written
  caution: true
  status: not started

- task: Build the onboard job — `jobs/onboard.mjs`, run on the poll tick. For
    each row at `won` whose `clients.repo_url` is null and `signed_at` is set:
    write a brief `.md` (name, city, site, facts, notes, quote path) to a temp
    dir; `runSkill('/new-client-repo <slug> --brief <md> --yes')` and read
    `repo`; then `runSkill('/intake <slug> --yes')`; rewrite
    `clients/<slug>/README.md` frontmatter `status: lead` → `status: in-progress`;
    `commitAndPush` with message `onboard: <slug>`; set `clients.repo_url`,
    `stage = onboarded`; write event `onboarded`. `notify` gains an `onboarded`
    stage whose mail goes only to the address in the new variable
    `ONBOARD_NOTIFY_TO` (fail closed when unset), subject "Signed: <name> — your
    turn", body carrying the repo URL, the intake checklist path and the
    request-email path.
  guardrails:
    - Tests inject a fake `runSkill`; `gh repo create` is never executed in a test
    - Rows at `won` via the manual `won <amount>` command with no `signed_at` are
      skipped with a `skipped` event, not onboarded
    - The onboarded mail never goes to `NOTIFY_ALLOWED_RECIPIENTS` as a whole
  done when:
    - A unit test asserts the two `runSkill` command strings in order for a
      fixture row and that `repo_url` is stored from the `REPO:` line
    - A unit test asserts a second run on the same row makes zero `runSkill`
      calls
    - A unit test asserts the `onboarded` mail has exactly one recipient equal to
      `ONBOARD_NOTIFY_TO`, and that an unset variable yields an `error` event
      and no mail
  caution: true
  status: not started

> **⚠️ AUTONOMOUS RUN — STOP HERE**


- task: Build alert triage — `alerts@` messages become draft pull requests,
    never merges, capped at three triage runs per day.
  guardrails:
    - Never push to `main` and never merge a pull request
  done when:
    - A unit test asserts a fourth alert in one day writes a `skipped` event and
      opens nothing
    - A unit test asserts the same `fingerprint` twice increments `hits` and opens
      one PR, not two
  status: not started

---

## Found during the 2026-08-31 autonomous run — needs an item
- ~~**`NOTIFY_ALLOWED_RECIPIENTS` does double duty, and going live weaponises it.**~~
  **FIXED 2026-08-31.** `SEND_ALLOWED_RECIPIENTS` now gates `touch`'s prospect
  sends; `NOTIFY_ALLOWED_RECIPIENTS` gates `poll`/`notify` forwarding and
  `isAllowedSender` alone. Both fail closed when unset, and `assertAllowed`
  names whichever list actually refused. Original finding:
  It is both the allow-list of who `touch` may mail AND the list `notify`/`poll`
  forward internal mail to. Today those are the same two people, so nothing is
  wrong. The moment a prospect address is added to go live, every internal call
  task, meeting alert and approval mail is delivered to that prospect — including
  a prospect's own opt-out forwarded back to them — and `poll.isAllowedSender`
  would then honour `won 2400` or `stop` as commands from that prospect. Split it
  into a separate internal-recipient variable BEFORE any live pilot. This is the
  highest-priority item on this list.
- ~~**`personalize` has no cron cell.**~~ **FIXED 2026-08-31.** `SCHEDULES` and
  `clock.yml` both carry `'30 13 * * 1-5'  # personalize`, and a table-driven
  test in `tests/clock.test.mjs` fails if the two ever drift again. Original
  finding: `jobs/run.mjs`'s schedule map is
  `poll`+`notify`, `touch`, and `source`+`qualify`. Nothing runs `personalize`,
  so a `qualified` row never becomes `drafted` and `touch` finds nothing to send.
  The pipeline stalls one step before its first live send. Verified against
  `.github/workflows/clock.yml` and the map in `jobs/run.mjs`.
- ~~**notify's mail has no thread, so `yes`/`no` replies do not land.**~~ **MOOT 2026-09-01** — item 16 removes the approval mail and the `yes` command. Original finding: The batch
  approval mail is one message covering N businesses, while
  `email_threads.message_id` is a primary key carrying a single `business_id`, so
  the batch cannot be recorded at all. A reply matches no thread and `poll`
  forwards it as "command had no thread to apply to". Needs either per-business
  approval mail or a mapping table — not a patch.
- **The notify dedupe key never re-arms on stage re-entry.** `replied → approved
  → replied` reuses key `id:replied` and is never announced a second time. One
  line in `notifyKey`, but it changes item 13's tested contract and trades a
  silent miss for duplicate internal mail — an owner's call.


- **`mailboxes.sent_today` is never reset.** `lib/db.mjs`'s `claimMailboxSlot`
  increments it and gates on `sent_today < cap`, but nothing anywhere sets it
  back to zero and no job does a daily rollover. Today's cap is therefore a
  LIFETIME cap: once a mailbox has claimed `daily_cap` slots in total it is
  never selected again and the pipeline silently stops sending. Item 11's
  guardrail ("the cap is never exceeded") is satisfied, which is why the item
  passed — the missing half is the reset. Decide between a rollover in `touch`
  (`sent_today = 0 where warmed_at::date < current_date`-style, needs a
  `counted_on` date column) and dropping the counter for a computed
  `count(*) from email_threads where direction='out' and sent_at::date = current_date`,
  which cannot drift because there is nothing to reset.
- **A claimed slot is not released when the send throws.** `claimMailboxSlot`
  increments before the transport runs; a throw leaves the increment. Fails
  safe — it under-sends, never over-sends — so it is a lower priority than the
  reset above.

## Not yet specified

- How `search_grid` gets seeded beyond the initial Connecticut and Rhode Island
  towns — revisit once one real sourcing run shows the duplicate rate
- What the fit judgement from qualification is actually used for; it is recorded
  and acted on in no item — revisit after the sender item, when `fit=false` rows
  would otherwise be mailed

## Out of scope

- A demo link or attachment in cold mail, and a `demos.bcn-services.com` host —
  decided against 2026-08-30 in `~/os/skills/outreach`; `/pitch` builds the demo
  after a reply
- The `~/os` side of the headless contract (the four skills' flags and their
  fixture) — built on the `headless-skills` branch of `bcns-os`; this repo only
  calls the contract
- Any approval or draft-review step before a cold send — removed 2026-09-01;
  the warming cap and `SEND_ALLOWED_RECIPIENTS` are the safety rails
- Retiring the Google Sheet funnel and porting `sheets.py stats` onto SQL —
  agreed, but it is `~/os` work, not this repo's
- Google Workspace aliases, DNS records, GitHub secrets, Workload Identity
  Federation, and applying migrations — all require a human at a console
- A second Google seat, or a separate mailbox for `outreach@send` — the schema
  supports more mailboxes with a single seeded row; moving off Google is a later,
  funded decision driven by Postmaster reputation
- Any web interface. This repo has no server in it after item 1
