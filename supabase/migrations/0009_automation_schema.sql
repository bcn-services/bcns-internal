-- ---------------------------------------------------------------------------
-- 0009_automation_schema — the tables and columns the automation layer needs.
--
-- Purely additive. Nothing here drops a column, deletes a row, or changes the
-- type of an existing one; the one existing constraint it touches (the
-- account_activity.kind CHECK) is replaced by a strict superset of itself.
--
-- Four ideas land together because they are one feature:
--   * accounts.outreach_mode  — is the agent allowed to talk to this lead.
--   * account_activity kinds  — what the agent did shows up in the SAME
--                               timeline as what a human did, so a rep reads
--                               one history rather than two.
--   * profiles.job_function / last_briefed_at — who gets briefed, and when
--                               they last were.
--   * inbox_items / lead_targets / job_runs — the agent's outbox to people,
--                               its work list, and its run log.
--
-- AUTHORIZATION. Reuses public.role_claim() / is_admin() / is_staff() from
-- 0002 and auth.uid() as 0007 does. No new helper: identity already has one
-- place it is decided, and a second would be a second thing to get wrong.
-- Policies cannot carry `set search_path`, which is a function-level clause;
-- the equivalent guarantee is that every call below is schema-qualified
-- (public.*, auth.*), so an attacker-controlled search_path resolves nothing.
--
-- ONE TRANSACTION. The replay harness (and the Supabase CLI) apply a file with
-- `psql -f` and no --single-transaction, so a failure partway through would
-- otherwise leave the schema half-migrated — notably account_activity with its
-- kind CHECK dropped and not yet re-added.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- accounts.outreach_mode — the kill switch, per lead.
--
-- 'ai' by default because the automation is the product; a lead that needs a
-- human touch gets flipped to 'human', and 'paused' stops all outreach without
-- losing which of the two it was heading back to. NOT NULL with a default, so
-- there is no third "unset" state for the runner to have an opinion about.
-- ---------------------------------------------------------------------------
alter table accounts
  add column outreach_mode text not null default 'ai'
    check (outreach_mode in ('ai', 'human', 'paused'));

-- ---------------------------------------------------------------------------
-- account_activity.kind — three agent kinds join the five human ones.
--
-- The five existing values are preserved exactly; this is a widening. Agent
-- writes land in the same table as human writes on purpose: the value of the
-- timeline is that it is ONE timeline. `ai_email_sent` / `ai_email_reply` are
-- contact events like `call` and `email`; `agent_run` is the bookkeeping row
-- that says the agent looked at this account at all, including when it decided
-- to do nothing.
--
-- Named constraint, replacing the anonymous one Postgres generated in 0001
-- (which it named account_activity_kind_check by the same rule). Naming it
-- explicitly means 0010 does not have to guess.
-- ---------------------------------------------------------------------------
alter table account_activity
  drop constraint if exists account_activity_kind_check;

alter table account_activity
  add constraint account_activity_kind_check check (kind in (
    'call', 'email', 'meeting', 'note', 'status_change',
    'ai_email_sent', 'ai_email_reply', 'agent_run'
  )) not valid;

-- ---------------------------------------------------------------------------
-- account_activity_staff_insert — widening the CHECK also widened what a human
-- may write, so the 0002 policy is narrowed to match.
--
-- 0002 let any staff member INSERT any allowed kind. With the three agent kinds
-- now allowed, that policy would let a member forge `ai_email_sent` rows into
-- the audit trail, or pre-write the `agent_run` marker for an account and so
-- suppress the agent's next run on it. Agent kinds are written by the jobs,
-- which run as service_role and bypass RLS; nobody interactive writes them.
-- ---------------------------------------------------------------------------
drop policy if exists account_activity_staff_insert on account_activity;

create policy account_activity_staff_insert on account_activity
  for insert to authenticated
  with check (
    public.is_staff()
    and kind not in ('ai_email_sent', 'ai_email_reply', 'agent_run')
  );

-- ---------------------------------------------------------------------------
-- profiles: what kind of work someone does, and when they were last briefed.
--
-- Both nullable. job_function is null for anyone the briefing job has no
-- template for (Nate wears all three hats), and a null there must mean "skip",
-- not "guess". last_briefed_at is null until the first brief ships and is the
-- job's own idempotency marker — it is why a re-run on the same morning does
-- not send a second brief.
-- ---------------------------------------------------------------------------
alter table profiles
  add column job_function text
    check (job_function is null or job_function in ('developer', 'sales', 'ops'));

alter table profiles
  add column last_briefed_at timestamptz;

