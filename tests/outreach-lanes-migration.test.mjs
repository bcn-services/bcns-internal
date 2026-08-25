/**
 * outreach-lanes-migration.test.mjs — 0015, against real Postgres.
 *
 * Two of item 10's rules do not live in TypeScript and cannot be proven by a
 * fake:
 *
 *   1. "any account_activity row written by a human on that lead flips it to
 *      paused" — a TRIGGER, because five different writers append to that
 *      table. The interesting half is that it is decided from the ROW: an
 *      agent kind must NOT pause, and this is where both directions are shown.
 *
 *   2. "no fourth touch" — a unique index and a CHECK, so a fourth draft is
 *      refused by the database whatever the job believes.
 *
 * Real Postgres, throwaway cluster, no production database.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startClusterWithMigrations, toolsPresent, CLAIMS } from "./helpers/pg-cluster.mjs";

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
  "0013_briefing_claim.sql",
  "0014_job_windows.sql",
  "0015_outreach_lanes.sql",
];

const AI = "cccccccc-0000-4000-8000-000000000001";
const HUMAN = "cccccccc-0000-4000-8000-000000000002";
const PARKED = "cccccccc-0000-4000-8000-000000000003";
const BOT = "cccccccc-0000-4000-8000-000000000004";

describe("0015 outreach lanes", { skip: !toolsPresent && "no local Postgres" }, () => {
  let pg;
  const modeOf = (id) => pg.run(`select outreach_mode from accounts where id='${id}'`);
  const reset = () =>
    pg.run(`update accounts set outreach_mode='ai' where id in ('${AI}','${BOT}'); select 1`);

  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    for (const [id, mode] of [[AI, "ai"], [HUMAN, "human"], [PARKED, "no_response"], [BOT, "ai"]]) {
      pg.run(`insert into accounts (id, business_name, status, outreach_mode)
              values ('${id}', 'Lead ${id.slice(-1)}', 'new', '${mode}')`);
    }
  });
  after(() => pg?.stop());

  // -- the widened CHECK ------------------------------------------------------

  test("outreach_mode accepts all four lanes and refuses a fifth", () => {
    for (const mode of ["ai", "human", "paused", "no_response"]) {
      const r = pg.tryRun(`update accounts set outreach_mode='${mode}' where id='${HUMAN}'`);
      assert.ok(r.ok, `${mode} must be a valid lane: ${r.error}`);
    }
    pg.run(`update accounts set outreach_mode='human' where id='${HUMAN}'`);
    const bad = pg.tryRun(`update accounts set outreach_mode='snoozed' where id='${HUMAN}'`);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /outreach_mode/i);
  });

  test("0009's default survives — a new lead still starts in the ai lane", () => {
    pg.run(`insert into accounts (id, business_name, status)
            values ('cccccccc-0000-4000-8000-00000000000f', 'Fresh', 'new')`);
    assert.equal(modeOf("cccccccc-0000-4000-8000-00000000000f"), "ai");
  });

  // -- the pause trigger, both directions ------------------------------------

  for (const kind of ["call", "email", "meeting", "note", "status_change"]) {
    test(`a human '${kind}' row on an ai lead pauses it`, () => {
      reset();
      pg.run(`insert into account_activity (account_id, kind) values ('${AI}', '${kind}')`);
      assert.equal(modeOf(AI), "paused");
    });
  }

  for (const kind of ["ai_email_sent", "ai_email_reply", "agent_run"]) {
    test(`a bot '${kind}' row does NOT pause the lane`, () => {
      reset();
      pg.run(`insert into account_activity (account_id, kind) values ('${BOT}', '${kind}')`);
      assert.equal(modeOf(BOT), "ai", "the bot must never pause itself");
    });
  }

  test("a human row does not downgrade a 'human' lane or revive a parked one", () => {
    pg.run(`update accounts set outreach_mode='human' where id='${HUMAN}'`);
    pg.run(`insert into account_activity (account_id, kind) values ('${HUMAN}', 'call')`);
    assert.equal(modeOf(HUMAN), "human");

    pg.run(`update accounts set outreach_mode='no_response' where id='${PARKED}'`);
    pg.run(`insert into account_activity (account_id, kind) values ('${PARKED}', 'call')`);
    assert.equal(modeOf(PARKED), "no_response");
  });

  test("the pause holds for a MEMBER's own write, through RLS", () => {
    // The point of security definer: a staff writer's own row permissions must
    // not decide whether the pause lands.
    //
    // The assertion is INSIDE the impersonated transaction: runClaims discards
    // it at session end, so a `select` afterwards would see the lane unchanged
    // and prove nothing. The last statement's rows are what comes back.
    reset();
    const r = pg.runClaims(
      CLAIMS.member,
      `insert into account_activity (account_id, kind, note) values ('${AI}', 'call', 'rang them');
       select outreach_mode from accounts where id='${AI}';`,
    );
    assert.ok(r.ok, `a member may log a call: ${r.error}`);
    assert.equal(r.out, "paused");
  });

  test("0010 still holds: an authenticated caller cannot forge an agent kind", () => {
    const r = pg.runClaims(
      CLAIMS.admin,
      `insert into account_activity (account_id, kind) values ('${BOT}', 'ai_email_sent');`,
    );
    assert.equal(r.ok, false, "the agent kinds remain service_role's alone");
  });

  // -- outreach_drafts --------------------------------------------------------

  const draft = (acct, n) =>
    pg.tryRun(`insert into outreach_drafts (account_id, touch_number, subject, body)
               values ('${acct}', ${n}, 's', 'b')`);

  test("three touches fit; a fourth is refused by the CHECK", () => {
    for (const n of [1, 2, 3]) assert.ok(draft(PARKED, n).ok, `touch ${n} must be writable`);
    const fourth = draft(PARKED, 4);
    assert.equal(fourth.ok, false, "there is no fourth touch");
    assert.match(fourth.error, /touch_number/);
  });

  test("the same touch cannot be drafted twice", () => {
    const again = draft(PARKED, 2);
    assert.equal(again.ok, false);
    assert.match(again.error, /outreach_drafts_touch_idx|unique/i);
  });

  test("the table cannot even name a recipient or a send — nothing sends", () => {
    const cols = pg.run(
      `select string_agg(column_name, ',' order by column_name) from information_schema.columns
        where table_name = 'outreach_drafts'`,
    ).split(",");
    for (const forbidden of ["to_email", "recipient", "sent_at", "sent", "status", "message_id"]) {
      assert.ok(!cols.includes(forbidden), `outreach_drafts must have no ${forbidden} column`);
    }
  });

  test("staff read drafts, a member cannot write one, and RLS is on", () => {
    assert.equal(
      pg.run(`select relrowsecurity from pg_class where relname='outreach_drafts'`),
      "t",
    );
    const read = pg.runClaims(CLAIMS.member, `select count(*) from outreach_drafts;`);
    assert.ok(read.ok && Number(read.out) >= 3, `staff must be able to read drafts: ${read.error}`);

    const write = pg.runClaims(
      CLAIMS.member,
      `insert into outreach_drafts (account_id, touch_number, subject, body)
       values ('${AI}', 1, 'forged', 'forged');`,
    );
    assert.equal(write.ok, false, "a member must not be able to forge a draft");

    const noRole = pg.runClaims(CLAIMS.noRole, `select count(*) from outreach_drafts;`);
    assert.ok(!noRole.ok || noRole.out === "0", "an unprovisioned session sees nothing");
  });

  // -- reversal ---------------------------------------------------------------

  test("the down migration reverses cleanly and parks nobody back into 'ai'", () => {
    pg.run(`update accounts set outreach_mode='no_response' where id='${PARKED}'`);
    const down = pg.tryRunFile("0015_outreach_lanes.down.sql");
    assert.ok(down.ok, `the down migration must apply: ${down.error}`);

    assert.equal(modeOf(PARKED), "paused", "a parked lead must not come back as 'ai'");
    assert.equal(
      pg.run(`select count(*) from pg_tables where tablename='outreach_drafts'`),
      "0",
    );
    assert.equal(
      pg.run(`select count(*) from pg_trigger where tgname='account_activity_pause_outreach'`),
      "0",
    );

    // And it re-applies, which is what makes the pair usable more than once.
    assert.ok(pg.tryRunFile("0015_outreach_lanes.sql").ok);
  });
});
