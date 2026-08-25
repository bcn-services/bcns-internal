-- ---------------------------------------------------------------------------
-- 0015_outreach_lanes — the lane a lead is in, and the drafts the bot writes.
--
-- Three things, and each one moves a rule OUT of application code and into the
-- database, because every one of them has more than one writer.
--
--   1. `no_response` joins the outreach_mode CHECK.
--   2. A HUMAN activity row pauses the lane, in a trigger — not in the one
--      server action that happens to be in front of it today.
--   3. `outreach_drafts` — a table that cannot represent a sent message.
--
-- Purely additive: no column is dropped, no row is deleted, and the one CHECK
-- it replaces is replaced by a strict superset of itself.
--
-- ONE TRANSACTION, for the same reason 0009 is: the replay harness and the
-- Supabase CLI apply a file with `psql -f` and no --single-transaction, so a
-- failure partway would otherwise leave `accounts` with its outreach_mode
-- CHECK dropped and not yet re-added.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. accounts.outreach_mode gains a fourth value: 'no_response'.
--
-- WHY A STORED STATE AND NOT A DERIVED ONE. "Three bot touches and no reply"
-- is derivable — count the `ai_email_sent` rows, look for an `ai_email_reply`.
-- It is stored anyway because it is a DECISION the bot made and a human has to
-- be able to see and reverse: the leads page renders the lane, and a lead that
-- the bot has given up on must not read as 'ai' there. Deriving it would also
-- mean every future reader of `outreach_mode` re-implements the count, which
-- is the way two readers end up disagreeing about whether a lead is live.
--
-- It is a widening, so no existing reader breaks: everything in the app tests
-- `outreach_mode` for EQUALITY with a value it names ('ai' to select, 'paused'
-- to stop), never exhaustively. A lead in 'no_response' is simply not 'ai',
-- which is exactly what the bot's selection query already asks.
--
-- The constraint name is the one Postgres generated for 0009's inline CHECK.
-- ---------------------------------------------------------------------------
alter table accounts
  drop constraint if exists accounts_outreach_mode_check;

alter table accounts
  add constraint accounts_outreach_mode_check
    check (outreach_mode in ('ai', 'human', 'paused', 'no_response'));

-- ---------------------------------------------------------------------------
-- 2. A human touch pauses the lane. In the database, once.
--
-- "WRITTEN BY A HUMAN" IS DECIDED FROM THE ROW, NOT FROM THE CALLER. The kind
-- IS the provenance and the database already guarantees it: 0009's staff
-- INSERT policy and 0010's before-insert trigger both refuse
-- ai_email_sent / ai_email_reply / agent_run from any authenticated session,
-- and those three are the only kinds service_role writes on the bot's behalf.
-- So `kind not in (the three agent kinds)` is not a heuristic about who called
-- — it is the same boundary RLS draws, read off the row.
--
-- This is a TRIGGER and not a line in app/leads/actions.ts because there are
-- five writers of account_activity today (the note form, the stage move, the
-- assignment trace, the free-text capture box, the log_activity verb) and the
-- guarantee has to hold for all of them and for the sixth nobody has written
-- yet. One guard where every caller routes through.
--
-- ONLY FROM 'ai'. A lead already 'human' stays 'human' — a rep who has taken a
-- lead over must not have that downgraded to 'paused' by their own call log —
-- and one already parked as 'no_response' stays parked. Neither is selectable
-- by the bot, so nothing is loosened by leaving them alone.
--
-- AND THE BOT NEVER PAUSES ITSELF: the WHEN clause excludes the three agent
-- kinds, so the `agent_run` row the outreach job writes when it parks a lead
-- cannot flip the lane it just set.
--
-- security definer, because the writer's own RLS must not decide whether the
-- pause lands: a member with a narrow UPDATE policy on `accounts` would
-- otherwise log a call and silently leave the bot running on that lead.
-- search_path is pinned empty, as in 0002 and 0010, so every reference is
-- schema-qualified and an attacker-controlled search_path resolves nothing.
-- ---------------------------------------------------------------------------
create or replace function public.pause_outreach_on_human_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.accounts
     set outreach_mode = 'paused'
   where id = new.account_id
     and outreach_mode = 'ai';
  return null;  -- after-insert: the return value is ignored.
end;
$$;

create trigger account_activity_pause_outreach
  after insert on account_activity
  for each row
  when (new.kind not in ('ai_email_sent', 'ai_email_reply', 'agent_run'))
  execute function public.pause_outreach_on_human_activity();

-- ---------------------------------------------------------------------------
-- 3. outreach_drafts — what the bot wrote, which is all it ever does.
--
-- THIS TABLE CANNOT REPRESENT A SENT MESSAGE, and that is the design. There is
-- no `to_email`, no `sent_at`, no `status`, no provider id and no outbox
-- foreign key. A draft names an ACCOUNT; whoever eventually sends one has to
-- open the lead to find out where it would go. A send path is not deferred
-- here, it is absent — which is a guarantee a column named `sent_at default
-- null` would quietly stop making the day somebody set it.
--
-- `touch_number` is 1..3 by CHECK and unique per account. That makes "no
-- fourth touch" a CONSTRAINT rather than a branch in the job: even a job with
-- the counting logic wrong cannot write a fourth draft, and a re-run inside a
-- window that already drafted collides on the same index the scheduled jobs
-- already treat as "somebody else got there first".
--
-- Staff-read, admin-write, service_role writes in practice — the same shape as
-- lead_targets and job_runs in 0009, for the same reason: everyone needs to
-- see what the machine said in their name, and nobody interactive should be
-- able to forge it.
-- ---------------------------------------------------------------------------
create table outreach_drafts (
  id           uuid primary key default gen_random_uuid(),

  -- Cascade: a deleted lead's drafts are meaningless and reference nothing.
  account_id   uuid not null references accounts (id) on delete cascade,

  -- Which of the three permitted touches this is. See the note above.
  touch_number integer not null check (touch_number between 1 and 3),

  subject      text not null,
  body         text not null,

  -- What the bot understood the business to BE, from reading its website.
  -- Null when the site could not be read or no evaluator was available —
  -- never a guess reconstructed from `source_query`.
  business_description text,

  -- Free observations, the `notes` half of the leads skill's rule: facts are
  -- always safe to collect, judgments are not.
  notes        text,

  -- The page the description came from, so a human can check it. Null when
  -- nothing was read.
  site_url     text,

  -- Which job produced it, matching inbox_items.source_job in 0009.
  source_job   text,

  created_at   timestamptz not null default now()
);

-- The read: one lead's drafts, newest first.
create index outreach_drafts_account_idx on outreach_drafts (account_id, created_at desc);

-- THE FOURTH-TOUCH GUARANTEE, and the re-run guard. Unique, not just indexed.
create unique index outreach_drafts_touch_idx on outreach_drafts (account_id, touch_number);

alter table outreach_drafts enable row level security;

create policy outreach_drafts_admin_all on outreach_drafts
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy outreach_drafts_staff_select on outreach_drafts
  for select to authenticated using (public.is_staff());

commit;
