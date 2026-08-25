/**
 * seed-clients-migration.test.mjs — 0006 puts the real client roster in, and
 * putting it in twice changes nothing.
 *
 * Idempotency is the whole point of this file. `accounts.business_name` carries
 * no unique constraint, so the obvious `on conflict do nothing` is a no-op there
 * — Postgres finds no conflict to skip and cheerfully inserts a second full set.
 * That failure is invisible in a fresh database and only appears the second time
 * anyone applies the migration, which is exactly when nobody is watching.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";

if (!toolsPresent) {
  test("SKIPPED: PG tooling absent at /opt/homebrew/bin", () => {
    assert.fail("initdb/pg_ctl/psql not found — install postgresql to run migration tests");
  });
}

const MIGRATIONS = [
  "0001_core_schema.sql",
  "0002_rls_policies.sql",
  "0003_project_manual.sql",
  "0004_profiles.sql",
  "0005_tasks.sql",
  "0006_seed_clients.sql",
];

describe("0006 client roster seed", () => {
  let pg;
  before(() => { pg = startClusterWithMigrations(MIGRATIONS); });
  after(() => pg?.stop());

  test("seeds five clients, each backed by an account", () => {
    assert.equal(pg.run(`select count(*) from clients`), "5");
    assert.equal(
      pg.run(`select count(*) from clients c join accounts a on a.id = c.account_id`), "5",
      "every client must resolve to its account row");
  });

  test("slugs match the ones used across the rest of the system", () => {
    // These are not decorative. The slug is the pitch folder, the client folder,
    // the repo suffix, the CI CLIENT_SLUG var, and the droplet Unix user, so a
    // drifted slug here silently misroutes real infrastructure.
    assert.equal(
      pg.run(`select string_agg(slug, ',' order by slug) from clients`),
      "coventry,delucas,l2detailz,technology-associates,wwc");
  });

  test("only the rate that is actually written down is recorded", () => {
    // Coventry's $100/mo founding rate is documented; the others are not. A
    // guessed figure in the system of record is worse than a blank.
    assert.equal(
      pg.run(`select monthly_rate_cents from clients where slug='coventry'`), "10000");
    assert.equal(
      pg.run(`select count(*) from clients where monthly_rate_cents is null`), "4",
      "NULL means 'not recorded yet', and must not be filled with a guess");
  });

  test("an unlaunched client is onboarding, not active", () => {
    assert.equal(pg.run(`select status from clients where slug='l2detailz'`), "active");
    assert.equal(pg.run(`select status from clients where slug='coventry'`), "onboarding");
  });

  test("the seeded businesses are won accounts with no place_id", () => {
    // None came from Google Places. The partial unique index on place_id must
    // permit all five NULLs — a plain unique index would reject the second one.
    assert.equal(
      pg.run(`select count(*) from accounts where place_id is null and status='won'`), "5");
  });

  test("applying it a second time inserts nothing", () => {
    const before = pg.run(`select count(*) || '/' || (select count(*) from clients) from accounts`);
    pg.runFile("0006_seed_clients.sql");
    const after = pg.run(`select count(*) || '/' || (select count(*) from clients) from accounts`);
    assert.equal(after, before, "the seed must be safe to re-apply");
  });
});
