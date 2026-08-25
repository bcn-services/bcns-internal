/**
 * email-outbox-migration.test.mjs — 0012 gives an undelivered email somewhere
 * durable to live.
 *
 * Three properties carry this migration:
 *
 *   1. It is a QUEUE, not a log. `status` is constrained to the three states a
 *      retry can act on, and it defaults to `pending` — the state a payload is
 *      in when there is no provider, which today is every payload.
 *   2. It is not user-writable. Only an admin has a policy, and in practice the
 *      writer is service_role; a member can neither read nor plant a row.
 *   3. Offboarding does not destroy the record. The profile FK is
 *      `on delete set null`, so the row survives with its address intact.
 *
 * Real Postgres, throwaway cluster, no production database.
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
  "0009_automation_schema.sql",
  "0010_activity_audit_trail.sql",
  "0011_inbox_unread_index.sql",
  "0012_email_outbox.sql",
];

const NATE = "ffffffff-0000-4000-8000-000000000001";
const BRANDON = "ffffffff-0000-4000-8000-000000000002";

const admin = { sub: NATE, app_metadata: { role: "admin" }, email: "nate@bcn-services.com" };
const member = { sub: BRANDON, app_metadata: { role: "member" }, email: "brandon@bcn-services.com" };

const insert = (profile, status = "pending") =>
  `insert into email_outbox (kind, to_email, subject, body, to_profile_id, status)
   values ('job_run_failed', 'nseluga@g.hmc.edu', 's', 'b', ${profile ? `'${profile}'` : "null"}, '${status}')`;

describe("0012 email_outbox", { skip: !toolsPresent && "no local Postgres" }, () => {
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

  test("the table exists with every column the routing layer writes", () => {
    const cols = pg.run(
      `select string_agg(column_name, ',' order by column_name)
         from information_schema.columns
        where table_schema = 'public' and table_name = 'email_outbox'`,
    ).split(",");
    for (const c of [
      "id", "kind", "to_email", "subject", "body", "to_profile_id",
      "source_job", "status", "error", "attempts", "created_at", "sent_at",
    ]) {
      assert.ok(cols.includes(c), `email_outbox.${c} missing; got ${cols.join(",")}`);
    }
  });

  test("an undelivered payload is what the table defaults to", () => {
    pg.run(`insert into email_outbox (kind, to_email, subject, body)
            values ('job_run_failed','nseluga@g.hmc.edu','s','b')`);
    const row = pg.run(
      `select status || '|' || attempts || '|' || coalesce(sent_at::text,'-')
         from email_outbox order by created_at desc limit 1`,
    );
    assert.equal(row, "pending|0|-", "a fresh row must read as owed, tried zero times, unsent");
  });

  test("status is constrained to the three a retry can act on", () => {
    for (const s of ["pending", "sent", "failed"]) {
      assert.ok(pg.tryRun(insert(NATE, s)).ok, `${s} must be allowed`);
    }
    assert.equal(pg.tryRun(insert(NATE, "queued")).ok, false, "an unknown status must be rejected");
  });

  test("the payload itself is NOT NULL — a record with no body records nothing", () => {
    for (const col of ["kind", "to_email", "subject", "body"]) {
      const cols = ["kind", "to_email", "subject", "body"];
      const vals = cols.map((c) => (c === col ? "null" : "'x'")).join(", ");
      const res = pg.tryRun(`insert into email_outbox (${cols.join(", ")}) values (${vals})`);
      assert.equal(res.ok, false, `${col} must be NOT NULL`);
    }
  });

  test("offboarding a person keeps the record of what was mailed to them", () => {
    pg.run(`insert into email_outbox (id, kind, to_email, subject, body, to_profile_id)
            values ('ffffffff-0000-4000-8000-0000000000e1','task_assigned','b@x','s','b','${BRANDON}')`);
    pg.run(`delete from profiles where id = '${BRANDON}'`);
    const row = pg.run(
      `select to_email || '|' || coalesce(to_profile_id::text,'-')
         from email_outbox where id = 'ffffffff-0000-4000-8000-0000000000e1'`,
    );
    assert.equal(row, "b@x|-", "the row must survive with its address, minus the dead profile id");
    pg.run(`insert into profiles (id, email, display_name)
            values ('${BRANDON}','brandon@bcn-services.com','Brandon')`);
  });

  test("the pending queue has its own partial index — the retry read stays cheap", () => {
    const def = pg.run(
      `select indexdef from pg_indexes
        where schemaname='public' and indexname='email_outbox_pending_idx'`,
    );
    assert.match(def, /where \(status = 'pending'::text\)/i, "the queue index must be partial");
  });

  test("the FK column is indexed, so a profile delete does not scan the table", () => {
    const def = pg.run(
      `select indexdef from pg_indexes
        where schemaname='public' and indexname='email_outbox_profile_idx'`,
    );
    assert.match(def, /to_profile_id/);
  });

  test("RLS is on and a MEMBER can neither read the queue nor plant a row", () => {
    assert.equal(
      pg.run(`select relrowsecurity from pg_class where relname = 'email_outbox'`),
      "t",
    );
    const read = pg.runClaims(member, "select count(*) from email_outbox");
    assert.ok(read.ok && read.out === "0", `a member must see nothing; got ${read.out ?? read.error}`);
    const write = pg.runClaims(member, insert(null));
    assert.equal(write.ok, false, "a member must not be able to forge an outbox row");
  });

  test("an ADMIN can inspect and re-queue by hand, without the service key", () => {
    const read = pg.runClaims(admin, "select count(*) > 0 from email_outbox");
    assert.ok(read.ok && read.out === "t", `an admin must see the queue; got ${read.out ?? read.error}`);
    const requeue = pg.runClaims(
      admin,
      "update email_outbox set status = 'pending', attempts = attempts + 1 where status = 'failed'; select 1",
    );
    assert.ok(requeue.ok, `an admin must be able to re-queue: ${requeue.error}`);
  });

  test("service_role writes it — that is the only writer in production", () => {
    const res = pg.runClaims({}, `${insert(NATE)}; select count(*) from email_outbox`, "service_role");
    assert.ok(res.ok, `service_role must be able to record an email: ${res.error}`);
  });

  test("0009's private inbox is untouched — an admin still cannot read someone's mail", () => {
    pg.run(`insert into inbox_items (profile_id, kind, title)
            values ('${BRANDON}', 'task_assigned', 'private')`);
    const res = pg.runClaims(admin, `select count(*) from inbox_items where profile_id = '${BRANDON}'`);
    assert.ok(res.ok && res.out === "0", "0012 must not have opened a back door into the inbox");
  });
});
