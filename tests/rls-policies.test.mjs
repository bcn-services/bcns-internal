/**
 * rls-policies.test.mjs — the authorization boundary, exercised against a real
 * Postgres as the `authenticated` role with real JWT claims.
 *
 * What matters here is not that the policies exist but that they DENY. Every
 * test that asserts a member cannot do something is the actual product
 * requirement: Brandon reads everything and works leads, and only Nate changes
 * what a client pays or deletes a record.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startClusterWithMigrations, toolsPresent, seedFixture, IDS, CLAIMS }
  from "./helpers/pg-cluster.mjs";

if (!toolsPresent) {
  test("SKIPPED: PG tooling absent at /opt/homebrew/bin", () => {
    assert.fail("initdb/pg_ctl/psql not found — install postgresql to run RLS tests");
  });
}

describe("RLS: admin vs member vs unprovisioned", () => {
  let pg;
  before(() => { pg = startClusterWithMigrations(); seedFixture(pg.run); });
  after(() => pg?.stop());

  test("admin reads every table", () => {
    for (const t of ["accounts", "clients", "account_activity"]) {
      const r = pg.runClaims(CLAIMS.admin, `select count(*) from ${t}`);
      assert.equal(r.ok, true, r.error);
    }
    assert.equal(pg.runClaims(CLAIMS.admin, `select count(*) from accounts`).out, "2");
    assert.equal(pg.runClaims(CLAIMS.admin, `select count(*) from clients`).out, "1");
  });

  test("member reads accounts and clients", () => {
    assert.equal(pg.runClaims(CLAIMS.member, `select count(*) from accounts`).out, "2");
    assert.equal(pg.runClaims(CLAIMS.member, `select count(*) from clients`).out, "1");
  });

  test("member sees deal value and monthly rate — deliberately not hidden", () => {
    const r = pg.runClaims(CLAIMS.member,
      `select monthly_rate_cents from clients where id='${IDS.client}'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "15000");
  });

  test("member can add a lead and log activity", () => {
    const ins = pg.runClaims(CLAIMS.member,
      `insert into accounts (business_name, city) values ('Member Added','Rye'); select 1`);
    assert.equal(ins.ok, true, ins.error);
    const act = pg.runClaims(CLAIMS.member,
      `insert into account_activity (account_id, kind, outcome)
       values ('${IDS.acctLead}','call','no answer'); select 1`);
    assert.equal(act.ok, true, act.error);
  });

  test("member can advance a lead's status", () => {
    const r = pg.runClaims(CLAIMS.member,
      `update accounts set status='attempted' where id='${IDS.acctLead}'; select 1`);
    assert.equal(r.ok, true, r.error);
  });

  // ---- the denials: these are the actual requirement ----

  test("member CANNOT change what a client pays", () => {
    const r = pg.runClaims(CLAIMS.member,
      `update clients set monthly_rate_cents=1 where id='${IDS.client}'`);
    // No member UPDATE policy on clients: the row is invisible to the write, so
    // this is either a hard policy error or an affected-row count of zero.
    const stillCorrect = pg.run(`select monthly_rate_cents from clients where id='${IDS.client}'`);
    assert.equal(stillCorrect, "15000", "a member write to clients must not land");
  });

  test("member CANNOT create a client record", () => {
    const r = pg.runClaims(CLAIMS.member,
      `insert into clients (account_id, slug) values ('${IDS.acctLead}','sneaky'); select 1`);
    assert.equal(r.ok, false, "member insert on clients must be refused");
    assert.match(r.error, /row-level security/i);
  });

  test("member CANNOT delete anything", () => {
    const beforeCount = pg.run(`select count(*) from accounts`);
    pg.runClaims(CLAIMS.member, `delete from accounts where id='${IDS.acctLead}'`);
    pg.runClaims(CLAIMS.member, `delete from clients where id='${IDS.client}'`);
    assert.equal(pg.run(`select count(*) from accounts`), beforeCount, "member delete must not land");
    assert.equal(pg.run(`select count(*) from clients`), "1");
  });

  test("an invited user with NO role sees nothing (fail-safe, not fail-open)", () => {
    assert.equal(pg.runClaims(CLAIMS.noRole, `select count(*) from accounts`).out, "0");
    assert.equal(pg.runClaims(CLAIMS.noRole, `select count(*) from clients`).out, "0");
    const w = pg.runClaims(CLAIMS.noRole, `insert into accounts (business_name) values ('X'); select 1`);
    assert.equal(w.ok, false, "an unprovisioned user must not be able to write");
  });

  test("a role claim in user_metadata is IGNORED — only app_metadata counts", () => {
    // user_metadata is user-writable via the client SDK. Honoring it would let
    // any invited member promote themselves to admin.
    assert.equal(pg.runClaims(CLAIMS.fake, `select count(*) from accounts`).out, "0");
    const w = pg.runClaims(CLAIMS.fake, `delete from clients where id='${IDS.client}'`);
    assert.equal(pg.run(`select count(*) from clients`), "1", "a forged role must grant nothing");
  });

  test("helper functions are search_path-pinned and STABLE", () => {
    const rows = pg.run(
      `select proname, provolatile, coalesce(array_to_string(proconfig,','),'NONE')
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='auth' and proname in ('is_admin','is_staff','role_claim')
       order by proname`).split("\n");
    assert.equal(rows.length, 3);
    for (const r of rows) {
      const [, volatility, config] = r.split("|");
      assert.equal(volatility, "s", `${r}: must be STABLE`);
      assert.match(config, /search_path=/, `${r}: must pin search_path`);
    }
  });

  test("down migration removes every policy and helper", () => {
    pg.runFile("0002_rls_policies.down.sql");
    assert.equal(pg.run(`select count(*) from pg_policies where schemaname='public'`), "0");
    assert.equal(pg.run(
      `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='auth' and proname in ('is_admin','is_staff','role_claim')`), "0");
    // With policies gone, RLS is still ON: back to deny-all for authenticated.
    assert.equal(pg.runClaims(CLAIMS.admin, `select count(*) from accounts`).out, "0");
    pg.runFile("0002_rls_policies.sql");
    assert.equal(pg.runClaims(CLAIMS.admin, `select count(*) from accounts`).ok, true);
  });
});
