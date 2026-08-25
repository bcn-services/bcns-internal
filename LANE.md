# bcns Command Center — Automation Layer

First draft, built in one unattended run. Goal is a working first look, not a
finished product. Plan of record: `~/.claude/plans/command-center-automation.md`
(schema, verbs, jobs, and the reasoning behind every decision). Design decisions
were settled across nine rounds of interview — treat them as fixed, not as
suggestions to re-derive.

Branch: `command-center`. Repo context: `CLAUDE.md` at root.

## Global rules — apply to every item

**Allowed without asking. Permission prompts are pre-approved.**
- All code in `~/bcns-internal`
- Authoring migrations and replaying them against a **local Postgres scratch DB**
- Applying **additive** migrations to production Supabase after they pass locally
- `git commit` on the lane branch
- Running the `leads` skill (it has its own budget cap)
- Sending a test email to `nseluga@g.hmc.edu` *if* a provider is configured

**Forbidden. Mark the item `blocked`, write why, move on — never work around.**
- Any irreversible action: `DROP`, `DELETE FROM` on a populated table, destructive
  migration, force-push, history rewrite, touching `main`
- Sending any message to a real lead or customer. Outreach is
  draft-to-database only.
- Any interactive login (Google, GCP, Gmail, `claude setup-token`, Resend signup)
- Rotating, printing, or committing a credential. Never stage `.env`, `*.pem`,
  `*.key`, `credentials*`, `secrets*`.
- Vercel, DNS, registrar, or any droplet
- Guessing a value recorded as unknown: client monthly rates, client `domain`,
  `droplet_host`
- Writing outside `~/bcns-internal`

**Baseline — pre-existing, not regressions. Do not "fix" these by editing assertions.**
- 537 tests passing, 77 suites (was 217 at the start of the run)
- Exactly 5 pre-existing lint errors: `lib/accounts.ts:141`, `lib/os/osFiles.ts:514`,
  `tests/accounts-data-layer.test.mjs:13`, `tests/rls-policies.test.mjs:66` and `:100`.
  (`pnpm lint` reports 5 problems. Do not "fix" them.)
- Test count is a **floor**. It must go up. Never delete a passing test to hold a number.

**Every item additionally:** `tsc --noEmit` clean · existing passing tests remain
passing · no sixth lint error · `git diff --stat` confined to this repo.

**Testing constraint:** a headless subagent cannot run `next dev`. Every `done when:`
criterion must be checkable by a unit test, a direct DB query, or a `next build`.
Never write a criterion that needs a live server.

**Design, for every UI item:** dark token system, hand-rolled CSS only. No Tailwind.
Do not import `@nseluga/ui` — it is an unused dependency and stays unused. Preserve
the existing `--fs-*`, `--s1`–`--s7`, `--radius`, `--sidebar-w`, `--measure` scales
and the `--good` / `--warn` / `--danger` slots in `app/globals.css`. Admin-only
figures must read visually distinct from member-visible ones.

## Not yet specified

- Exact briefing copy, item ordering, and length — taste, settled after Nate reads one
- Whether `log_activity` parse confidence needs a threshold before auto-commit —
  revisit after item 4
- Assignment-proposal heuristics — dormant until there is more than one employee

## Out of scope

- Droplet provisioning and real cron — deferred until there are employees to use it
- Voice and chat surfaces (original plan Phase 7) — independent, not part of this draft
- Proactive bug fixing — it is a periodic cloud subagent reading email, downstream of
  Gmail access, not triggered from this app
- os documentation page (original plan Phase 12) — independent
- Gmail API impersonation — blocked on a GCP org policy, interactive
- Any real outbound send

---

