-- Reverses 0016_pause_on_authenticated: the trigger goes back to 0015's
-- kind-list condition, verbatim.
--
-- Non-destructive — no data, no table, no function is touched, only the
-- trigger's WHEN clause. Lanes already paused stay paused, which is the safe
-- direction: reversing this must never restart the bot on a lead a person has
-- taken over.
--
-- One transaction, as in the up migration.

begin;

drop trigger if exists account_activity_pause_outreach on account_activity;

create trigger account_activity_pause_outreach
  after insert on account_activity
  for each row
  when (new.kind not in ('ai_email_sent', 'ai_email_reply', 'agent_run'))
  execute function public.pause_outreach_on_human_activity();

commit;
