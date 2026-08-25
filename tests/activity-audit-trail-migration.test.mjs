/**
 * activity-audit-trail-migration.test.mjs — 0010 against real Postgres.
 *
 * The claim under test is not "the app refuses to forge a row" — the app is
 * one caller of many and can be bypassed. It is that the DATABASE refuses:
 *
 *   1. No authenticated session, admin included, may insert an agent kind.
 *   2. No authenticated session may UPDATE or DELETE any row, so the trail is
 *      append-only and a service-role row cannot be edited from a browser.
 *   3. `actor_email` is stamped from the caller's own JWT, whatever the insert
 *      says — forging authorship is impossible rather than merely unattempted.
 *   4. service_role (the jobs) still writes agent kinds and keeps its own
 *      actor, because bypassing RLS is what makes those rows possible at all.
 *
 * Every assertion runs as a real role with real claims through the pg-cluster
 * harness. A mock would prove none of this.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";

const MIGRATIONS = [
  "0001_core_schema.sql", "0002_rls_policies.sql", "0003_project_manual.sql",
  "0004_profiles.sql", "0005_tasks.sql", "0006_seed_clients.sql",
  "0007_own_tasks_only.sql", "0008_agent_tokens.sql", "0009_automation_schema.sql",
  "0010_activity_audit_trail.sql",
];

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const AGENT_KINDS = ["ai_email_sent", "ai_email_reply", "agent_run"];

const admin = { email: "nate@bcn-services.com", app_metadata: { role: "admin" } };
const member = { email: "brandon@bcn-services.com", app_metadata: { role: "member" } };
/** The jobs' claims are irrelevant — service_role bypasses RLS. Present anyway. */
const jobs = { email: "agent@bcn-services.com", app_metadata: { role: "admin" } };

/**
 * A committed baseline. runClaims runs inside a transaction that is rolled back
 * at session end, so anything a role writes is gone by the next call — which is
 * exactly what an UPDATE/DELETE test needs: rows that are ALREADY there,
 * written by service_role, for an authenticated session to fail to touch.
 */
const seed = (pg) => {
  pg.run(`insert into accounts (id, business_name, city, status)
          values ('${ACCOUNT}','Audit Co','Rye','new')`);
  pg.run(`insert into account_activity (account_id, kind, note, actor_email) values
          ('${ACCOUNT}','agent_run','the job ran','agent@bcn-services.com'),
          ('${ACCOUNT}','call','a human call','brandon@bcn-services.com')`);
};

