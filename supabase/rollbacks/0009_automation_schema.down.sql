-- Reverses 0009_automation_schema.
--
-- Destructive, as a down migration on new tables must be: every inbox item,
-- lead target, and job-run record goes. Nothing else depends on them.
--
-- The kind CHECK cannot be narrowed back while rows hold the widened values,
-- so the agent-written activity rows are deleted first. That is the one place
-- this reversal loses history a human might have wanted, and it is why running
-- it is a decision rather than a formality.

-- One transaction, for the same reason the up migration is one: psql -f does
-- not wrap a file, and the narrowing CHECK swap must not be left half-done.
-- The indexes 0009 added live on the three tables dropped here and go with them.

begin;

drop table if exists inbox_items;
drop table if exists lead_targets;
drop table if exists job_runs;

alter table profiles drop column if exists last_briefed_at;
alter table profiles drop column if exists job_function;

delete from account_activity
  where kind in ('ai_email_sent', 'ai_email_reply', 'agent_run');

alter table account_activity
  drop constraint if exists account_activity_kind_check;

alter table account_activity
  add constraint account_activity_kind_check
    check (kind in ('call', 'email', 'meeting', 'note', 'status_change'));

-- Restore 0002's staff insert policy verbatim: with the agent kinds gone from
-- the CHECK there is nothing left for the narrower version to exclude.
drop policy if exists account_activity_staff_insert on account_activity;

create policy account_activity_staff_insert on account_activity
  for insert to authenticated with check (public.is_staff());

alter table accounts drop column if exists outreach_mode;

commit;
