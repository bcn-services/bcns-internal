# Scheduled jobs

Five jobs, one framework, and no scheduler. `lib/jobs.ts` holds the framework
and the first three; `lib/outreach.ts` holds the two lead jobs (item 10) and
registers them in the same registry. `scripts/run-job.mjs` runs one of them
once and exits.

**Nothing in this repo installs a schedule.** There is no droplet yet, so the
crontab lines below are text for a human to install, not code that installs
itself. No job has a timer, a loop, or a "next run at" column — when a job runs
is the caller's business and nothing else's.

## The jobs

| name | schedule | what it does | when it emails |
|---|---|---|---|
| `site_health` | daily | HTTP-checks every client that has a `domain` or a `droplet_host` | a monitored site is down |
| `credential_expiry` | weekly | watches `agent_tokens.expires_at` and the GitHub PAT (2026-10-31) | something expires within 30 days |
| `quiet_clients` | daily | flags `onboarding` clients with no signal for more than 7 days | a client has gone quiet |
| `lead_outreach` | daily | drafts the next touch for every lead in the `ai` lane; parks a lead as `no_response` after three touches with no reply | every due lead's website was unreadable |
| `lead_sweep` | weekly | picks the next trade/town pairs from `lead_targets`, or from segments that have earned it | never — an empty target list is a gap, not an outage |
| `readme_export` | daily | rewrites the generated frontmatter block in `$OS_DIR/clients/<slug>/README.md` and commits it as `bcns-os-bot` | a README has lost its markers, or the commit did not land |

**`lead_outreach` sends nothing.** It writes rows to `outreach_drafts`, which
has no recipient column, no `sent_at` and no status — the table cannot
represent a sent message. Whoever eventually sends one opens the lead to find
out where it would go. The only network call is `read_site` (item 3, unchanged)
against the lead's own website, and it is injected, so no test can make it.

**`readme_export` is one-way and marker-bounded.** Supabase is authoritative;
the README is an export target. The job rewrites only what sits between
`# --- bcns:generated ... ---` and `# --- bcns:end ---` inside the YAML
frontmatter, and the search for those two lines is confined to the frontmatter
region — so the hand-written prose body is never parsed, never searched and
never rewritten. A README that has lost its markers is REFUSED, not repaired.
No money column is ever selected, so a NULL monthly rate exports as an absent
field and there is no branch that could turn it into a `0`. `OS_DIR` must be
set: there is no `~/os` fallback, and an unset one is a finding rather than a
guess. Nothing derives from the wall clock, so an unchanged night writes no
bytes and makes no commit.

**`lead_sweep` selects a territory; it does not prospect one.** Running the
real `leads` skill (Google Places, its own budget cap) stays a human action —
duplicating it here would be a second thing to keep in step with the skill.

`site_health` reports a client with neither a `domain` nor a `droplet_host` as
**unmonitorable** — a third state, never rolled into healthy. Four of the five
real clients are in that state today. It is counted in the run log and is
deliberately **not** a finding: emailing about the same four blank rows every
morning would train everyone to ignore this job. Fill in a `domain` and the
client starts being monitored.

## Running one by hand

```sh
corepack pnpm job site_health
corepack pnpm job credential_expiry
corepack pnpm job quiet_clients
corepack pnpm job lead_outreach
corepack pnpm job lead_sweep
```

Safe to run any time. The second run inside the same window loses the race on
`job_runs_window_idx` and exits 0 having done nothing — so a hand run cannot
produce a duplicate notification, and cannot suppress a real one either, since
the window's one run is the one that already notified.

Exit codes: `0` clean (or already run), `1` findings or failure, `2` bad usage.

## Crontab lines to install on the droplet

Install these by hand once the droplet exists. Times are UTC; pick a window
that is not a deploy window.

```cron
# bcns-internal scheduled jobs. See docs/JOBS.md.
# m  h  dom mon dow  command
CRON_TZ=UTC
  10 6   *   *   *   cd /srv/bcns-internal && corepack pnpm job site_health   >> /var/log/bcns/site_health.log 2>&1
  25 6   *   *   *   cd /srv/bcns-internal && corepack pnpm job quiet_clients >> /var/log/bcns/quiet_clients.log 2>&1
  40 6   *   *   1   cd /srv/bcns-internal && corepack pnpm job credential_expiry >> /var/log/bcns/credential_expiry.log 2>&1
  55 6   *   *   *   cd /srv/bcns-internal && corepack pnpm job readme_export >> /var/log/bcns/readme_export.log 2>&1
```

The environment cron gives a job is not a login shell's. Either put
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in the crontab above these lines,
or wrap each command in `set -a && . /srv/bcns-internal/.env && set +a &&`.

A missed run is not worth catching up on: the next day's run reports the same
state. Do not add `@reboot` entries.

## Where a run shows up

Every run writes a `job_runs` row — `job`, `window_key`, `started_at`,
`finished_at`, `status`, `log` — including one that threw, timed out, or had a
promise reject under it. A row still `running` with a null `finished_at` an hour
later means the process was killed, and `job_runs_unfinished_idx` is the index
that finds it:

```sql
select job, window_key, started_at from job_runs where finished_at is null;
```

Every run also routes one notification through `lib/notify.ts`, whose rule table
is settled and which this feature does not change:

- clean run → `job_run_ok` → the admin's inbox, no email
- findings, a throw, or a timeout → `job_run_failed` → the admin's inbox **and**
  an email

`failed` therefore means "this sweep did not come back clean", which covers both
a job that broke and a job that worked and found something. That is deliberate:
a job's own status is the only lever the settled rule table gives it, and adding
a seventh event kind to route findings separately would have meant editing that
table.

## Credentials

The credential job reads `agent_tokens` for `profile_id, expires_at` and
**never** `sealed`. It cannot print a token because it never holds one. The
GitHub PAT is watched by its expiry DATE, which is a known operational fact and
is the only thing about it recorded anywhere in this repo. When it warns, rotate
the PAT in all three places (including the `GITHUB_TOKEN` export in
`~/.zprofile`).

## Deferred

- **Commit reading.** `quiet_clients` takes a `CommitReader` and production
  passes the one that always answers "unknown", so `clients.repo` currently
  contributes nothing. Reading commits needs a GitHub token this job does not
  have. An absent signal is treated as absent, never as evidence of quiet, so
  the detector is correct without it — just less sensitive. Add the reader when
  a token is available to the droplet.
- **Health history.** `site_health` records its verdicts in the run log, not in
  a table, so `quiet_clients` uses site liveness *now* rather than "the site
  came up on Tuesday". A health-history table is the upgrade.
- **Retention.** `job_runs.log` is unbounded, as 0009 intended. Trim it when the
  table gets big enough to notice.
