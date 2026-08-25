#!/usr/bin/env node
/**
 * run-job.mjs — the plain entry point a cron line calls.
 *
 *   corepack pnpm job site_health
 *   corepack pnpm job credential_expiry
 *   corepack pnpm job quiet_clients
 *
 * THIS SCRIPT DOES NOT SCHEDULE ANYTHING. It runs one job once and exits.
 * There is no timer, no loop and no daemon anywhere in lib/jobs.ts — when a job
 * runs is the caller's business, which is why the crontab lines live in
 * docs/JOBS.md as text for a human to install and not in this repo as code. No
 * cron entry and no launchd plist is installed by this branch; there is no
 * droplet yet.
 *
 * Run through `tsx`, not bare node: this imports the .ts job layer.
 *
 * IDEMPOTENT ON PURPOSE. Running it twice in the same window is safe and is
 * expected — the second invocation loses the race on `job_runs_window_idx`
 * (0014), does no work and notifies nobody. That is what makes it safe for a
 * human to run by hand to see what a job would say.
 *
 * EXIT CODES, so a scheduler can alert on its own:
 *   0  the run was clean, or another invocation already owned this window
 *   1  the run finished with findings, or failed
 *   2  usage: no job name, or a name that is not in the registry
 */

import { createClient } from "@supabase/supabase-js";
import { markServiceClient } from "../lib/service-client-mark.ts";
import { jobRegistry, runJob } from "../lib/jobs.ts";

const name = process.argv[2];
const registry = jobRegistry();
const known = Object.keys(registry).join(", ");

if (!name || !(name in registry)) {
  console.error(`usage: pnpm job <${known}>`);
  process.exit(2);
}

// The service client is built HERE and handed in. lib/jobs.ts never constructs
// one, takes no id from anywhere, and reads only whole tables of internal
// operational data — see the bounding note in that file's header.
//
// `createClient` directly rather than lib/supabase-admin.ts, for the same
// reason scripts/backfill-leads.mjs and scripts/provision-user.mjs do it:
// that module imports `server-only`, which throws the moment it is loaded
// outside a React server render — so a CLI entry point cannot use it at all.
// The `markServiceClient` stamp is still applied, so the RLS-bound data-layer
// functions that refuse a service client still refuse this one.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured");
  process.exit(1);
}
const db = markServiceClient(
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
);

const out = await runJob(registry[name], { db });

if (!out.ran && out.status === null) {
  console.log(`${out.job}: ${out.log}`);
  process.exit(0);
}

console.log(`${out.job} [${out.windowKey}] ${out.status}\n${out.log}`);
for (const f of out.findings) console.log(`  ! ${f}`);
process.exit(out.status === "ok" ? 0 : 1);