-- ---------------------------------------------------------------------------
-- inbox_items — what the automation has to say to one specific person.
--
-- PRIVATE, INCLUDING FROM ADMIN. The only policies below are owner-scoped, and
-- there is deliberately no admin override. An inbox is where an agent tells
-- someone "this lead went cold on you" or "your token expires Friday"; if the
-- boss can read it, people route around it and the channel dies. Admin power
-- over the automation is over lead_targets and job_runs, not over private mail.
--
-- NO INSERT POLICY. Items are written by the jobs, which run as service_role
-- and bypass RLS. A user-writable inbox would let anyone plant a notification
-- in a colleague's feed. Owners may UPDATE (that is how read_at gets set) but
-- not create or delete.
-- ---------------------------------------------------------------------------
create table inbox_items (
  id          uuid primary key default gen_random_uuid(),

  -- Whose inbox. Cascade: offboarding removes their mail with them.
  profile_id  uuid not null references profiles (id) on delete cascade,

  -- Free text, not a CHECK. The set of things a job might tell someone grows
  -- every time a job is added, and a constraint here would turn "the new job
  -- writes a new kind of notice" into a migration.
  kind        text not null,

  title       text not null,
  body        text,

  -- Which job produced it, for "why am I seeing this" and for retiring a
  -- noisy job's backlog in one delete.
  source_job  text,

  -- Optional context. set null, not cascade: losing the lead must not silently
  -- destroy the notice that mentioned it.
  account_id  uuid references accounts (id) on delete set null,
  client_id   uuid references clients (id) on delete set null,

  -- Null until read. Timestamp rather than a boolean, because "when did they
  -- see it" is the question that matters for a follow-up.
  read_at     timestamptz,

  created_at  timestamptz not null default now()
);

-- The only hot read: one person's unread mail, newest first.
create index inbox_items_profile_idx on inbox_items (profile_id, created_at desc);

-- Both FKs are `on delete set null`, and an unindexed one makes every account
-- or client delete seq-scan and row-lock all of inbox_items. Partial, as in
-- 0005: most notices reference neither.
create index inbox_items_account_idx on inbox_items (account_id) where account_id is not null;
create index inbox_items_client_idx  on inbox_items (client_id)  where client_id  is not null;

alter table inbox_items enable row level security;

create policy inbox_items_own_select on inbox_items
  for select to authenticated
  using (profile_id = auth.uid());

-- Both sides: you may touch your own rows, and they must still be yours after.
-- Without the WITH CHECK an owner could hand an item to someone else's inbox.
create policy inbox_items_own_update on inbox_items
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- lead_targets — the trade/town pairs the prospecting job works through.
--
-- Admin-write, staff-read: pointing the machine at a new market is a business
-- decision, but everyone needs to see where it is pointed. `active` rather
-- than a delete, so a market can be paused and resumed without losing that it
-- was ever tried.
-- ---------------------------------------------------------------------------
create table lead_targets (
  id         uuid primary key default gen_random_uuid(),
  trade      text not null,
  town       text not null,
  active     boolean not null default true,

  -- set null: the target outlives whoever added it.
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Same `on delete set null` scan, on profile offboarding.
create index lead_targets_created_by_idx on lead_targets (created_by) where created_by is not null;

alter table lead_targets enable row level security;

create policy lead_targets_admin_all on lead_targets
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy lead_targets_staff_select on lead_targets
  for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------------
-- job_runs — one row per automation run, whatever the outcome.
--
-- Admin-write, staff-read for the same reason: this is the audit trail that
-- answers "did the 6am job actually run", so staff must be able to read it,
-- and nobody interactive should be able to forge an entry. In practice the
-- writer is service_role; the admin policy exists so a run can be annotated or
-- cleared by hand without dropping to the service key.
--
-- finished_at null means still running (or died without writing back), which
-- is what makes a stuck job visible instead of invisible.
-- ---------------------------------------------------------------------------
create table job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',

  -- Who or what triggered it: a cron name, or an employee's email. Plain text,
  -- because a scheduled run has no profile to point at.
  actor       text,

  -- Whatever the run wants to leave behind. Unbounded on purpose and trimmed
  -- by retention, not by the schema.
  log         text
);

-- The dashboard read: latest runs of one job.
create index job_runs_job_idx on job_runs (job, started_at desc);

-- The "is anything stuck" read, across all jobs. job_runs_job_idx leads with
-- `job` and cannot serve it. Partial, so it holds only live runs.
create index job_runs_unfinished_idx on job_runs (started_at desc) where finished_at is null;

alter table job_runs enable row level security;

create policy job_runs_admin_all on job_runs
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy job_runs_staff_select on job_runs
  for select to authenticated using (public.is_staff());

commit;