describe("0010: account_activity is append-only and self-attributing",
  { skip: !toolsPresent && "no local Postgres" }, () => {
  let pg;
  before(() => { pg = startClusterWithMigrations(MIGRATIONS); seed(pg); });
  after(() => pg?.stop());

  for (const kind of AGENT_KINDS) {
    test(`an ADMIN can no longer insert kind '${kind}'`, () => {
      // 0009 narrowed the staff INSERT policy, but 0002's admin FOR ALL policy
      // OR-unioned right past it. This is the hole 0010 closes.
      const r = pg.runClaims(admin,
        `insert into account_activity (account_id, kind) values ('${ACCOUNT}','${kind}')`);
      assert.equal(r.ok, false, `admin was still able to write ${kind}`);
      // Either gate may answer first — the trigger runs BEFORE the policy's
      // WITH CHECK, so on this path it is usually the trigger that speaks.
      assert.match(r.error, /row-level security|automation/i);
    });
  }

  test("RLS alone refuses an admin's agent kind, with the trigger out of the way", () => {
    // The trigger answering first would otherwise hide whether dropping
    // account_activity_admin_all actually did anything.
    pg.run(`alter table account_activity disable trigger account_activity_guard_insert`);
    try {
      const r = pg.runClaims(admin,
        `insert into account_activity (account_id, kind) values ('${ACCOUNT}','agent_run')`);
      assert.equal(r.ok, false, "the admin FOR ALL policy is still granting INSERT");
      assert.match(r.error, /row-level security/i);
    } finally {
      pg.run(`alter table account_activity enable trigger account_activity_guard_insert`);
    }
  });

  test("an admin can still insert a human kind", () => {
    const r = pg.runClaims(admin,
      `insert into account_activity (account_id, kind, note) values ('${ACCOUNT}','call','admin call'); select 1`);
    assert.equal(r.ok, true, r.error);
  });

  test("actor_email is stamped from the JWT, not from the insert", () => {
    // Read back inside the SAME transaction — runClaims rolls back on exit.
    const r = pg.runClaims(member,
      `insert into account_activity (account_id, kind, note, actor_email)
       values ('${ACCOUNT}','note','forged','nate@bcn-services.com');
       select actor_email from account_activity where note = 'forged'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(
      r.out, member.email,
      "a member named someone else as the author and the database kept it",
    );
  });

  test("a write that names nobody is still attributed", () => {
    // The three callers in app/leads/actions.ts pass no actor at all; before
    // 0010 every stage move and reassignment landed with actor_email NULL.
    const r = pg.runClaims(member,
      `insert into account_activity (account_id, kind, note) values ('${ACCOUNT}','status_change','moved to won');
       select actor_email from account_activity where note = 'moved to won'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, member.email);
  });

  test("service_role still writes agent kinds, keeping its own actor", () => {
    const r = pg.runClaims(jobs,
      `insert into account_activity (account_id, kind, note, actor_email)
       values ('${ACCOUNT}','agent_run','a second job run','agent@bcn-services.com');
       select actor_email from account_activity where note = 'a second job run'`,
      "service_role");
    assert.equal(r.ok, true, r.error);
    assert.equal(
      r.out, "agent@bcn-services.com",
      "the stamp must not apply to service_role — those rows carry the agent's actor",
    );
  });

  for (const [who, claims] of [["admin", admin], ["member", member]]) {
    test(`${who} cannot UPDATE any row, including the agent's`, () => {
      const r = pg.runClaims(claims,
        `with u as (update account_activity set note = 'rewritten', actor_email = 'someone@else.com'
                    returning 1) select count(*) from u`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0", `${who} rewrote ${r.out} audit rows`);
    });

    test(`${who} cannot DELETE any row`, () => {
      const r = pg.runClaims(claims,
        `with d as (delete from account_activity returning 1) select count(*) from d`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0", `${who} deleted ${r.out} audit rows`);
    });
  }

  test("the seeded rows, service_role's included, are untouched", () => {
    assert.equal(pg.run(`select count(*) from account_activity where note = 'rewritten'`), "0");
    assert.equal(
      pg.run(`select actor_email from account_activity where note = 'the job ran'`),
      "agent@bcn-services.com",
    );
    assert.equal(pg.run(`select count(*) from account_activity`), "2");
  });

  test("both roles can still READ the whole trail", () => {
    const total = pg.run(`select count(*) from account_activity`);
    for (const claims of [admin, member]) {
      assert.equal(pg.runClaims(claims, `select count(*) from account_activity`).out, total);
    }
  });

  test("the kind rule holds even where RLS is not the gate", () => {
    // RLS already refuses this, so the trigger's own rule would otherwise be
    // untested. A temporary permissive INSERT policy takes RLS out of the way
    // and leaves only the trigger standing.
    pg.run(`create policy tmp_open_insert on account_activity
            for insert to authenticated with check (true)`);
    try {
      const r = pg.runClaims(member,
        `insert into account_activity (account_id, kind) values ('${ACCOUNT}','agent_run')`);
      assert.equal(r.ok, false, "the trigger did not refuse an agent kind");
      assert.match(r.error, /automation/i);
    } finally {
      pg.run(`drop policy tmp_open_insert on account_activity`);
    }
  });
});

describe("0010 down: 0002's admin policy comes back exactly",
  { skip: !toolsPresent && "no local Postgres" }, () => {
  let pg;
  before(() => { pg = startClusterWithMigrations(MIGRATIONS); seed(pg); });
  after(() => pg?.stop());

  test("the down migration replays and restores admin FOR ALL", () => {
    pg.runFile("0010_activity_audit_trail.down.sql");
    assert.equal(
      pg.run(`select cmd from pg_policies
              where tablename='account_activity' and policyname='account_activity_admin_all'`),
      "ALL",
    );
    assert.equal(
      pg.run(`select count(*) from pg_trigger where tgname='account_activity_guard_insert'`),
      "0",
    );
    // The pre-0010 behavior, which is what "restores it exactly" means.
    const r = pg.runClaims(admin,
      `insert into account_activity (account_id, kind) values ('${ACCOUNT}','agent_run'); select 1`);
    assert.equal(r.ok, true, r.error);
  });
});
