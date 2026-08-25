-- ---------------------------------------------------------------------------
-- 0012_email_outbox — where an email GOES when there is nowhere to send it.
--
-- Item 7 builds the routing half of notifications and leaves the send half
-- blocked: no mail provider is configured (no Resend, no key, docs/NOTIFICATIONS.md
-- says what a human must do). A rendered email with no provider therefore has
-- to land somewhere durable, or the event is lost — which is the one failure the
-- item forbids outright.
--
-- WHY A TABLE AND NOT job_runs.log. A log line is prose: nothing can query "what
-- is still unsent", nothing can retry it, and nothing can prove a payload was
-- ever rendered. This is a queue with a status, so the later retry item is a
-- `select ... where status = 'pending'` and a human inspecting it is one query.
--
-- WHY ADMIN MAY READ IT, when 0009 deliberately hid `inbox_items` even from an
-- admin. An inbox item is private mail INSIDE the company; an outbox row is mail
-- that leaves the building under the company's own domain, and whoever owns the
-- domain is accountable for it. The private half is unaffected: this table holds
-- only what was also emailed, never the inbox-only notices.
--
-- WRITES ARE service_role's. There is no INSERT path for anyone interactive —
-- the admin policy exists so a stuck row can be cleared or re-queued by hand
-- without dropping to the service key, exactly as job_runs does.
--
-- Purely additive: one new table, two indexes, one policy. Nothing existing is
-- dropped, narrowed, or retyped.
--
-- ONE TRANSACTION, for the reason 0009 gives: psql -f does not wrap a file.
-- ---------------------------------------------------------------------------

begin;

create table email_outbox (
  id            uuid primary key default gen_random_uuid(),

  -- Which routing rule produced it — 'job_run_failed', 'task_assigned',
  -- 'lead_reply_meeting'. Free text for the same reason inbox_items.kind is:
  -- a new job must not need a migration to describe itself.
  kind          text not null,

  -- The rendered payload, exactly as an adapter would be handed it. Stored
  -- rather than re-derived, so a retry months later sends what was decided
  -- then and not what today's template would say.
  to_email      text not null,
  subject       text not null,
  body          text not null,

  -- Who it was for, when that is a person here. set null, not cascade: an
  -- offboarding must not destroy the record that mail was sent to them.
  to_profile_id uuid references profiles (id) on delete set null,

  source_job    text,

  -- pending = rendered, not delivered (no provider, or the recipient is not on
  -- the send allowlist). sent = an adapter accepted it. failed = an adapter
  -- refused it and said why.
  status        text not null default 'pending'
                  check (status in ('pending', 'sent', 'failed')),

  -- Why it is not 'sent'. Null on a clean send.
  error         text,

  -- Bounded retry is the retry item's problem, but the counter has to exist
  -- before it can be honoured, or "retry the pending rows" is an infinite loop.
  attempts      integer not null default 0,

  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

-- The queue read: what is still owed, oldest first. Partial, as in 0009 and
-- 0011 — a delivered row leaves the index and the index stays small forever.
create index email_outbox_pending_idx on email_outbox (created_at) where status = 'pending';

-- `on delete set null` on an unindexed FK makes every profile delete seq-scan
-- and row-lock this whole table. Partial: a row addressed outside the company
-- has no profile.
create index email_outbox_profile_idx on email_outbox (to_profile_id) where to_profile_id is not null;

alter table email_outbox enable row level security;

-- Schema-qualified, per 0009's note: a policy cannot carry `set search_path`,
-- so qualifying every call is the equivalent guarantee.
create policy email_outbox_admin_all on email_outbox
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

commit;
