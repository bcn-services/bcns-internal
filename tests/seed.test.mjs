/**
 * seed.test.mjs — the development seed applies to a real database, twice.
 *
 * Proves the seed is re-runnable (a second apply changes nothing) and that
 * every row it writes satisfies the schema's own rules — the slug shape, the
 * status vocabulary, and one client per account. A seed that only "looks
 * right" is worthless; this one is executed.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";

if (!toolsPresent) {
  test("SKIPPED: PG tooling absent at /opt/homebrew/bin", () => {
    assert.fail("initdb/pg_ctl/psql not found — install postgresql to run seed tests");
  });
}

const SEED = readFileSync(new URL("../supabase/seed/0001_real_clients.sql", import.meta.url), "utf8");

describe("development seed", () => {
  let pg;
  before(() => { pg = startClusterWithMigrations(["0001_core_schema.sql"], { emulateAuth: false }); });
  after(() => pg?.stop());

  test("applies to the real schema, and a second apply changes nothing", () => {
    pg.run(SEED);
    assert.equal(pg.run("select count(*) from clients"), "5");
    pg.run(SEED);
    assert.equal(pg.run("select count(*) from clients"), "5");
    assert.equal(pg.run("select count(*) from accounts"), "5");
  });

  test("every seeded client is a won account with a repo-shaped slug", () => {
    const rows = pg.run(
      `select c.slug || '|' || a.status from clients c
       join accounts a on a.id = c.account_id order by c.slug`
    ).split("\n").filter(Boolean).map((l) => l.split("|"));
    assert.deepEqual(rows.map((r) => r[0]),
      ["coventry", "delucas", "l2detailz", "technology-associates", "wwc"]);
    assert.ok(rows.every((r) => r[1] === "won"), "a seeded client must be a won account");
  });

  test("the seed writes no invented money or contact history", () => {
    // Placeholder revenue would read as fact on the client page. Refuse it.
    assert.equal(pg.run("select count(*) from accounts where deal_value_cents is not null"), "0");
    assert.equal(pg.run("select count(*) from account_activity"), "0");
    assert.equal(pg.run("select coalesce(sum(call_count),0) from accounts"), "0");
  });
});
