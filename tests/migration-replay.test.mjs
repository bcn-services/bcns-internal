/**
 * migration-replay.test.mjs — every migration on disk replays, in order, on a
 * fresh cluster.
 *
 * The per-migration tests each apply a hand-listed subset. None of them proves
 * the whole directory still applies end to end, which is what a real deploy
 * does. This one discovers the files rather than listing them, so a migration
 * added later is covered the moment it lands.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";

const migrationsDir = fileURLToPath(new URL("../supabase/migrations", import.meta.url));

/** Every up-migration on disk, in filename order. Excludes `.down.sql`. */
export function upMigrations() {
  return readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith(".down.sql"))
    .sort();
}

describe("migration replay — the whole directory, end to end", { skip: !toolsPresent && "no local Postgres" }, () => {
  test("every migration on disk applies in order on a fresh database", () => {
    const files = upMigrations();
    assert.ok(files.length >= 8, `expected at least 8 migrations, found ${files.length}`);

    const h = startClusterWithMigrations(files);
    try {
      const tables = h.run(
        "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'",
      );
      // A replay that silently applied nothing would still exit 0; assert the
      // schema it was supposed to build actually exists.
      for (const t of ["accounts", "clients", "account_activity", "profiles", "tasks", "agent_tokens"]) {
        assert.ok(tables.split(",").includes(t), `${t} missing after replay; got ${tables}`);
      }
    } finally {
      h.stop();
    }
  });

  test("a broken migration fails the replay and names the offending file", () => {
    // The bad file lives in a temp dir, never in `migrationsDir`. Writing it into
    // the real migrations directory raced every other suite that boots a cluster:
    // they glob that directory, so whichever one started while this test held the
    // file applied it and died. Passing the path explicitly keeps it private here.
    const badDir = mkdtempSync(join(tmpdir(), "bcns-badmig-"));
    const bad = join(badDir, "9999_deliberately_broken.sql");
    writeFileSync(bad, "this is not valid sql;\n");
    let err;
    let h;
    try {
      h = startClusterWithMigrations([...upMigrations(), bad]);
    } catch (e) {
      err = e;
    } finally {
      if (h) h.stop();
      unlinkSync(bad);
    }
    assert.ok(err, "a syntactically invalid migration must fail the replay, not pass silently");
    const detail = String(err.stderr ?? err.message ?? err);
    assert.match(detail, /9999_deliberately_broken/, `failure must name the file; got: ${detail.slice(0, 400)}`);
  });
});
