# Scheduler — why Cloud Scheduler drives the clock

GitHub's `schedule` event is best-effort. On this repo it delivered six of
thirty-nine `*/20` ticks on 2026-09-04 and none at all for four hours. A
`workflow_dispatch` starts within seconds, every time. So the ticks come from
**Cloud Scheduler** in the GCP project (`vars.GCP_PROJECT`), one job per cron
string in `SCHEDULES` (`jobs/run.mjs`), each posting a `workflow_dispatch`
with `schedule` set to that exact cron string. The crons in `clock.yml` stay
as a backup; the concurrency group keyed on the schedule string means a
backup tick that does land queues behind the dispatched one instead of
overlapping it.

`SCHEDULES` is still the only map from cron to job. The scheduler jobs carry
the cron string, never a job name — a new job is wired by editing `SCHEDULES`
and `clock.yml` and adding one scheduler job with the same string.

## One-time setup

1. Mint a fine-grained GitHub PAT: resource owner `bcn-services`, repository
   `bcns-internal` only, permission **Actions: read and write**. Nothing else.
2. Enable the API and create the jobs (`scripts/scheduler-setup.sh` does this
   interactively; the PAT goes straight from the clipboard into the job
   header and never into a file):

   ```
   gcloud services enable cloudscheduler.googleapis.com
   gcloud scheduler jobs create http clock-poll \
     --location us-central1 --schedule '*/20 8-20 * * 1-5' --time-zone UTC \
     --uri https://api.github.com/repos/bcn-services/bcns-internal/actions/workflows/clock.yml/dispatches \
     --http-method POST \
     --headers "Authorization=Bearer $PAT,Accept=application/vnd.github+json" \
     --message-body '{"ref":"main","inputs":{"schedule":"*/20 8-20 * * 1-5"}}'
   ```

   Same shape for `clock-touch`, `clock-source`, `clock-personalize`.
   `ref` is the branch the workflow runs on — `main` in production.

## Verifying a run came from the scheduler

A scheduler-dispatched run shows on the Actions page as
"Manually run by <PAT owner>" with `event: workflow_dispatch`. Tell it apart
from a human dispatch by the input: the scheduler always sends `schedule`,
a human sends `job`. `gh run view <id> --json displayTitle` and the run's
`inputs` in the API carry it.

## Rotating the PAT

Fine-grained PATs expire. `gcloud scheduler jobs update http <job>
--update-headers "Authorization=Bearer $NEW"` for each job. Cloud Scheduler
retries a failed POST (401 after expiry) and logs it; Monitoring alerts on
`scheduler.googleapis.com/job/attempt_count` with a failed status if wanted.
