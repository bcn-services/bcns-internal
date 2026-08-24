/**
 * pg-cluster.mjs — ephemeral Postgres harness for the bcns-internal migrations.
 *
 * Adapted from bcns-client-coventry/tests/helpers/pg-cluster.mjs. Boots a
 * throwaway PG cluster on a random high port (unix socket only), EMULATES the
 * Supabase auth surface (auth.jwt() reading the request.jwt.claims GUC, plus the
 * anon/authenticated/service_role roles and Supabase's default
 * `grant all on all tables to authenticated`), applies the migrations, and
 * exposes a per-JWT-claims query runner that impersonates `authenticated`.
 *
 * Why a real cluster and not a mock: RLS policy evaluation is a Postgres
 * behavior — a mock proves nothing about whether a member can write a client row.
 *
 * Needs no Docker and does NOT touch any Postgres already running on this
 * machine: initdb creates a fresh data directory under $TMPDIR and it is deleted
 * on stop(). Teardown is the caller's job via the returned stop(); always call it
 * in a finally so no cluster is orphaned.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PG_BIN = "/opt/homebrew/bin";
export const initdb = join(PG_BIN, "initdb");
export const pgCtl = join(PG_BIN, "pg_ctl");
export const psqlBin = join(PG_BIN, "psql");
export const pgIsReady = join(PG_BIN, "pg_isready");
export const toolsPresent = [initdb, pgCtl, psqlBin, pgIsReady].every((p) => existsSync(p));

const READY_TIMEOUT_MS = 30000;
const DB_NAME = "bcns_internal_test";

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = resolve(here, "../../supabase/migrations");
const mig = (n) => join(migrationsDir, n);

export const UP = ["0001_core_schema.sql", "0002_rls_policies.sql"];

// Supabase emulation: the auth schema + auth.jwt() (reads the request.jwt.claims
// GUC that impersonation sets) + the three Supabase roles. Mirrors what Supabase
// provisions BEFORE any migration runs, so 0002's auth.jwt() references resolve.
const SUPABASE_EMULATION = `
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $fn$
  select coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb
$fn$;
create function auth.uid() returns uuid language sql stable as $fn$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$fn$;
-- auth.users, minimal. Supabase provisions this before any migration, and 0004
-- takes a foreign key on it. Only the columns a migration may reference are
-- modelled — this is a stand-in for the FK target, not a copy of Supabase's
-- real table, which carries dozens of auth-internal columns we never touch.
create table auth.users (
  id    uuid primary key,
  email text unique
);
create role anon;
create role authenticated;
create role service_role;
grant usage on schema auth, public to anon, authenticated, service_role;
`;

// Supabase grants `authenticated` ALL on public tables by default; RLS, not
// missing grants, is what restricts rows. Applied AFTER the keyless schema
// migration and BEFORE the policy migration, to match production ordering.
//
// The second statement is what makes this hold for migrations that come LATER.
// Supabase sets default privileges on the public schema, so a table created by
// 0003 or 0009 is granted the moment it exists. Without it the one-shot `grant
// on all tables` covers only what existed when it ran, and every table added
// after 0002 is invisible to `authenticated` here while working in production —
// the harness would report a policy failure that is really a harness gap.
const SUPABASE_DEFAULT_GRANTS =
  `grant all on all tables in schema public to authenticated;` +
  `alter default privileges in schema public grant all on tables to authenticated;`;

export function startClusterWithMigrations(migrations = UP, { emulateAuth = true } = {}) {
  const port = String(50000 + Math.floor(Math.random() * 10000));
  const workDir = mkdtempSync(join(tmpdir(), "bcns-int-"));
  const dataDir = join(workDir, "data");
  const logFile = join(workDir, "postmaster.log");
  let started = false;

  const stop = () => {
    if (started) {
      try {
        execFileSync(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
      } catch {
        // best effort
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  };

  try {
    execFileSync(initdb, ["-D", dataDir, "-A", "trust", "--no-sync"], { stdio: "ignore" });
    execFileSync(
      pgCtl,
      ["-D", dataDir, "-l", logFile, "-o",
       `-c listen_addresses='' -c unix_socket_directories='${workDir}' -c port=${port}`, "start"],
      { stdio: "ignore" },
    );
    started = true;
    waitUntilReady(workDir, port);

    execFileSync(psqlBin, ["-h", workDir, "-p", port, "-d", "postgres", "-c",
                           `create database ${DB_NAME}`], { stdio: "ignore" });

    const psqlArgs = (extra) => ["-h", workDir, "-p", port, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", ...extra];

    // Data-returning query as the superuser (bypasses RLS). Setup + asserting
    // the physical policy/constraint state.
    const run = (sql) =>
      execFileSync(psqlBin, psqlArgs(["-q", "-tAc", sql]), { encoding: "utf8" }).trim();

    // Same, but returns {ok,error} instead of throwing — for negative tests on
    // constraints (a CHECK violation is expected to fail).
    const tryRun = (sql) => {
      try {
        return { ok: true, out: execFileSync(psqlBin, psqlArgs(["-q", "-tAc", sql]), { encoding: "utf8" }).trim() };
      } catch (e) {
        return { ok: false, error: String(e.stderr ?? e.message ?? e) };
      }
    };

    const runFile = (filename) =>
      execFileSync(psqlBin, psqlArgs(["-q", "-f", mig(filename)]), { stdio: "ignore" });

    const tryRunFile = (filename) => {
      try {
        execFileSync(psqlBin, psqlArgs(["-q", "-f", mig(filename)]), { stdio: "pipe" });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.stderr ?? e.message ?? e) };
      }
    };

    if (emulateAuth) execFileSync(psqlBin, psqlArgs(["-c", SUPABASE_EMULATION]), { stdio: "ignore" });

    // 0001 is keyless and applies with no auth schema; 0002 needs auth.jwt().
    for (const m of migrations) {
      if (m === "0002_rls_policies.sql") {
        execFileSync(psqlBin, psqlArgs(["-c", SUPABASE_DEFAULT_GRANTS]), { stdio: "ignore" });
      }
      execFileSync(psqlBin, psqlArgs(["-f", mig(m)]), { stdio: "ignore" });
    }

    const serverVersionNum = Number(run("show server_version_num"));

    /**
     * Run `query` as the `authenticated` role with the given JWT claims, inside a
     * transaction discarded when psql disconnects.
     *
     * CRITICAL: the data-returning statement must be LAST and there is NO trailing
     * rollback — a single-string simple query returns only the LAST command's rows,
     * so `; rollback` would swallow the SELECT output. Session end rolls it back.
     */
    const runClaims = (claims, query) => {
      const claimsJson = JSON.stringify(claims).replace(/'/g, "''");
      const sql =
        `begin;` +
        `select set_config('request.jwt.claims', '${claimsJson}', true);` +
        `set local role authenticated;` +
        `${query}`;
      try {
        const out = execFileSync(psqlBin, psqlArgs(["-q", "-tAc", sql]), {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        return { ok: true, out };
      } catch (e) {
        return { ok: false, error: String(e.stderr ?? e.message ?? e) };
      }
    };

    const conn = { socketDir: workDir, port, dbName: DB_NAME };
    return { serverVersionNum, run, tryRun, runClaims, runFile, tryRunFile, conn, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

function waitUntilReady(socketDir, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      execFileSync(pgIsReady, ["-h", socketDir, "-p", port, "-d", "postgres"], { stdio: "ignore" });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`Postgres never became ready on ${socketDir}:${port}`);
      execFileSync("/bin/sleep", ["0.25"]);
    }
  }
}

export const IDS = {
  acctWon:  "11111111-1111-1111-1111-111111111111",
  acctLead: "22222222-2222-2222-2222-222222222222",
  client:   "33333333-3333-3333-3333-333333333333",
};

// One won account that IS a client, and one untouched lead that is not.
export function seedFixture(run) {
  run(`insert into accounts (id, place_id, business_name, business_type, city, status, deal_value_cents)
       values ('${IDS.acctWon}', 'ChIJ_test_won', 'Coventry Contracting', 'contractor', 'Rye', 'won', 150000)`);
  run(`insert into accounts (id, business_name, business_type, city, status)
       values ('${IDS.acctLead}', 'Untouched Diner', 'restaurant', 'Rye', 'new')`);
  run(`insert into clients (id, account_id, slug, status, monthly_rate_cents, domain)
       values ('${IDS.client}', '${IDS.acctWon}', 'coventry', 'active', 15000, 'coventrycontracting.com')`);
}

export const CLAIMS = {
  admin:  { app_metadata: { role: "admin" } },
  member: { app_metadata: { role: "member" } },
  // Invited but never provisioned with a role. Must see NOTHING (fail-safe).
  noRole: { app_metadata: {} },
  // A tampering-shaped claim: role in user_metadata, which is user-writable and
  // must NOT be honored.
  fake:   { user_metadata: { role: "admin" } },
};
