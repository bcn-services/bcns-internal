-- ---------------------------------------------------------------------------
-- 0010_activity_audit_trail.sql — make account_activity an APPEND-ONLY trail
-- that says who wrote each row, and enforce both at the database.
--
-- Three holes, all in the same table, all pre-dating 0009's staff_insert fix:
--
--  1. `account_activity_admin_all` (0002) is FOR ALL and permissive, so it
--     OR-unions PAST the narrowed `account_activity_staff_insert`: an admin
--     could insert the three agent kinds through any surface a model can reach,
--     and could UPDATE or DELETE any row — including rows service_role wrote
--     and including someone else's `actor_email`. An audit trail an
--     authenticated session can rewrite is not an audit trail.
--
--  2. `actor_email` was whatever the app chose to send, which for three of the
--     four writers was NULL and for any future writer could be anyone's
--     address.
--
--  3. The kind rule lived only in the RLS policy and the app layer, so a
--     writer reaching the table another way was not covered.
--
-- The fix: authenticated writers may only APPEND, their `actor_email` is
-- stamped from their own JWT, and the agent kinds are refused for them in a
-- trigger as well as in the policy. service_role (the jobs) bypasses RLS and
-- is deliberately NOT stamped — those rows carry the agent's own actor.
-- ---------------------------------------------------------------------------

-- -- 1. admin: read, and nothing else -----------------------------------------
-- Replaces 0002's FOR ALL. INSERT for an admin now falls through to
-- `account_activity_staff_insert`, which 0009 narrowed to the human kinds; and
-- with no UPDATE or DELETE policy on the table for anyone, no authenticated
-- session can alter or remove a row that has been written.
drop policy if exists account_activity_admin_all on account_activity;

create policy account_activity_admin_select on account_activity
  for select to authenticated
  using (public.is_admin());

-- -- 2 + 3. authorship and the kind rule, in one before-insert trigger --------
-- `current_user` is the role the statement runs as: `authenticated` for anyone
-- arriving through PostgREST with a user JWT, `service_role` for the jobs.
-- Only the first is stamped and restricted, which is exactly the boundary RLS
-- draws — this trigger just makes it hold for writers RLS is not consulted for.
--
-- search_path is pinned empty (same rule as 0002's helpers), so every reference
-- is schema-qualified.
create or replace function public.account_activity_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if new.kind in ('ai_email_sent', 'ai_email_reply', 'agent_run') then
      raise exception
        'account_activity kind % is written by the automation as service_role, not by a person',
        new.kind
        using errcode = 'check_violation';
    end if;
    -- Authorship is the session's, never the payload's.
    new.actor_email := nullif(auth.jwt() ->> 'email', '');
  end if;
  return new;
end;
$$;

create trigger account_activity_guard_insert
  before insert on account_activity
  for each row execute function public.account_activity_guard();
