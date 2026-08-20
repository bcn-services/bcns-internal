-- 0001_core_schema.sql
-- Purpose: Core schema for the bcns internal dashboard — accounts (every
--   business we know of, whether or not they buy), clients (the delivery record
--   for an account that bought), and account_activity (the contact history).
--
-- Modeling decision (settled in planning): a LEAD and a CLIENT are the same
--   business at two stages, so business identity lives in exactly ONE place —
--   accounts. `clients` holds only what is true once they are paying, and points
--   back with a UNIQUE FK. A referral client with no prospecting history still
--   needs an accounts row first; that is intentional, not friction.
--
-- Source of these columns: ~/os/skills/leads/sheets.py COLUMNS (the 22-column
--   Master Client List). Column-by-column mapping is in MIGRATION_NOTES.md.
--   Two deliberate renames and one type change are recorded there.
--
-- Platform rules followed (from bcns-client-coventry):
--   * RLS ENABLED on every table from commit one, default-deny. Policies land
--     in 0002, so until then only the service-role client can read anything.
--   * Money is integer cents (bigint), never float/numeric dollars.
--   * Keyless: this file applies to a vanilla PG14 database with NO Supabase
--     auth schema present. Nothing here references auth.* or auth.users.
--
-- Reversible via the paired 0001_core_schema.down.sql.

-- ---------------------------------------------------------------------------
-- updated_at trigger helper. Same hardened definition the client apps use:
-- pinned empty search_path, schema-qualified now(), created_at held immutable.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  new.created_at = old.created_at;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- accounts: every business we have ever looked at. This IS the old lead sheet.
--
-- place_id is the Google Places id and is the natural dedupe key, but it is
-- NULLABLE and only UNIQUE when present — a referral or walk-in client has no
-- Places record, and forcing a fake one would corrupt the dedupe. A partial
-- unique index gives uniqueness for real ids while permitting many NULLs.
--
-- status walks the same 8 stages the skill already uses, as a CHECK-constrained
-- text column (not a PG enum) so renaming a stage stays a cheap migration.
-- ---------------------------------------------------------------------------
create table accounts (
  id             uuid primary key default gen_random_uuid(),

  -- identity (from Google Places; never edited by hand)
  place_id       text,
  business_name  text not null,
  business_type  text,   -- was `type` in the sheet; `type` is awkward in SQL
  city           text,
  phone          text,
  website        text,
  has_website    boolean,
  rating         numeric(2,1) check (rating is null or (rating >= 0 and rating <= 5)),
  review_count   integer check (review_count is null or review_count >= 0),

  -- judgment (Claude fills these)
  lead_score     integer check (lead_score is null or (lead_score >= 0 and lead_score <= 100)),
  score_reason   text,

  -- funnel (filled as the lead is worked)
  status         text not null default 'new'
    check (status in (
      'new',
      'attempted',
      'reached',
      'consult_scheduled',
      'consult_done',
      'won',
      'lost',
      'dead'
    )),
  call_count     integer not null default 0 check (call_count >= 0),
  last_contact   date,
  contact_name   text,
  last_outcome   text,
  consult_date   date,
  close_date     date,
  -- was `deal_value` (dollars) in the sheet. Integer cents per platform rule.
  deal_value_cents bigint check (deal_value_cents is null or deal_value_cents >= 0),

  -- provenance: what found this lead and when. This is what lets the skill
  -- learn which searches actually produce customers.
  source_query   text,
  date_added     date not null default current_date,
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Uniqueness only for rows that HAVE a place_id; unlimited NULLs allowed.
create unique index accounts_place_id_key on accounts (place_id)
  where place_id is not null;

create index accounts_status_idx        on accounts (status);
create index accounts_city_idx          on accounts (city);
create index accounts_business_type_idx on accounts (business_type);
-- Supports the "who haven't we called" query the skill runs constantly.
create index accounts_last_contact_idx  on accounts (last_contact nulls first);

create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- clients: the delivery record for an account that bought. Holds ONLY facts
-- that exist because they are paying. Business identity is NOT duplicated here
-- — read it through account_id.
--
-- account_id is UNIQUE: one account can become at most one client. If a business
-- ever churns and returns, that is a status change on this row, not a second row.
-- on delete restrict: you cannot delete an account that has a client record.
--
-- slug is the universal join key already used across the whole system — it is
-- the pitch folder name, the client folder name, the repo suffix, the CI
-- CLIENT_SLUG var, and the droplet Unix user. Constrained to the lowercase
-- kebab shape those uses require, because a bad slug breaks deploys silently.
-- ---------------------------------------------------------------------------
create table clients (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null unique references accounts (id) on delete restrict,

  slug                 text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  status               text not null default 'active'
    check (status in ('onboarding', 'active', 'paused', 'churned')),

  monthly_rate_cents   bigint check (monthly_rate_cents is null or monthly_rate_cents >= 0),

  -- where their app actually lives. Populated by onboarding, read by the
  -- future operational-health view.
  domain               text,
  repo                 text,   -- e.g. bcn-services/bcns-client-coventry
  droplet_host         text,
  droplet_port         integer check (droplet_port is null or (droplet_port > 0 and droplet_port < 65536)),
  supabase_project_ref text,

  launch_date          date,
  churn_date           date,
  notes                text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index clients_status_idx on clients (status);

create trigger clients_set_updated_at
  before update on clients
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- account_activity: one row per contact attempt or note.
--
-- The old sheet kept only the LAST outcome, because a spreadsheet row cannot
-- hold a history. Postgres can, and Release 1's whole job is letting someone
-- answer "what is the state of this deal" without asking Nate — which needs
-- the history, not just the last line. The denormalized accounts.call_count /
-- last_contact / last_outcome columns are KEPT so existing skill reads and
-- segment stats keep working unchanged.
--
-- actor_email is plain text, not a FK to auth.users: this migration must stay
-- keyless (appliable to a vanilla PG14 test database with no auth schema).
-- ---------------------------------------------------------------------------
create table account_activity (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  kind        text not null default 'call'
    check (kind in ('call', 'email', 'meeting', 'note', 'status_change')),
  outcome     text,
  note        text,
  actor_email text,
  created_at  timestamptz not null default now()
);

create index account_activity_account_id_idx  on account_activity (account_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- RLS: enabled everywhere, no policies yet. An empty policy set is deny-all for
-- every role except service_role (which bypasses RLS). Policies land in 0002.
-- ---------------------------------------------------------------------------
alter table accounts         enable row level security;
alter table clients          enable row level security;
alter table account_activity enable row level security;
