-- ---------------------------------------------------------------------------
-- 0027_unstick_qualify — clear the rows that stalled qualify and the call list.
--
-- Two data fixes, no schema change (the stage vocabulary is 0026's).
--
-- 1. THE QUALIFY WALL. `sourcedBacklog` took the oldest 100 `sourced` rows, and
--    a row whose site failed (fetch error, 403, empty page) stayed at the head
--    forever. qualify now counts failures per row and parks a row at `no_email`
--    on the third (jobs/qualify.mjs); this moves the rows that already have
--    three or more `qualify` error/skipped events instead of waiting three more
--    ticks. Events carry the business id as detail->>'business'.
--
-- 2. PHONELESS CALL TASKS. `promoteNoEmail` promoted rows with no phone number,
--    each eating one of the 20 daily call slots with nothing to dial. It now
--    skips them (lib/db.mjs); this returns the ones already promoted, never
--    touched and with no address either, to the pool. Same predicate as 0026's
--    backfill plus the empty-phone test.
-- ---------------------------------------------------------------------------

begin;

update businesses
set stage = 'no_email', updated_at = now()
where stage = 'sourced'
  and id::text in (
    select detail->>'business'
    from events
    where job = 'qualify' and kind in ('error', 'skipped') and detail->>'business' is not null
    group by detail->>'business'
    having count(*) >= 3
  );

update businesses
set stage = 'no_email', updated_at = now()
where stage = 'call_due'
  and coalesce(phone, '') = ''
  and email is null
  and coalesce(touches, 0) = 0;

commit;
