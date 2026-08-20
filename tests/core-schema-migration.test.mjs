/**
 * core-schema-migration.test.mjs — 0001 applies to a vanilla database, its
 * constraints actually bite, and the down migration truly reverses it.
 *
 * "Keyless" is the property under test in the first block: 0001 must apply with
 * NO Supabase auth schema present, because the deploy pipeline replays every
 * migration from zero against a throwaway database that has not been through
 * Supabase provisioning.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startClusterWithMigrations, toolsPresent, seedFixture, IDS } from "./helpers/pg-cluster.mjs";

if (!toolsPresent) {
  test("SKIPPED: PG tooling absent at /opt/homebrew/bin", () => {
    assert.fail("initdb/pg_ctl/psql not found — install postgresql to run migration tests");
  });
}

describe("0001 core schema", () => {
  let pg;
  before(() => { pg = startClusterWithMigrations(["0001_core_schema.sql"], { emulateAuth: false }); });
  after(() => pg?.stop());

  test("applies to a vanilla PG database with no auth schema (keyless)", () => {
    const tables = pg.run(
      `select table_name from information_schema.tables
       where table_schema='public' order by table_name`).split("\n").filter(Boolean);
    assert.deepEqual(tables, ["account_activity", "accounts", "clients"]);
    // Proves it really was keyless: nothing created an auth schema.
    assert.equal(pg.run(`select count(*) from information_schema.schemata where schema_name='auth'`), "0");
  });

  test("RLS is enabled default-deny on every table from commit one", () => {
    const rows = pg.run(
      `select relname, relrowsecurity from pg_class
       where relname in ('accounts','clients','account_activity') order by relname`).split("\n");
    assert.deepEqual(rows, ["account_activity|t", "accounts|t", "clients|t"]);
    // Enabled but with zero policies = deny-all for non-service_role.
    assert.equal(pg.run(`select count(*) from pg_policies where schemaname='public'`), "0");
  });

  test("place_id is unique when present but permits many NULLs", () => {
    pg.run(`insert into accounts (business_name, place_id) values ('A','pid-1')`);
    const dup = pg.tryRun(`insert into accounts (business_name, place_id) values ('B','pid-1')`);
    assert.equal(dup.ok, false, "duplicate place_id must be rejected");
    assert.match(dup.error, /accounts_place_id_key/);
    // Two rows with no place_id must both be accepted — referral clients.
    pg.run(`insert into accounts (business_name) values ('No Places 1')`);
    pg.run(`insert into accounts (business_name) values ('No Places 2')`);
    assert.equal(pg.run(`select count(*) from accounts where place_id is null`), "2");
    pg.run(`delete from accounts`);
  });

  test("status is constrained to the 8 stages the leads skill uses", () => {
    const bad = pg.tryRun(`insert into accounts (business_name, status) values ('X','prospect')`);
    assert.equal(bad.ok, false, "an unknown status must be rejected, not silently stored");
    for (const s of ["new","attempted","reached","consult_scheduled","consult_done","won","lost","dead"]) {
      pg.run(`insert into accounts (business_name, status) values ('S-${s}','${s}')`);
    }
    assert.equal(pg.run(`select count(*) from accounts`), "8");
    pg.run(`delete from accounts`);
  });

  test("client slug must be lowercase kebab — a bad slug breaks deploys silently", () => {
    pg.run(`insert into accounts (id, business_name) values ('${IDS.acctWon}','Slug Co')`);
    for (const bad of ["Coventry", "cov_entry", "-cov", "cov-", "cov--entry", "cov entry"]) {
      const r = pg.tryRun(`insert into clients (account_id, slug) values ('${IDS.acctWon}','${bad}')`);
      assert.equal(r.ok, false, `slug '${bad}' must be rejected`);
    }
    pg.run(`insert into clients (account_id, slug) values ('${IDS.acctWon}','coventry-contracting')`);
    pg.run(`delete from clients; delete from accounts`);
  });

  test("one account can become at most one client", () => {
    pg.run(`insert into accounts (id, business_name) values ('${IDS.acctWon}','Once Only')`);
    pg.run(`insert into clients (account_id, slug) values ('${IDS.acctWon}','once-a')`);
    const second = pg.tryRun(`insert into clients (account_id, slug) values ('${IDS.acctWon}','once-b')`);
    assert.equal(second.ok, false, "a second client row for one account must be rejected");
    pg.run(`delete from clients; delete from accounts`);
  });

  test("an account with a client record cannot be deleted", () => {
    seedFixture(pg.run);
    const del = pg.tryRun(`delete from accounts where id='${IDS.acctWon}'`);
    assert.equal(del.ok, false, "on delete restrict must block orphaning a client");
    // ...but deleting an account DOES cascade its activity.
    pg.run(`insert into account_activity (account_id, kind) values ('${IDS.acctLead}','call')`);
    pg.run(`delete from accounts where id='${IDS.acctLead}'`);
    assert.equal(pg.run(`select count(*) from account_activity`), "0");
    pg.run(`delete from clients; delete from accounts`);
  });

  test("updated_at advances on UPDATE and created_at is immutable", () => {
    pg.run(`insert into accounts (id, business_name) values ('${IDS.acctLead}','Timestamps')`);
    const before = pg.run(`select created_at, updated_at from accounts where id='${IDS.acctLead}'`);
    pg.run(`update accounts set created_at='1999-01-01', business_name='Renamed' where id='${IDS.acctLead}'`);
    const after = pg.run(`select created_at, updated_at from accounts where id='${IDS.acctLead}'`);
    assert.equal(after.split("|")[0], before.split("|")[0], "created_at must not be rewritable");
    assert.notEqual(after.split("|")[1], before.split("|")[1], "updated_at must advance");
    pg.run(`delete from accounts`);
  });

  test("down migration reverses cleanly and up re-applies", () => {
    pg.runFile("0001_core_schema.down.sql");
    assert.equal(pg.run(
      `select count(*) from information_schema.tables where table_schema='public'`), "0");
    assert.equal(pg.run(
      `select count(*) from pg_proc where proname='set_updated_at'`), "0",
      "the trigger helper must be dropped too, or a re-apply hits 'already exists'");
    pg.runFile("0001_core_schema.sql");
    assert.equal(pg.run(
      `select count(*) from information_schema.tables where table_schema='public'`), "3");
  });
});
