-- ---------------------------------------------------------------------------
-- 0026_no_email_pool — a calling lead with an email vs. one qualify never
-- found an address for.
--
-- Before this migration, `call_due` meant two different things: a row qualify
-- read and found no address on, and a row an email bounced or failed
-- verification against. Both landed at `call_due` with no way to tell them
-- apart in SQL. `no_email` is the first of those — qualify now writes it for
-- a business with no domain, no discoverable address, or a failed
-- verification, and `db.promoteNoEmail` (lib/db.mjs) is what moves the best
-- of that pool to `call_due` for the day's call list.
--
-- THE BACKFILL. A row already at `call_due` with no email and zero touches
-- was never actually called — nothing sent it there but qualify's own
-- "nothing to mail" verdict. That set moves to `no_email` so the promotion
-- logic (`db.promoteNoEmail`) has a real pool to rank rather than starting
-- empty. A row with touches > 0 was call_due because touch's third-touch
-- rule sent it there after a real send sequence; that is a different history
-- and stays exactly where it is.
--
-- Additive only, same shape as 0019/0022: the CHECK is replaced wholesale
-- (copying 0022's full thirteen, not editing 0022 itself, which is applied
-- and immutable) and every existing row already satisfies the wider set.
-- ---------------------------------------------------------------------------

begin;

alter table businesses drop constraint businesses_stage_check;

alter table businesses add constraint businesses_stage_check check (stage in (
  'sourced',
  'qualified',
  'call_due',
  'drafted',
  'approved',
  'sent',
  'replied',
  'quoting',
  'meeting',
  'quoted',
  'won',
  'onboarded',
  'lost',
  'no_email'
));

-- Only the rows call_due for no reason but a missing address, never touched.
update businesses
set stage = 'no_email'
where stage = 'call_due' and email is null and coalesce(touches, 0) = 0
  and next_touch_at is null;  -- a scheduled "no answer" re-call stays with Brandon

commit;
