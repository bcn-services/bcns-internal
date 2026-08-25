-- Reverses 0015_outreach_lanes.
--
-- Destructive on the new table, as a down migration on a new table must be:
-- every draft goes. Nothing else references them.
--
-- The outreach_mode CHECK cannot be narrowed back while rows hold
-- 'no_response', so those leads are moved to 'paused' first. That is a lossy
-- but SAFE direction: 'paused' also means the bot leaves them alone, so
-- reversing this migration cannot restart outreach on a lead the bot had
-- already given up on. Going the other way — resetting them to 'ai' — would.
--
-- One transaction, for the same reason the up migration is one.

begin;

drop trigger if exists account_activity_pause_outreach on account_activity;
drop function if exists public.pause_outreach_on_human_activity();

drop table if exists outreach_drafts;

update accounts set outreach_mode = 'paused' where outreach_mode = 'no_response';

alter table accounts
  drop constraint if exists accounts_outreach_mode_check;

alter table accounts
  add constraint accounts_outreach_mode_check
    check (outreach_mode in ('ai', 'human', 'paused'));

commit;
