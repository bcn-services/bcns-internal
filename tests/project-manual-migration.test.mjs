/**
 * project-manual-migration.test.mjs — 0003 applies, its constraints bite, and
 * its RLS actually separates a member from someone else's note.
 *
 * The last block is the one that matters most: `project_notes_own_delete`
 * compares author_email against the JWT email claim, and a policy that compared
 * it against anything the form supplies would let one member delete another's
 * note. There is no way to see that from reading the SQL, so it is tested with
 * two different signed identities.
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
];

// The shared CLAIMS fixture carries no email, and the own-note delete policy is
// entirely about the email claim, so these are defined here.
const ADMIN = { app_metadata: { role: "admin" }, email: "nate@bcn-services.com" };
const ALICE = { app_metadata: { role: "member" }, email: "alice@bcn-services.com" };
const BOB = { app_metadata: { role: "member" }, email: "bob@bcn-services.com" };
const NO_ROLE = { app_metadata: {}, email: "stranger@example.com" };

describe("0003 project manual layer", () => {
  let pg;
  before(() => { pg = startClusterWithMigrations(MIGRATIONS); });
  after(() => pg?.stop());

  test("creates the three tables with RLS on", () => {
    const rows = pg.run(
      `select relname, relrowsecurity from pg_class
       where relname in ('project_overrides','project_settings','project_notes')
       order by relname`).split("\n");
    assert.deepEqual(rows, [
      "project_notes|t", "project_overrides|t", "project_settings|t",
    ]);
  });

  test("only the seven allowed fields may be overridden", () => {
    for (const f of ["name", "summary", "status", "priority", "next_step", "repo", "github"]) {
      pg.run(`insert into project_overrides (project_id, field, value) values ('p1','${f}','v')`);
    }
    // The Astro version enforced this list in the API handler only, so a second
    // writer could put anything in the file. Here the database refuses.
    const bad = pg.tryRun(
      `insert into project_overrides (project_id, field, value) values ('p1','deal_value','999')`);
    assert.equal(bad.ok, false, "an unknown field must be rejected, not stored");
    pg.run(`delete from project_overrides`);
  });

  test("one override row per project and field", () => {
    pg.run(`insert into project_overrides (project_id, field, value) values ('p1','name','A')`);
    const dup = pg.tryRun(
      `insert into project_overrides (project_id, field, value) values ('p1','name','B')`);
    assert.equal(dup.ok, false, "the primary key must reject a second row for the same field");
    // The upsert the data layer uses must still be able to change the value.
    pg.run(`insert into project_overrides (project_id, field, value) values ('p1','name','B')
            on conflict (project_id, field) do update set value = excluded.value`);
    assert.equal(pg.run(`select value from project_overrides where project_id='p1'`), "B");
    pg.run(`delete from project_overrides`);
  });

  test("a due date must be a real date, and the hide flags default to false", () => {
    const bad = pg.tryRun(`insert into project_settings (project_id, due_date) values ('p1','not-a-date')`);
    assert.equal(bad.ok, false, "a malformed date must be rejected by the column type");
    pg.run(`insert into project_settings (project_id, due_date) values ('p1','2026-09-01')`);
    assert.equal(
      pg.run(`select due_date, hide_due_date, hide_priority from project_settings where project_id='p1'`),
      "2026-09-01|f|f");
    // Clearing a due date must NOT remove the row, or the hide flags go with it.
    pg.run(`update project_settings set due_date = null where project_id='p1'`);
    assert.equal(pg.run(`select count(*) from project_settings where project_id='p1'`), "1");
    pg.run(`delete from project_settings`);
  });

  test("a note is capped at 2000 characters and may be unsorted", () => {
    const tooLong = pg.tryRun(
      `insert into project_notes (body) values (repeat('x', 2001))`);
    assert.equal(tooLong.ok, false, "the length cap must live in the schema, not only in a handler");
    const empty = pg.tryRun(`insert into project_notes (body) values ('')`);
    assert.equal(empty.ok, false, "an empty note is not a note");
    // NULL project_id is the unsorted pile and must be permitted.
    pg.run(`insert into project_notes (body, project_id) values ('unsorted thought', null)`);
    assert.equal(pg.run(`select count(*) from project_notes where project_id is null`), "1");
    pg.run(`delete from project_notes`);
  });

  describe("RLS", () => {
    before(() => {
      pg.run(`insert into project_overrides (project_id, field, value) values ('p1','name','Renamed')`);
      pg.run(`insert into project_settings (project_id, due_date) values ('p1','2026-09-01')`);
      pg.run(`insert into project_notes (id, body, author_email)
              values ('aaaaaaaa-0000-4000-8000-000000000001','alice note','alice@bcn-services.com')`);
      pg.run(`insert into project_notes (id, body, author_email)
              values ('aaaaaaaa-0000-4000-8000-000000000002','bob note','bob@bcn-services.com')`);
      pg.run(`insert into project_notes (id, body, author_email)
              values ('aaaaaaaa-0000-4000-8000-000000000003','imported note', null)`);
    });

    test("an unprovisioned user sees nothing at all", () => {
      for (const t of ["project_overrides", "project_settings", "project_notes"]) {
        assert.equal(pg.runClaims(NO_ROLE, `select count(*) from ${t}`).out, "0", t);
      }
    });

    test("a member reads all three tables", () => {
      assert.equal(pg.runClaims(ALICE, `select count(*) from project_overrides`).out, "1");
      assert.equal(pg.runClaims(ALICE, `select count(*) from project_settings`).out, "1");
      assert.equal(pg.runClaims(ALICE, `select count(*) from project_notes`).out, "3");
    });

    test("a member may clear an override — it is display state, not a record", () => {
      const r = pg.runClaims(ALICE,
        `delete from project_overrides where project_id='p1' and field='name'; ` +
        `select count(*) from project_overrides`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0");
      // The transaction is rolled back at disconnect, so the row is still there.
      assert.equal(pg.run(`select count(*) from project_overrides`), "1");
    });

    test("a member deletes their OWN note", () => {
      const r = pg.runClaims(ALICE,
        `delete from project_notes where id='aaaaaaaa-0000-4000-8000-000000000001'; ` +
        `select count(*) from project_notes`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "2", "alice's own note must be deletable");
    });

    test("a member may NOT delete someone else's note", () => {
      // RLS filters rather than errors, so the delete succeeds with zero rows
      // affected. The count is the assertion, not the exit status.
      const r = pg.runClaims(ALICE,
        `delete from project_notes where id='aaaaaaaa-0000-4000-8000-000000000002'; ` +
        `select count(*) from project_notes`);
      assert.equal(r.out, "3", "bob's note must survive alice's delete");
    });

    test("a member may not delete an authorless note", () => {
      const r = pg.runClaims(BOB,
        `delete from project_notes where author_email is null; ` +
        `select count(*) from project_notes`);
      assert.equal(r.out, "3", "a service-role import belongs to nobody and is admin-only");
    });

    test("an admin deletes any note", () => {
      const r = pg.runClaims(ADMIN,
        `delete from project_notes; select count(*) from project_notes`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0");
    });

    test("a member files a note to a project", () => {
      const r = pg.runClaims(ALICE,
        `update project_notes set project_id='p2' ` +
        `where id='aaaaaaaa-0000-4000-8000-000000000003'; ` +
        `select project_id from project_notes where id='aaaaaaaa-0000-4000-8000-000000000003'`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "p2");
    });
  });

  test("down migration removes all three tables and leaves 0002 intact", () => {
    pg.runFile("0003_project_manual.down.sql");
    assert.equal(pg.run(
      `select count(*) from information_schema.tables where table_schema='public'
       and table_name in ('project_overrides','project_settings','project_notes')`), "0");
    // 0002's helpers and policies must be untouched — 0003 created none of them.
    assert.equal(pg.run(
      `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and proname in ('is_admin','is_staff','role_claim')`), "3");
    pg.runFile("0003_project_manual.sql");
  });
});