- task: Build a local Postgres migration harness and backfill the production
    migration ledger. The Supabase project has NO `supabase_migrations.schema_migrations`
    table — migrations 0001–0008 in `supabase/migrations/` were applied by hand, so
    `supabase db push` would try to replay from 0001 and fail. Docker is unavailable
    and there is no `supabase/config.toml`, so `supabase start` is not an option;
    use the homebrew `psql`/`pg_ctl` already installed. Write a script that creates a
    throwaway database, replays every file in `supabase/migrations/` in order, and
    reports the first failure with its filename. Then generate the ledger backfill SQL
    for production. Connection details for production live in the repo's env files —
    read them, never print or commit them.
  guardrails:
    - The scratch database is created and dropped by the script; never point it at production
    - The ledger backfill INSERTs rows only. It must not alter, reorder, or re-run any migration.
    - Never edit an already-applied migration file in place
  done when:
    - The harness script replays 0001–0008 against a fresh scratch database and exits 0
    - Introducing a deliberate syntax error into a migration makes the harness exit non-zero and name that file
    - `supabase_migrations.schema_migrations` exists in production and lists all 8 applied versions
    - Existing passing tests remain passing
  status: done
  caution: true

- task: Migration 0009 — the automation schema. Add `accounts.outreach_mode` as a
    text column constrained to `ai` / `human` / `paused`, default `ai`. Extend the
    `account_activity.kind` CHECK constraint, which today allows only
    `call | email | meeting | note | status_change`, to also allow `ai_email_sent`,
    `ai_email_reply`, and `agent_run`. Add `profiles.job_function` constrained to
    `developer` / `sales` / `ops`, nullable. Add `profiles.last_briefed_at` timestamptz,
    nullable. Create `inbox_items` (id, profile_id FK profiles, kind, title, body,
    source_job, account_id nullable FK, client_id nullable FK, read_at nullable,
    created_at). Create `lead_targets` (id, trade, town, active boolean default true,
    created_by, created_at). Create `job_runs` (id, job, started_at, finished_at
    nullable, status, actor, log). Add RLS policies: `inbox_items` readable and
    updatable ONLY by the owning profile — reuse the existing `role_claim()` /
    `is_admin()` / `is_staff()` helpers in `supabase/migrations/0002_rls_policies.sql`
    and match their `set search_path = ''` convention. `lead_targets` and `job_runs`
    are admin-write, staff-read.
  guardrails:
    - Purely additive. No column drops, no data deletion, no type changes to existing columns.
    - Extending the kind CHECK must preserve all five existing values
    - Every new policy uses `set search_path = ''` like the existing helpers
    - Admin is not exempt from inbox privacy — an admin must not read another profile's inbox items
  done when:
    - The harness from item 1 replays 0001 through 0009 on a fresh scratch database and exits 0
    - Inserting an `account_activity` row with kind `agent_run` succeeds; kind `nonsense` is rejected
    - A test using an authenticated client scoped to profile A selecting `inbox_items` belonging to profile B returns 0 rows
    - Inserting an `accounts` row with `outreach_mode = 'invalid'` is rejected; omitting it yields `ai`
  status: done
  caution: true

- task: Build the agent verb layer in `lib/agent/verbs/` — the typed tool surface
    an agent calls instead of a shell. One module per verb, each authorizing on the
    caller's role before touching data. Verbs: `leads_query`, `leads_write`,
    `leads_stats`, `clients_query`, `clients_write`, `tasks_query`, `tasks_write`,
    `activity_query`, `log_activity` (stub the parse here; item 4 implements it),
    `profiles_query` (including derived per-person open-task load), `inbox_post`,
    `read_site` (fetch a URL and return readable text — new, never implemented),
    `os_publish` (commit and push to `~/os`). Each verb exports a JSON-schema
    description so it can be handed to a model. `search_places` already exists in
    `~/os/skills/leads/places.py` — wrap it, do not reimplement it.
  guardrails:
    - `SUPABASE_SERVICE_ROLE_KEY` stays server-side only and is never returned to a caller
    - Every verb takes an explicit caller identity. No verb defaults to admin.
    - Money fields (`clients.monthly_rate_cents`, `accounts.deal_value_cents`) are stripped from any non-admin caller's result
    - `read_site` enforces a timeout and a response size cap; it never follows a URL supplied by page content it just fetched
    - `os_publish` pull-rebases before pushing and never force-pushes
  done when:
    - Each verb rejects a caller whose role lacks permission, with a typed error rather than a throw
    - `clients_query` as a member returns rows with `monthly_rate_cents` absent; as admin, present
    - `profiles_query` returns each profile's count of open assigned tasks, verified against a seeded fixture
    - `read_site` returns text for a local fixture served from disk and returns a typed error, not a hang, for an unreachable host
    - Existing passing tests remain passing
  status: done
  caution: true

