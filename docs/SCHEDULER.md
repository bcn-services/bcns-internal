# Scheduler — why Cloud Scheduler drives the clock

GitHub's `schedule` event is best-effort. On this repo it delivered six of
thirty-nine `*/20` ticks on 2026-09-04 and none at all for four hours. A
`workflow_dispatch` starts within seconds, every time. So the ticks come from
**Cloud Scheduler** in the GCP project (`vars.GCP_PROJECT`), one job per cron
string in `SCHEDULES` (`jobs/run.mjs`), each posting a `workflow_dispatch`
with `schedule` set to that exact cron string.

`clock.yml` has **no `schedule:` block at all** — Cloud Scheduler is the sole
trigger. The native crons were removed because they were useless as a fallback
(they drop most ticks) and expensive when they did land: a tick that arrived
duplicated the dispatched run and burned Actions minutes the org's free 2000/mo
allowance cannot spare.

`SCHEDULES` is the only map from cron to job. The scheduler jobs carry the cron
string, never a job name — a new job is wired by editing `SCHEDULES` and adding
one scheduler job with the same string.

Poll runs **hourly, every day of the week** (`0 8-20 * * *`, 13 ticks a day),
down from every 20 minutes on weekdays only. It never sends outreach — it
reads the inbox and reports — so there is no reputation cost to covering
weekends, and a reply doesn't sit unread until Monday.

## One-time setup

1. Mint a fine-grained GitHub PAT: resource owner `bcn-services`, repository
   `bcns-internal` only, permission **Actions: read and write**. Nothing else.
2. Enable the API and create the jobs (`scripts/scheduler-setup.sh` does this
   interactively; the PAT goes straight from the clipboard into the job
   header and never into a file):

   ```
   gcloud services enable cloudscheduler.googleapis.com
   gcloud scheduler jobs create http clock-poll \
     --location us-central1 --schedule '0 8-20 * * *' --time-zone UTC \
     --uri https://api.github.com/repos/bcn-services/bcns-internal/actions/workflows/clock.yml/dispatches \
     --http-method POST \
     --headers "Authorization=Bearer $PAT,Accept=application/vnd.github+json" \
     --message-body '{"ref":"main","inputs":{"schedule":"0 8-20 * * *"}}'
   ```

   Same shape for `clock-touch`, `clock-source`, `clock-personalize`.
   `ref` is the branch the workflow runs on — `main` in production.

## Switching the live clock-poll job to hourly, every day — TODO

`SCHEDULES` (`jobs/run.mjs`) already carries only `'0 8-20 * * *'` — the old
`*/20 8-20 * * 1-5` shim key is gone. The live `clock-poll` Cloud Scheduler job
has not been updated to match: it still sends `*/20 8-20 * * 1-5`, which is no
longer a key `jobNames()` recognizes, so **until this command runs, every
`clock-poll` tick throws and the pipeline is dark for poll/pitch/quote/onboard/
notify.** Run this once, promptly:

```
gcloud scheduler jobs update http clock-poll --project bcns-leads --location us-central1 --schedule '0 8-20 * * *' --time-zone UTC --message-body '{"ref":"main","inputs":{"schedule":"0 8-20 * * *"}}' --format=none
```

`--format=none` matters: the default output prints the job's headers, which
include the `Authorization` bearer PAT. The cron in `--message-body` must match
the `--schedule` **and** an exact key in `SCHEDULES`; `jobNames()` throws on a
miss, which would take the pipeline dark.

## Verifying a run came from the scheduler

A scheduler-dispatched run shows on the Actions page as
"Manually run by <PAT owner>" with `event: workflow_dispatch`. Tell it apart
from a human dispatch by the input: the scheduler always sends `schedule`,
a human sends `job`. `gh run view <id> --json displayTitle` and the run's
`inputs` in the API carry it.

## Rotating the PAT

Fine-grained PATs expire. `gcloud scheduler jobs update http <job>
--update-headers "Authorization=Bearer $NEW" --format=none` for each job. Always pass `--format=none` to `jobs update`: the default output prints the headers, PAT included. Cloud Scheduler
retries a failed POST (401 after expiry) and logs it; Monitoring alerts on
`scheduler.googleapis.com/job/attempt_count` with a failed status if wanted.
