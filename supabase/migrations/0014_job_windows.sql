-- ---------------------------------------------------------------------------
-- 0014_job_windows — one column and one unique index, so a scheduled job's
-- idempotency is a CONSTRAINT and not a convention.
--
-- THE PROBLEM. Item 9's jobs are invoked by an external scheduler. A scheduler
-- retries. A human runs the script by hand to see what it says. A droplet
-- reboot fires a catch-up cron. Any of those can start the same daily sweep
-- twice inside the same day, and each run would post its own notice — the
-- guardrail is "running it twice in one window produces ONE notification, not
-- two".
--
-- WHY NOT A READ-THEN-WRITE. `select ... where job = $1 and started_at > $2`
-- followed by an insert is the exact race lib/briefing.ts exists to avoid: two
-- processes both read zero rows, both insert, both notify. 0013 solved the
-- briefing's version of this with a single conditional UPDATE whose WHERE is
-- re-evaluated under the row lock. A job has no pre-existing row to update —
-- the run row IS the thing being created — so the equivalent single-statement
-- primitive here is a UNIQUE INDEX and an INSERT that either wins or raises
-- 23505. Same guarantee, same number of statements, and the loser is told by
-- Postgres rather than by an application's opinion about a timestamp.
--
-- WINDOW_KEY IS THE JOB'S OWN LABEL FOR "THIS OCCURRENCE", not a timestamp:
-- '2026-08-24' for a daily job, 'w2951' for a weekly one (lib/jobs.ts). Two
-- invocations in the same day agree on the string; the second one collides.
-- Keeping it text rather than deriving a window from `started_at` in SQL means
-- the schedule is the caller's business, which is the item's other guardrail —
-- no job schedules itself, and the database has no opinion about how often.
--
-- NULLABLE, AND THE INDEX IS PARTIAL. The interactive skill runs written by
-- lib/agent/skill-run.ts (item 5) are NOT windowed — pressing a button twice
-- is meant to run it twice — so they insert a null and the partial index never
-- considers them. This is also why the column can be added to a populated
-- table with no backfill and no default.
--
-- NO POLICY CHANGE. 0009 already made `job_runs` admin-write / staff-read, and
-- the writer is the service role, which bypasses RLS. A window label is not
-- sensitive: it says which day a job belongs to.
-- ---------------------------------------------------------------------------

begin;

alter table job_runs
  add column window_key text;

-- THE WHOLE IDEMPOTENCY GUARANTEE. Unique on (job, window_key), partial so the
-- unwindowed interactive runs are exempt. An insert that collides raises
-- SQLSTATE 23505, which lib/agent/skill-run.ts's claimRun reads as "somebody
-- else already owns this window" and every other error as a real fault.
create unique index job_runs_window_idx
  on job_runs (job, window_key)
  where window_key is not null;

commit;
