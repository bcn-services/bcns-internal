-- ---------------------------------------------------------------------------
-- 0027_unstick_qualify — clear the rows that stalled qualify and the call list.
--
-- Two data fixes, no schema change (the stage vocabulary is 0026's).
--
-- 1. THE QUALIFY WALL. `sourcedBacklog` took the oldest 100 `sourced` rows, and
--    a row whose site failed (fetch error, 403, empty page) stayed at the head
--    forever. qualify now counts fetch-phase failures per row and parks a row
--    at `no_email` on the third (jobs/qualify.mjs); this moves the rows that
--    already have three or more fetch-class `qualify` events instead of waiting
--    three more ticks. Fetch-class means an empty-page skip, or an error whose
--    message is a fetch failure, an HTTP status from createFetchPage ("fetch
--    <url> returned 403") or a timeout abort; Claude/parse/DB errors do not
--    count, matching the job. Events carry the business id as
--    detail->>'business'. A row with even one email-uniqueness error
--    (businesses_email_key) is parked too, mirroring the job's 23505 path.
--
-- 2. PHONELESS CALL TASKS. `promoteNoEmail` promoted rows with no phone number,
--    each eating one of the 20 daily call slots with nothing to dial. It now
--    skips them (lib/db.mjs); this returns the ones already promoted, never
--    touched and with no address either, to the pool. Same predicate as 0026's
--    backfill plus the empty-phone test. 0026's `next_touch_at is null` guard
--    is dropped on purpose: promoteNoEmail itself sets next_touch_at = now(), so
--    every promoted row has one. The small cost is a phoneless row Brandon
--    scheduled a re-call on, which also goes back to the pool.
-- ---------------------------------------------------------------------------

begin;

update businesses
set stage = 'no_email', updated_at = now()
where stage = 'sourced'
  and (id::text in (
    select detail->>'business'
    from events
    where job = 'qualify' and detail->>'business' is not null
      and (
        (kind = 'skipped' and detail->>'reason' = 'page fetch returned no text')
        or (kind = 'error' and (
          detail->>'error' like 'fetch %'
          or detail->>'error' like '%operation was aborted%'
        ))
      )
    group by detail->>'business'
    having count(*) >= 3
  )
  or id::text in (
    select detail->>'business'
    from events
    where job = 'qualify' and kind = 'error'
      and detail->>'error' like 'duplicate key value violates unique constraint "businesses_email_key"%'
  ));

update businesses
set stage = 'no_email', updated_at = now()
where stage = 'call_due'
  and coalesce(trim(phone), '') = ''
  and email is null
  and coalesce(touches, 0) = 0;

commit;
