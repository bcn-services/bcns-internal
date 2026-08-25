# Deploy — hosted-web

Documentation only. Target stack per `hosting-reference.md` (the platform
reference in `~/os/knowledge/library/bcns/`): a shared **DigitalOcean Droplet**
running one **systemd unit per client app under that client's own Unix user**,
fronted by **Cloudflare**, with a per-client **Supabase** project for Postgres,
auth, and file storage. No containers, no PM2. **The droplet never builds** —
CI builds the standalone bundle and ships it as an artifact; releases are
versioned directories switched by symlink, so rollback is instant.

Server-side scripts (droplet bootstrap, client onboarding, the
`bcns-app@.service` unit, nightly pg_dump backups) live in the `bcns`
monorepo under `infra/` — one copy per droplet, not per client repo.

## Prerequisites

- The shared DO droplet, provisioned by `infra/bootstrap.sh` (SSH-key-only
  auth, unattended security upgrades, UFW restricting web traffic to
  Cloudflare IPs — mirror it in the free DO cloud firewall — fail2ban,
  Node 22 + pnpm, nginx terminating TLS with a Cloudflare Origin CA cert,
  the `bcns-app@.service` unit installed, DO resource alerts on). This client
  onboarded by `infra/onboard-client.sh <slug> <port> <domain>` (creates the
  `<slug>` Unix user, `/srv/<slug>/` dirs, env file at mode 600, the nginx
  vhost proxying `<domain>` → the app's port, enables the unit).
- A **Supabase project for this client** (project-per-client is the tenant
  isolation model) → gives you `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- A Cloudflare zone (per-client subdomain or the client's own domain via
  CNAME), proxied (orange-cloud), "Full (strict)" TLS.
- (Optional) An Anthropic API key if the AI feature is opted in
  (`AI_ENABLED=1` + `ANTHROPIC_API_KEY`).
- Repo Actions secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY` (key for the
  `<slug>` user), `SUPABASE_DB_URL` (this client's project), and repo
  variable `CLIENT_SLUG`. Note: the workflows install `@nseluga/*` with the
  default `GITHUB_TOKEN` — each private package must grant this repo read
  access (package settings → manage Actions access), or swap in an
  org-scoped PAT secret.

## Steps

1. **Supabase** — create the client's project. Schema is applied only by CI:
   the `migrate` job in `.github/workflows/deploy.yml` runs on every deploy
   (push is idempotent — a no-op when no new migrations) and every migration
   must pass the **shadow-database gate** (a throwaway `supabase start` stack
   replays all migrations from zero and runs the test suite, including the
   RLS forbidden-read tests) before `supabase db push` touches the real
   project. The deploy job runs only after migrate succeeds, so code can
   never go live ahead of its schema. Never hand-run SQL in the dashboard.
2. **Env** — on the droplet, the client's env vars live in
   `/srv/<slug>/env`, owned by the `<slug>` user, mode 600. Per-client secret
   separation is kernel-enforced: each app runs as its own user and cannot
   read another client's files. The service-role key bypasses RLS —
   server-only, never in client-side code.
3. **App** — push to `main`. `.github/workflows/deploy.yml` builds the Next
   standalone bundle in CI, rsyncs it to
   `/srv/<slug>/releases/<sha>/`, flips the `/srv/<slug>/current` symlink,
   restarts `bcns-app@<slug>` (a ~1s restart gap — accepted at our scale),
   health-checks, and rolls itself back if the health check fails. Manual
   rollback = point `current` at the previous release and restart:

   ```bash
   ln -sfn /srv/<slug>/releases/<old-sha> /srv/<slug>/current
   sudo systemctl restart bcns-app@<slug>
   ```

   Logs: `journalctl -u bcns-app@<slug> -f`.
4. **Cloudflare** — point the client's subdomain at the droplet (proxied).
   Confirm the origin firewall only accepts Cloudflare IPs, and that signed
   /private content is never publicly cached (`Cache-Control: private`).
5. **Monitoring** — UptimeRobot monitor on `https://<domain>/api/health`
   (checks real DB connectivity, 503 on failure); Sentry project tagged with
   the client slug, PII scrubbing + per-project rate limit on before go-live.

## Notes

- No secrets in the repo or artifact; everything is injected via env at
  runtime. The app boots and serves 200 with every key absent, so a
  misconfigured env fails soft (feature-by-feature) rather than crashing.
- CI pins Node 22 to match the droplet — keep them in lockstep.
- Inbound webhooks (payment processor, SMS provider, accounting) are
  per-client additions: wire real signature verification into the seams in
  `lib/webhooks.ts` — the default verifier is fail-closed and rejects
  everything.
- Nightly `pg_dump` of every client project lands in the BCNS DO Spaces
  bucket (30-day retention) via `infra/backup.sh` — server-side cron, nothing
  to configure per repo. Signed contracts, when this app grows an e-sign
  flow, must be dual-written to that bucket at signing time.
- Three scheduled jobs (`site_health`, `credential_expiry`, `quiet_clients`)
  ship with this repo but NOTHING installs a schedule for them — there is no
  droplet yet. `docs/JOBS.md` carries the crontab lines to install by hand once
  there is, plus the env each line needs. Running one twice in the same window
  is safe: the second invocation loses on `job_runs_window_idx` and does
  nothing.
