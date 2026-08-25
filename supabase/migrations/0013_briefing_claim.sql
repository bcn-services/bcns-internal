-- ---------------------------------------------------------------------------
-- 0013_briefing_claim — one column, so the briefing throttle is a WRITE and not
-- a read-then-write.
--
-- 0009 gave `profiles` `last_briefed_at`, and it looks like it could serve as
-- the throttle marker too. It cannot, and the reason is the whole point of this
-- migration: `last_briefed_at` is the WINDOW boundary and may advance only when
-- a briefing actually reached somebody. A failed run must leave it alone, or
-- the week it was supposed to cover is swallowed. But a failed run still has to
-- count against a throttle, or a login loop is a run loop.
--
-- Two facts, two columns:
--
--   last_briefed_at     — the last SUCCESS. Everything since it is the window.
--   briefing_claimed_at — the last ATTEMPT. What the 20-hour throttle reads.
--
-- WHY A COLUMN AND NOT A LOCK. The claim is
--
--   update profiles set briefing_claimed_at = now()
--    where id = $1 and (briefing_claimed_at is null or briefing_claimed_at < $2)
--   returning last_briefed_at
--
-- which is a single statement, so two simultaneous logins serialize on the row
-- lock and the second re-evaluates its WHERE against the winner's committed row
-- under READ COMMITTED. It finds a fresh timestamp, matches nothing, and
-- returns no rows. Exactly one caller is told it may run — no advisory lock, no
-- SELECT-then-INSERT window, and nothing to clean up if the process dies.
--
-- NO INDEX. Every read of this column is by primary key, on a table with one
-- row per employee.
--
-- NO POLICY CHANGE. The writer is the briefing job through the service-role
-- client, which bypasses RLS; 0004's own-profile policies already decide what a
-- person may see of their own row, and this column joins that set with nothing
-- sensitive in it — it is a timestamp saying the machine tried.
-- ---------------------------------------------------------------------------

begin;

alter table profiles
  add column briefing_claimed_at timestamptz;

commit;