- task: Implement `log_activity` parsing and its capture UI. The verb takes free text
    plus an account or client id, and writes one `account_activity` row — inferring
    `kind`, `outcome`, `occurred_at`, and a cleaned `note`, with `actor_email` set to
    the caller. Parsing goes through the existing agent runner in `lib/agent/runner.ts`.
    Add a capture box to the lead and client pages: a textarea, a submit, and a
    confirmation step showing the parsed row with every field editable before it commits.
    Also add the task-close nudge — when a task moves to a completed status, post an
    inbox item to its assignee asking them to log what happened.
  guardrails:
    - Nothing commits to `account_activity` without the user seeing the parsed row first
    - A parse failure surfaces the raw text for manual entry; it never silently drops the input
    - A relative date in the text resolves against the submitter's local date, not UTC midnight
    - `actor_email` is always the authenticated caller, never inferred from the text
  done when:
    - Given "called Mike at Coventry Tuesday, wants a quote by Friday", the parse yields kind `call`, `occurred_at` on that Tuesday, and a note retaining "quote"
    - Given text with no recognisable event, the verb returns a typed parse-failure and writes no row
    - Moving a task to completed creates exactly one `inbox_items` row addressed to its `assigned_to` profile
    - Submitting the confirmation step writes exactly one `account_activity` row with the edited values, not the parsed ones
  status: done
  caution: true

- task: Skill buttons and job-function gating. Add a run-skill control to the pages
    where each skill's work happens: `pitch` and `quote` on lead and client pages,
    `intake` on a client page, `improve-system` on admin, `leads` on the leads page.
    Each button calls `runAsEmployee` in `lib/agent/tokens.ts` — which is defined and
    currently has ZERO callers; this item is its first. Visibility is gated by
    `profiles.job_function`: sales and admin see pitch/quote/intake, admin alone sees
    leads and improve-system, developers see no skill buttons at all (every developer
    skill needs a cloned repo and a worktree, so none belong in this app). Gating is
    UI convenience only — the API route still authorizes on admin/member as it does today.
  guardrails:
    - Do not add job_function to RLS or to the JWT. Button visibility is not a security boundary.
    - The API route must still reject an unauthorized skill run even when the button was hidden
    - A run in flight must be cancellable and must not block the page
    - No developer skill (`dev-team`, `dt-*`, `lane`, `map`, `ship`, `branch`, `merge-lane`, `foundation`, `new-client-repo`) gets a button
  done when:
    - A member with job_function `developer` receives zero skill buttons in the rendered output
    - A POST to the skill-run route for `leads` as a non-admin returns 403 regardless of UI state
    - A successful run writes a `job_runs` row naming the skill and the invoking actor
    - `next build` succeeds
  status: done

- task: Build the inbox. Add an `/inbox` route listing the signed-in person's
    `inbox_items` newest first, with read/unread state and a count badge in the nav.
    Each item links to whatever it references — an account, a client, or a job run.
    Replying to an item routes its text through `log_activity` (the same verb as item 4,
    second surface). Add `inbox_post` calls wherever the system already knows something
    happened.
  guardrails:
    - Privacy is enforced by RLS, not by the query. An admin must not see another person's items.
    - Marking read must not be inferable as a write path into another profile's rows
    - The nav badge must not issue a query on every render of every page
  done when:
    - An authenticated client for profile A cannot read or update profile B's `inbox_items`, proven by direct query against RLS rather than through the UI
    - Replying to an item creates exactly one `account_activity` row linked to that item's account
    - The unread count matches a seeded fixture of read and unread rows
    - `next build` succeeds
  status: not started
  caution: true

