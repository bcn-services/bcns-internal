-- ---------------------------------------------------------------------------
-- 0021_mailbox_daily_reset — make `daily_cap` mean per-day again.
--
-- `mailboxes.sent_today` is incremented by claimMailboxSlot and reset by
-- nothing: no job does a rollover and no cron cell zeroes it. The column is
-- therefore a LIFETIME counter, and `daily_cap` a lifetime cap. Once a mailbox
-- has claimed `cap` slots in total it is never selected again and touch logs
-- `every mailbox is at its warmed cap` forever — silently, since that is a
-- skipped event, not an error. The warming ramp makes the real ceiling 5 in a
-- mailbox's first week.
--
-- The fix is a date to compare against, not a scheduled job: a counter that
-- carries the day it belongs to resets itself on first use the next day, with
-- no tick to miss and nothing to go wrong while the runner is asleep.
--
-- Backfilled to `current_date` rather than null so today's existing count is
-- read as today's, not discarded — a mailbox that has already sent today keeps
-- its slots spent.
-- ---------------------------------------------------------------------------

begin;

alter table mailboxes add column sent_on date not null default current_date;

commit;
