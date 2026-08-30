-- ---------------------------------------------------------------------------
-- 0018_pipeline — the outreach pipeline schema.
--
-- Six tables and one view. Every job connects as the service role, so RLS is
-- enabled with no policies at all: anon and authenticated get nothing, the
-- service role bypasses RLS entirely. Deny-all is the absence of a policy, not
-- a policy that returns false.
--
-- `suppressed_at` is a TIMESTAMP, never a stage. Someone asking to be left
-- alone is orthogonal to where they sat in the funnel, and nothing in this
-- schema can clear it — there is no update path and no default that resets it.
-- Reads go through `selectable_businesses`, which filters it out; jobs never
-- select from `businesses` directly.
-- ---------------------------------------------------------------------------

begin;

create table businesses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  domain        text,
  email         text,
  phone         text,
  address       text,
  town          text,
  state         text,
  trade         text,
  place_id      text,
  source_query  text,
  stage         text not null default 'sourced',
  next_touch_at timestamptz,
  touches       integer not null default 0,
  suppressed_at timestamptz,
  research      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint businesses_stage_check check (stage in (
    'sourced',
    'qualified',
    'call_due',
    'drafted',
    'approved',
    'sent',
    'replied',
    'meeting',
    'quoted',
    'won',
    'lost'
  ))
);

-- One row per real address. Partial, because most sourced rows have no email
-- yet and NULLs must not collide.
create unique index businesses_email_key
  on businesses (lower(email))
  where email is not null;

-- Places returns the same business for overlapping grid cells; this is what
-- makes a re-run of a cell idempotent.
create unique index businesses_place_id_key
  on businesses (place_id)
  where place_id is not null;

-- The sender's work queue. Suppressed rows are never due for anything.
create index businesses_next_touch_at_idx
  on businesses (next_touch_at)
  where suppressed_at is null and next_touch_at is not null;

create index businesses_stage_idx on businesses (stage);

-- The ONLY table jobs read businesses from.
create view selectable_businesses as
  select * from businesses where suppressed_at is null;

create table mailboxes (
  id         uuid primary key default gen_random_uuid(),
  address    text not null unique,
  domain     text not null,
  daily_cap  integer not null default 20,
  sent_today integer not null default 0,
  warmed_at  timestamptz,
  status     text not null default 'active',
  created_at timestamptz not null default now(),
  constraint mailboxes_status_check check (status in ('active', 'paused', 'burned'))
);

insert into mailboxes (address, domain, warmed_at)
values ('outreach@send.bcn-services.com', 'send.bcn-services.com', now());

create table search_grid (
  id               uuid primary key default gen_random_uuid(),
  trade            text not null,
  town             text not null,
  state            text not null,
  exhausted_at     timestamptz,
  last_run_at      timestamptz,
  new_rows_last_run integer,
  created_at       timestamptz not null default now(),
  unique (trade, town, state)
);

create table email_threads (
  message_id  text primary key,
  business_id uuid references businesses (id) on delete cascade,
  direction   text not null,
  mailbox     text not null,
  subject     text,
  created_at  timestamptz not null default now(),
  constraint email_threads_direction_check check (direction in ('outbound', 'inbound'))
);

create index email_threads_business_id_idx on email_threads (business_id);

create table events (
  id         bigserial primary key,
  job        text not null,
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index events_job_created_at_idx on events (job, created_at desc);

create table alerts (
  fingerprint text primary key,
  repo        text,
  source      text,
  status      text not null default 'open',
  pr_url      text,
  hits        integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table businesses     enable row level security;
alter table mailboxes      enable row level security;
alter table search_grid    enable row level security;
alter table email_threads  enable row level security;
alter table events         enable row level security;
alter table alerts         enable row level security;

commit;