- task: Notification routing. Build the decision layer that turns an event into an
    inbox item, an email, or both. Rules, settled and not to be re-derived: email to
    Nate for a scheduled run that FAILED, for a task assigned (all employees get this
    one), and for a lead replying wanting a meeting. No email for a daily briefing, a
    successful run, or an agent proposal. Everything goes to the inbox regardless.
    NOTE: no mail provider is configured — no Resend, no nodemailer, no key in any env
    file. Build the routing and the rendered payload; make sending a single adapter
    behind an interface, and mark the item's send half blocked with instructions for
    configuring Resend.
  guardrails:
    - Never send to any address other than a configured test address in this run
    - A missing provider must degrade to inbox-only and log, never throw or lose the event
    - Email templates carry no money figures unless the recipient is admin
  done when:
    - A failed `job_runs` row produces exactly one email payload addressed to Nate and one inbox item
    - A successful `job_runs` row produces an inbox item and zero email payloads
    - A task assigned to any profile produces an email payload for that assignee
    - With no provider configured, every one of the above still writes its inbox item and records the undelivered email
  status: not started

- task: Build the daily briefing skill and its delivery. Write a new
    `~/os/skills/briefing/SKILL.md` — it does not exist yet — that reads a person's
    tasks, assigned leads, and clients through the verb layer and composes a scoped
    briefing. Delivery is async on login: the page renders immediately, the briefing
    card shows a building state, and it fills in when the run finishes. Throttle to one
    run per profile per 20 hours. The window is everything since `profiles.last_briefed_at`,
    never "since yesterday" — an absence of a week yields one briefing covering the week,
    not seven stale ones. Add a manual refresh control.
  guardrails:
    - The briefing must never block a page render. An agent run takes 10-60s.
    - `last_briefed_at` advances only on a successful run, so a failure does not swallow a window
    - The briefing is scoped to the requesting person and must not include another employee's tasks or leads
    - Writing the skill file follows `~/os/skills/INDEX.md` conventions and updates the index in the same change
  done when:
    - With `last_briefed_at` set 7 days back and 3 tasks created inside that window, the briefing includes exactly those 3 and nothing created before it
    - Two login triggers inside 20 hours produce exactly one `job_runs` row
    - A briefing run that throws leaves `last_briefed_at` unchanged
    - The route returns in under 200ms with a briefing still building, proven by measurement not inspection
  status: not started

- task: Build the job runner framework and the three jobs that need no new data.
    A job is a script invoked by an external scheduler — never an inline timer — that
    opens a `job_runs` row, executes, closes the row with a status, and routes
    notifications through item 7. Then implement: site health sweep (HTTP check every
    client with a `domain` or `droplet_host`, daily); credential expiry (weekly, watches
    `agent_tokens.expires_at` and the GitHub PAT expiring 2026-10-31, warns 30 days out);
    quiet-client detector (daily, `onboarding` clients only, 7-day threshold, Tier 1
    signals = repo commits via `clients.repo` and site health, Tier 2 = logged contact
    and open tasks). Four of five clients have no `domain` and no `droplet_host` — the
    health sweep must report those as unmonitorable, not as healthy.
  guardrails:
    - Every job is idempotent. Running it twice in one window produces one notification, not two.
    - A job that throws still closes its `job_runs` row with a failed status
    - A client with no domain and no droplet_host is reported unmonitorable, never healthy
    - No job schedules itself. Scheduling is the caller's job.
  done when:
    - A job that throws mid-run leaves a `job_runs` row with status failed and a non-null `finished_at`
    - The health sweep on a seeded fixture of one reachable domain, one unreachable, and three with no domain yields exactly one healthy, one down, three unmonitorable
    - The credential job warns for an `agent_tokens` row expiring in 29 days and stays silent for one expiring in 31
    - The quiet detector flags an `onboarding` client with no activity for 8 days and not one at 6 days, and ignores `active` and `churned` clients entirely
  status: not started

