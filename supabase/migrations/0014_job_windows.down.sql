-- Reverses 0014_job_windows.
--
-- Dropping the column drops the unique index with it, and with the index goes
-- the only thing that stops a scheduler retry from producing a second run and
-- a second notification. The rows themselves are untouched: a `job_runs` row is
-- still a complete record of a run without knowing which window it belonged to.
--
-- Run this only alongside reverting lib/jobs.ts — a claimRun against a table
-- with no window_key column errors on every insert, which the job framework
-- reports as a failed claim rather than as a silent skip.

drop index if exists job_runs_window_idx;

alter table job_runs
  drop column if exists window_key;
