#!/usr/bin/env node
/**
 * seed-dev.mjs — apply supabase/seed/0002_dev_fixtures.sql to a LOCAL scratch
 * database, and refuse to apply it to anything else.
 *
 *   SEED_DATABASE_URL=postgres://postgres@127.0.0.1:54322/postgres \
 *     corepack pnpm seed-dev
 *
 * WHY A SCRIPT AND NOT A LINE OF psql IN A README. The fixtures are synthetic
 * on purpose, which is exactly what makes them dangerous: a copy-pasted psql
 * line pointed at the wrong URL puts invented businesses, invented monthly
 * rates and invented domains into the system of record, where they read as
 * facts. The guard below is the whole reason this file exists.
 *
 * IT READS ITS OWN VARIABLE, NOT `DATABASE_URL`. `DATABASE_URL` is the one an
 * ambient shell, a deploy environment or a direnv file is most likely to
 * already hold, and to hold pointed at production. Requiring SEED_DATABASE_URL
 * means seeding is something somebody typed on purpose. It falls back to
 * DATABASE_URL only so a local-only setup does not need two variables — and
 * the same host check applies either way, so the fallback cannot widen what is
 * reachable.
 *
 * WHAT COUNTS AS LOCAL. The hostname must be `localhost`, `127.0.0.1` or `::1`,
 * or the connection must be over a unix socket (`?host=/some/path`). That is
 * parsed with WHATWG `URL`, so the userinfo trick
 * `postgres://postgres@localhost@db.example.supabase.co/postgres` is read the
 * way Postgres reads it — hostname `db.example.supabase.co` — and refused.
 *
 * It never DROPs and never DELETEs. Every insert in the SQL is
 * `on conflict do nothing`, so a second run is a no-op rather than a reset.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEED_FILE = fileURLToPath(new URL("../supabase/seed/0002_dev_fixtures.sql", import.meta.url));

/** Hostnames that are this machine. Nothing else is ever seedable. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class NotLocalError extends Error {}

/**
 * Throw unless `raw` addresses a Postgres on this machine.
 *
 * Exported so tests/seed-dev.test.mjs can prove the refusal without needing a
 * production URL to point at — the check is a pure function of the string.
 */
export function assertLocalTarget(raw) {
  if (!raw || !String(raw).trim()) {
    throw new NotLocalError("SEED_DATABASE_URL is not set. Point it at a local scratch database.");
  }
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new NotLocalError("SEED_DATABASE_URL is not a URL. Expected postgres://…");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new NotLocalError(`refusing a non-Postgres URL scheme: ${url.protocol}`);
  }

  // A unix socket is by construction on this machine. libpq spells it two ways:
  // `postgres:///db?host=/tmp/sock` and `postgres://%2Ftmp%2Fsock/db`. A third
  // spelling — userinfo plus an empty host, `postgres://user@/db?host=/tmp/s` —
  // is not a valid URL at all and lands in the parse failure above, which is
  // the safe direction to be wrong in.
  const socket = url.searchParams.get("host") ?? (url.hostname.includes("%2F") ? decodeURIComponent(url.hostname) : null);
  if (socket) {
    if (!socket.startsWith("/")) {
      throw new NotLocalError(`refusing a non-absolute socket host: ${socket}`);
    }
    return { kind: "socket", host: socket };
  }

  // `url.hostname` is what Postgres will actually dial. Anything smuggled into
  // the userinfo half never reaches it, and must not fool the check either.
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new NotLocalError(
      `refusing to seed a non-local host: ${host}. ` +
        "These fixtures are synthetic and must never reach a shared or production database.",
    );
  }
  return { kind: "tcp", host };
}

function main() {
  const raw = process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL;
  let target;
  try {
    target = assertLocalTarget(raw);
  } catch (err) {
    if (!(err instanceof NotLocalError)) throw err;
    // The message names the host, never the URL — a URL carries a password.
    console.error(`seed-dev: ${err.message}`);
    process.exit(2);
  }
  if (!existsSync(SEED_FILE)) {
    console.error(`seed-dev: fixture file missing: ${SEED_FILE}`);
    process.exit(1);
  }

  execFileSync("psql", [raw, "-v", "ON_ERROR_STOP=1", "-q", "-f", SEED_FILE], { stdio: "inherit" });
  console.log(`seed-dev: fixtures applied to ${target.host}.`);
}

// Only when run, never when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