- task: Lead outreach lanes and the sweep. Implement lane state: every lead starts
    `outreach_mode = 'ai'`; any `account_activity` row written by a human on that lead
    flips it to `paused`; three bot touches with no reply parks it as `no_response`
    with no fourth touch. Add a manual lane override control on the leads page. Build
    the outreach job to compose personalised drafts using `read_site` from item 3 —
    per the settled decision, it evaluates each lead's website and writes useful notes
    and an accurate business description, not just a deterministic pull. Drafts are
    written to the database only; nothing sends. Build the lead sweep job reading
    targets from `lead_targets`, and switching to evidence-driven selection when a
    segment reaches `enough_data: true` per `~/os/skills/leads/SKILL.md`. Running the
    real `leads` skill once is permitted; it has its own budget cap.
  guardrails:
    - Nothing sends to a real lead. Drafts are rows, never messages.
    - Never invent a territory. Targets come from `lead_targets` or from stats evidence, per the skill.
    - The 5 `won` accounts and any `human` or `paused` lead are never touched by the bot
    - Respect the leads skill's existing budget cap. Do not raise it.
  done when:
    - Writing a human `account_activity` row on an `ai` lead sets `outreach_mode` to `paused`, and the outreach job then selects 0 rows for it
    - A lead with 3 bot activity rows and no reply is set to `no_response` and receives no 4th draft
    - An outreach draft for a lead with a reachable website contains a business description derived from that site's content, not from its `source_query`
    - The sweep with zero `enough_data: true` segments draws every target from `lead_targets` and invents none
  status: not started
  caution: true

- task: README export generator. Reads Supabase and writes client frontmatter into
    delimited markers in `~/os/clients/<slug>/README.md`. Strictly one-way — the
    generator never reads the file as input and never touches the hand-written prose
    body. Read `~/os/clients/_TEMPLATE.md` first and match its frontmatter shape
    exactly; new detail belongs in `next_step`, never in an appended body section.
    Commits nightly via `os_publish` as `bcns-os-bot`, with the real actor named in
    the commit body when a change traces to a person.
  guardrails:
    - One-way only. Supabase is authoritative; the file is a read-only export.
    - Never write outside the generated markers. A hand-edited prose body survives every run.
    - Never write a client's `monthly_rate_cents` into a tracked file
    - Do not touch personal-overlay paths in `~/os` — they are gitignored and absent on other clones
  done when:
    - Running the generator twice with no data change produces no diff on the second run
    - Hand-editing the prose body and re-running leaves that edit byte-identical
    - A client with a NULL monthly rate exports without a rate field rather than a zero or a guess
    - The generated frontmatter validates against every key in `~/os/clients/_TEMPLATE.md`
  status: not started

- task: Admin configuration surface. Extend `/admin` with: a `lead_targets` editor
    (add a trade and town, deactivate one), a `profiles.job_function` editor, job
    history from `job_runs` with each run's log, and per-employee token status from
    `agent_tokens.expires_at` with a re-enroll prompt. Token expiry fails loudly with
    no fallback to an admin token — a person's jobs stop until they re-enroll, by design.
  guardrails:
    - Admin-only, enforced by RLS and by the route, not by hiding a nav link
    - Never render a token value, sealed or otherwise. Status and expiry date only.
    - The re-enroll control gives instructions; it cannot itself perform an interactive login
    - Deactivating a lead target must not delete historical leads sourced from it
  done when:
    - A member requesting `/admin` receives a 403, not a redirect
    - Deactivating a `lead_targets` row makes the sweep skip it while leaving prior accounts intact
    - The token panel shows expiry status for a seeded row expiring in 10 days and never renders the sealed value
    - `next build` succeeds
  status: not started

- task: Final integration pass and the review handoff. Run the full suite, `tsc --noEmit`,
    lint, and `next build`. Seed the database with realistic fixture data so every surface
    renders with content rather than empty states. Write `REVIEW.md` at the repo root:
    what was built, every item that ended blocked and why, every deliberate omission,
    the exact commands to start the app and reach each new surface, and a numbered list
    of what to click to see each feature working. Note the two data gaps that block jobs
    rather than builds — four clients missing `domain` and `droplet_host`, and
    `assigned_to` / `consult_date` empty across all 50 accounts.
  guardrails:
    - Fixture data is clearly synthetic. Never seed a real person's contact details.
    - REVIEW.md states what is actually verified and what is merely built, and does not blur the two
    - A blocked item is reported as blocked, never softened into done
  done when:
    - `pnpm test` passes with a count above 217, `tsc --noEmit` is clean, lint shows exactly the 2 known errors, and `next build` succeeds
    - REVIEW.md lists every item with its final status and a reason for each non-done one
    - Every new route renders with seeded content, verified by build output rather than a live server
  status: not started
