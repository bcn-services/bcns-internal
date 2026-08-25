/**
 * staff-tasks-migration.test.mjs — 0004 (profiles + lead ownership) and 0005
 * (tasks) apply, and their delete behaviour is what the schema comments claim.
 *
 * The delete rules are the reason this file exists. Three different ON DELETE
 * actions appear across these two migrations and each was chosen to protect
 * something specific:
 *
 *   profiles.id      -> auth.users   CASCADE   offboarding removes the profile
 *   accounts.assigned_to -> profiles SET NULL  losing staff must not lose leads
 *   tasks.assigned_to    -> profiles SET NULL  losing staff must not lose work
 *
 * A CASCADE written where SET NULL was meant destroys business records silently
 * and would only be discovered the first time someone left the company. That is
 * not a thing to find out in production, so every one is exercised here.
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
];

const ADMIN = { app_metadata: { role: "admin" }, email: "nate@bcn-services.com" };
const MEMBER = { app_metadata: { role: "member" }, email: "brandon@bcn-services.com" };
const NO_ROLE = { app_metadata: {}, email: "stranger@example.com" };

const NATE = "bbbbbbbb-0000-4000-8000-000000000001";
const BRANDON = "bbbbbbbb-0000-4000-8000-000000000002";

describe("0004 + 0005 staff directory and tasks", () => {
  let pg;
  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    pg.run(`insert into auth.users (id, email) values
      ('${NATE}','nate@bcn-services.com'), ('${BRANDON}','brandon@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values
      ('${NATE}','nate@bcn-services.com','Nate'),
      ('${BRANDON}','brandon@bcn-services.com','Brandon')`);
  });
  after(() => pg?.stop());

  test("creates both tables with RLS on", () => {
    const rows = pg.run(
      `select relname, relrowsecurity from pg_class
       where relname in ('profiles','tasks') order by relname`).split("\n");
    assert.deepEqual(rows, ["profiles|t", "tasks|t"]);
  });

  test("a profile cannot exist without a matching auth user", () => {
    const orphan = pg.tryRun(
      `insert into profiles (id, email, display_name)
       values ('bbbbbbbb-0000-4000-8000-00000000dead','ghost@x.com','Ghost')`);
    assert.equal(orphan.ok, false, "the FK to auth.users must reject an unbacked profile");
  });

  test("profiles does NOT carry a role column", () => {
    // A role here would be a second source of truth, editable over the API,
    // while the gate reads app_metadata from the JWT. Assert its absence so a
    // later 'convenience' column has to argue with a failing test first.
    const cols = pg.run(
      `select column_name from information_schema.columns
       where table_name='profiles' and column_name='role'`);
    assert.equal(cols, "", "role belongs in app_metadata, never in a writable table");
  });

  test("email is unique across the directory", () => {
    pg.run(`insert into auth.users (id, email)
            values ('bbbbbbbb-0000-4000-8000-000000000003', 'dup@x.com')`);
    const dup = pg.tryRun(
      `insert into profiles (id, email, display_name)
       values ('bbbbbbbb-0000-4000-8000-000000000003','nate@bcn-services.com','Impostor')`);
    assert.equal(dup.ok, false, "two profiles must not share an email");
  });

  test("a task requires a non-blank title", () => {
    const blank = pg.tryRun(`insert into tasks (title) values ('   ')`);
    assert.equal(blank.ok, false, "whitespace is not a title");
  });

  test("a task rejects an unknown status and defaults to todo", () => {
    const bad = pg.tryRun(`insert into tasks (title, status) values ('x','in-progress')`);
    assert.equal(bad.ok, false, "status is CHECK-constrained to the four known stages");
    pg.run(`insert into tasks (id, title) values ('cccccccc-0000-4000-8000-000000000001','untouched')`);
    assert.equal(
      pg.run(`select status from tasks where id='cccccccc-0000-4000-8000-000000000001'`), "todo");
    pg.run(`delete from tasks`);
  });

  test("a task may belong to no business at all", () => {
    // Internal work ("configure SMTP") has no account. A NOT NULL here would
    // force a fake account row for every chore.
    pg.run(`insert into tasks (title, account_id) values ('configure SMTP', null)`);
    assert.equal(pg.run(`select count(*) from tasks where account_id is null`), "1");
    pg.run(`delete from tasks`);
  });

  describe("delete behaviour", () => {
    const ACCT = "dddddddd-0000-4000-8000-000000000001";
    const TASK = "cccccccc-0000-4000-8000-000000000009";

    before(() => {
      pg.run(`insert into accounts (id, business_name, assigned_to)
              values ('${ACCT}','Test Business','${BRANDON}')`);
      pg.run(`insert into tasks (id, title, account_id, assigned_to, created_by)
              values ('${TASK}','call them','${ACCT}','${BRANDON}','${NATE}')`);
    });

    test("offboarding a person keeps their leads and their tasks", () => {
      pg.run(`delete from auth.users where id='${BRANDON}'`);
      // The profile goes (cascade), but nothing owned by it may go with it.
      assert.equal(pg.run(`select count(*) from profiles where id='${BRANDON}'`), "0");
      assert.equal(
        pg.run(`select count(*) from accounts where id='${ACCT}'`), "1",
        "deleting an employee must never delete the business they worked");
      assert.equal(
        pg.run(`select assigned_to from accounts where id='${ACCT}'`), "",
        "the lead must return to unassigned, not vanish");
      assert.equal(
        pg.run(`select count(*) from tasks where id='${TASK}'`), "1",
        "deleting an employee must never delete the work");
      assert.equal(pg.run(`select assigned_to from tasks where id='${TASK}'`), "");
    });

    test("deleting a business takes its tasks with it", () => {
      // Opposite choice from the one above, and deliberate: a task for a
      // business that no longer exists is unactionable noise, not a record.
      pg.run(`delete from accounts where id='${ACCT}'`);
      assert.equal(pg.run(`select count(*) from tasks where id='${TASK}'`), "0");
    });
  });

  describe("RLS", () => {
    const ACCT2 = "dddddddd-0000-4000-8000-000000000002";
    before(() => {
      pg.run(`insert into accounts (id, business_name) values ('${ACCT2}','Visible Co')`);
      pg.run(`insert into tasks (title, account_id, assigned_to)
              values ('nate task','${ACCT2}','${NATE}')`);
    });

    test("an unprovisioned user sees no staff and no work", () => {
      assert.equal(pg.runClaims(NO_ROLE, `select count(*) from profiles`).out, "0");
      assert.equal(pg.runClaims(NO_ROLE, `select count(*) from tasks`).out, "0");
    });

    test("a member reads the directory and every task", () => {
      assert.equal(pg.runClaims(MEMBER, `select count(*) from profiles`).out, "1");
      assert.equal(pg.runClaims(MEMBER, `select count(*) from tasks`).out, "1");
    });

    // runClaims wraps the query in a transaction that is rolled back when psql
    // disconnects, so a write and the check on it must share ONE call. Reading
    // afterwards with pg.run() would always see the pre-write state and quietly
    // pass for the wrong reason.
    test("a member may create and reassign work", () => {
      const r = pg.runClaims(MEMBER,
        `insert into tasks (title, assigned_to) values ('member made this','${NATE}');` +
        `update tasks set status='doing' where title='member made this';` +
        `select status from tasks where title='member made this'`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "doing");
    });

    test("a member may NOT delete a task", () => {
      // Cancelling keeps the record; deleting destroys it. Only admin deletes.
      // No member DELETE policy means the row simply does not match — Postgres
      // reports success having removed nothing, so the count is the real check.
      const r = pg.runClaims(MEMBER,
        `delete from tasks where title='nate task';` +
        `select count(*) from tasks where title='nate task'`);
      assert.equal(r.ok, true, "no matching policy means zero rows affected, not an error");
      assert.equal(r.out, "1", "the row must survive a member's delete attempt");
    });

    test("a member may NOT edit the staff directory", () => {
      const r = pg.runClaims(MEMBER,
        `update profiles set display_name='Hacked' where id='${NATE}';` +
        `select display_name from profiles where id='${NATE}'`);
      assert.equal(r.ok, true);
      assert.equal(r.out, "Nate", "only an admin edits the staff directory");
    });

    test("an admin may delete a task", () => {
      const r = pg.runClaims(ADMIN,
        `delete from tasks where title='nate task';` +
        `select count(*) from tasks where title='nate task'`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0");
    });
  });
});
