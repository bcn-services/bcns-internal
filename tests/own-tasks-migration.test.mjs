/**
 * own-tasks-migration.test.mjs — 0007 narrows task UPDATE to your own work.
 *
 * This is the one place the "members change only their own tasks" rule is
 * actually enforced. The task board hides the controls, but hiding a form is
 * convenience: the real gate is the policy, and a policy is only as good as the
 * denial it produces. So every assertion here is a *write attempt* followed by
 * a read in the same transaction — never a read of the policy text.
 *
 * Both halves of the policy are exercised separately because they say different
 * things and each can be dropped without the other noticing:
 *   USING      — you may not touch a row assigned to someone else.
 *   WITH CHECK — you may not reassign a row that is assigned to you.
 * A test that only covered USING would pass with the WITH CHECK deleted, and a
 * member could hand their work to anyone.
 *
 * `sub` is set in the claims here and nowhere else in the suite, because this
 * is the first policy that compares against auth.uid() rather than only the
 * role. Without it auth.uid() is NULL, `assigned_to = auth.uid()` is NULL, and
 * every one of these tests would pass for the wrong reason — a denial by
 * accident rather than by rule.
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
];

const NATE = "bbbbbbbb-0000-4000-8000-000000000001";
const BRANDON = "bbbbbbbb-0000-4000-8000-000000000002";

const admin = { sub: NATE, app_metadata: { role: "admin" }, email: "nate@bcn-services.com" };
const brandon = { sub: BRANDON, app_metadata: { role: "member" }, email: "brandon@bcn-services.com" };

describe("0007 own-tasks-only update", () => {
  let pg;
  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    pg.run(`insert into auth.users (id, email) values
      ('${NATE}','nate@bcn-services.com'), ('${BRANDON}','brandon@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values
      ('${NATE}','nate@bcn-services.com','Nate'),
      ('${BRANDON}','brandon@bcn-services.com','Brandon')`);
    pg.run(`insert into tasks (title, assigned_to) values
      ('brandons work','${BRANDON}'), ('nates work','${NATE}'), ('nobodys work', null)`);
  });
  after(() => pg?.stop());

  test("the old blanket update policy is gone", () => {
    const out = pg.run(
      `select polname from pg_policy
       where polrelid = 'tasks'::regclass and polname like 'tasks_staff%update%'
       order by polname`);
    assert.equal(out, "tasks_staff_own_update");
  });

  test("a member still reads the whole board", () => {
    assert.equal(pg.runClaims(brandon, `select count(*) from tasks`).out, "3");
  });

  // runClaims wraps the query in a transaction discarded at disconnect, so a
  // write and the check on it must share ONE call. Reading afterwards with
  // pg.run() would always see the pre-write state and pass for the wrong reason.
  test("a member moves their own task along", () => {
    const r = pg.runClaims(brandon,
      `update tasks set status='doing' where title='brandons work';` +
      `select status from tasks where title='brandons work'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "doing");
  });

  test("a member may NOT change a colleague's task", () => {
    // No matching row under USING means Postgres updates nothing and reports
    // success, so the status is the real check — not the absence of an error.
    const r = pg.runClaims(brandon,
      `update tasks set status='done' where title='nates work';` +
      `select status from tasks where title='nates work'`);
    assert.equal(r.ok, true, "an unmatched row is zero rows affected, not an error");
    assert.equal(r.out, "todo", "a colleague's task must be untouched");
  });

  test("a member may NOT claim an unassigned task", () => {
    // Deliberate: an admin hands work out. A member picking work up on their
    // own is a different product decision and is not one that was made.
    const r = pg.runClaims(brandon,
      `update tasks set assigned_to='${BRANDON}' where title='nobodys work';` +
      `select coalesce(assigned_to::text,'null') from tasks where title='nobodys work'`);
    assert.equal(r.ok, true);
    assert.equal(r.out, "null");
  });

  test("a member may NOT hand their own task to someone else", () => {
    // This is the WITH CHECK half. USING passes here — the row IS theirs — and
    // only the post-image test stops the reassignment.
    const r = pg.runClaims(brandon,
      `update tasks set assigned_to='${NATE}' where title='brandons work';` +
      `select coalesce(assigned_to::text,'null') from tasks where title='brandons work'`);
    assert.equal(r.ok, false, "reassigning away from yourself must be refused outright");
    assert.match(r.error, /row-level security/i);
  });

  test("an admin still changes and reassigns anything", () => {
    const r = pg.runClaims(admin,
      `update tasks set status='done', assigned_to='${NATE}' where title='brandons work';` +
      `select status || '|' || assigned_to::text from tasks where title='brandons work'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, `done|${NATE}`);
  });

  test("a member still files new work, including for a colleague", () => {
    const r = pg.runClaims(brandon,
      `insert into tasks (title, assigned_to) values ('filed for nate','${NATE}');` +
      `select count(*) from tasks where title='filed for nate'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "1");
  });
});
