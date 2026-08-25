-- ---------------------------------------------------------------------------
-- 0016_pause_on_authenticated — the pause trigger keys on the WRITER'S ROLE,
-- not on a hardcoded list of kinds.
--
-- WHAT WAS WRONG WITH 0015'S VERSION. Its WHEN clause was
-- `new.kind not in ('ai_email_sent', 'ai_email_reply', 'agent_run')` — a copy
-- of the agent-kind list, pinned in a place nobody editing that list would
-- think to look. Two ways it breaks, and neither is loud:
--
--   1. A FOURTH AGENT KIND. Add one in TypeScript and add it to the CHECK, and
--      this trigger — which knows only the three — treats every row the bot
--      writes of that kind as a human touch and pauses the lane the bot is
--      working. The automation switches itself off, silently.
--   2. A service_role BULK WRITE OF A HUMAN KIND. A CSV import or a backfill
--      that lands 'note' or 'call' rows is not a person picking up the phone,
--      but 0015's clause cannot tell the difference: it pauses every lead the
--      import touches, and a rep has to un-pause them one at a time.
--
-- THE BOUNDARY THAT IS ALREADY DRAWN. 0010's guard trigger asks exactly one
-- question — `current_user = 'authenticated'` — and that is the same question
-- this one wants: 'authenticated' is anyone arriving through PostgREST with a
-- user JWT, and 'service_role' is the automation. A person touched the lead if
-- and only if the write came in as `authenticated`.
--
-- The kind list is not needed as a second check either: 0009's INSERT policy
-- and 0010's guard both REFUSE the agent kinds from an authenticated session,
-- so "authenticated" already implies "not an agent kind". One boundary, tested
-- in one place, and adding a fourth agent kind changes nothing here.
--
-- WHERE THE TEST GOES. `current_user` is evaluated in the WHEN clause, in the
-- CALLER's context — deliberately not inside the function, which is
-- `security definer` and would therefore see the function OWNER there instead.
--
-- The function body is unchanged; only the trigger's condition moves.
-- One transaction, as in 0015.
-- ---------------------------------------------------------------------------

begin;

drop trigger if exists account_activity_pause_outreach on account_activity;

create trigger account_activity_pause_outreach
  after insert on account_activity
  for each row
  when (current_user = 'authenticated')
  execute function public.pause_outreach_on_human_activity();

commit;
