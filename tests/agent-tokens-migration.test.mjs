/**
 * agent-tokens-migration.test.mjs — 0008 stores one Claude token per employee.
 *
 * The security property of this table is unusual and is the whole reason it
 * gets a test: RLS is ON and there are NO policies. That denies every read and
 * every write to `authenticated` — including the owner's own row — which is
 * the point, because a token is a bearer credential and the browser that
 * submitted it must not be able to read it back.
 *
 * "No policies" is a thing that gets added by accident later. A single
 * well-meaning `select own row` policy would hand every employee their own
 * token back over PostgREST, and nothing in the app would look different. So
 * the denials are asserted as denials, per role, per verb.
 *
 * Note what is NOT tested here: that the ciphertext is real encryption. That
 * lives in tests/agent-secrets.test.mjs, where it can be tested against the
 * actual cipher rather than through SQL.
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
  "0007_own_tasks_only.sql",
  "0008_agent_tokens.sql",
];

const NATE = "cccccccc-0000-4000-8000-000000000001";
const BRANDON = "cccccccc-0000-4000-8000-000000000002";

const admin = { sub: NATE, app_metadata: { role: "admin" }, email: "nate@bcn-services.com" };
const brandon = { sub: BRANDON, app_metadata: { role: "member" }, email: "brandon@bcn-services.com" };

describe("0008 agent_tokens", () => {
  let pg;
  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    pg.run(`insert into auth.users (id, email) values
      ('${NATE}','nate@bcn-services.com'), ('${BRANDON}','brandon@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values
      ('${NATE}','nate@bcn-services.com','Nate'),
      ('${BRANDON}','brandon@bcn-services.com','Brandon')`);
    // Seeded as the owner (superuser), which is what the service-role client
    // is to this table. No policy applies to that path, by design.
    pg.run(`insert into agent_tokens (profile_id, sealed, key_id, expires_at) values
      ('${BRANDON}', 'v1.aa.bb.cc', 'deadbeef', now() + interval '365 days')`);
  });
  after(() => pg?.stop());

  test("row level security is on", () => {
    assert.equal(
      pg.run(`select relrowsecurity from pg_class where relname='agent_tokens'`),
      "t",
    );
  });

  test("the table has no policies at all", () => {
    // The assertion that matters most, and the one a later "helpful" policy
    // would break. If this fails, read the header of 0008 before changing it.
    assert.equal(pg.run(`select count(*) from pg_policy where polrelid='agent_tokens'::regclass`), "0");
  });

  test("a member cannot read their OWN token", () => {
    const r = pg.runClaims(brandon, `select count(*) from agent_tokens`);
    assert.equal(r.ok, true, r.error);
    // RLS with no policy is a silent empty result, not an error — so counting
    // is the real check. Brandon's row exists; he simply cannot see it.
    assert.equal(r.out, "0");
  });

  test("an admin cannot read anyone's token either", () => {
    const r = pg.runClaims(admin, `select count(*) from agent_tokens`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "0");
  });

  test("a member cannot insert a token for themselves over the API", () => {
    const r = pg.runClaims(brandon,
      `insert into agent_tokens (profile_id, sealed, key_id, expires_at)
       values ('${BRANDON}','v1.x.y.z','deadbeef', now())`);
    assert.equal(r.ok, false);
    assert.match(r.error, /row-level security/i);
  });

  test("a member cannot insert a token for a colleague", () => {
    // The escalation this shape prevents: enrolling a credential that later
    // runs agents under someone else's name.
    const r = pg.runClaims(brandon,
      `insert into agent_tokens (profile_id, sealed, key_id, expires_at)
       values ('${NATE}','v1.x.y.z','deadbeef', now())`);
    assert.equal(r.ok, false);
    assert.match(r.error, /row-level security/i);
  });

  test("an admin cannot insert one either", () => {
    // Not an oversight: only the employee can produce a setup token, so an
    // admin-writable path would only ever be a way to plant one.
    const r = pg.runClaims(admin,
      `insert into agent_tokens (profile_id, sealed, key_id, expires_at)
       values ('${NATE}','v1.x.y.z','deadbeef', now())`);
    assert.equal(r.ok, false);
    assert.match(r.error, /row-level security/i);
  });

  test("a member cannot delete a token", () => {
    // Revoking goes through the server, which knows whose session it is. A
    // direct delete would be a way to switch off a colleague's scheduled jobs.
    const r = pg.runClaims(brandon, `delete from agent_tokens`);
    assert.equal(r.ok, true, r.error);
    assert.equal(pg.run(`select count(*) from agent_tokens`), "1");
  });

  test("one token per employee", () => {
    const r = pg.run(
      `select conname from pg_constraint
       where conrelid='agent_tokens'::regclass and contype='p'`);
    assert.equal(r, "agent_tokens_pkey");
  });

  test("deleting the auth user destroys the token with it", () => {
    // What makes offboarding a single action rather than a checklist.
    pg.run(`insert into auth.users (id, email) values
      ('cccccccc-0000-4000-8000-000000000003','gone@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values
      ('cccccccc-0000-4000-8000-000000000003','gone@bcn-services.com','Gone')`);
    pg.run(`insert into agent_tokens (profile_id, sealed, key_id, expires_at) values
      ('cccccccc-0000-4000-8000-000000000003','v1.a.b.c','deadbeef', now())`);
    pg.run(`delete from auth.users where id='cccccccc-0000-4000-8000-000000000003'`);
    assert.equal(
      pg.run(`select count(*) from agent_tokens where profile_id='cccccccc-0000-4000-8000-000000000003'`),
      "0",
    );
  });

  test("updated_at moves on write", () => {
    const out = pg.run(
      `update agent_tokens set sealed='v1.dd.ee.ff' where profile_id='${BRANDON}';
       select updated_at > created_at from agent_tokens where profile_id='${BRANDON}'`);
    assert.equal(out, "t");
  });
});
