/**
 * briefing-claim-migration.test.mjs — 0013, and the one property a fake
 * database cannot prove: the briefing claim is race-safe in POSTGRES.
 *
 * tests/briefing.test.mjs asserts the claim's SHAPE — a single conditional
 * update, one winner, the throttle window. It does that against an in-memory
 * fake, where "simultaneous" is really "sequential in one thread". The claim's
 * safety, though, is a database behaviour: two concurrent UPDATEs serialize on
 * the row lock, and under READ COMMITTED the loser re-evaluates its WHERE
 * against the winner's committed row and matches nothing.
 *
 * So this file runs two real psql sessions that genuinely overlap — the first
 * holds its transaction open across a pg_sleep while the second is already
 * blocked on the row — and asserts that exactly ONE of them claimed. That is
 * the `done when:` "two login triggers inside 20 hours produce exactly one
 * job_runs row", proven at the layer the guarantee actually lives in.
 *
 * Real Postgres, throwaway cluster, no production database.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startClusterWithMigrations, psqlBin, toolsPresent } from "./helpers/pg-cluster.mjs";

const execFileAsync = promisify(execFile);

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
];

const NATE = "eeeeeeee-0000-4000-8000-000000000001";

/**
 * The claim, exactly as lib/briefing.ts issues it through PostgREST: one
 * statement, the throttle in the WHERE, and the row count as the answer.
 */
const CLAIM = (who) => `
  with c as (
    update profiles set briefing_claimed_at = now()
     where id = '${NATE}'
       and (briefing_claimed_at is null or briefing_claimed_at < now() - interval '20 hours')
    returning 1
  )
  insert into claim_witness (who, got) select '${who}', count(*) from c;
`;

describe("0013 briefing claim", { skip: !toolsPresent && "no local Postgres" }, () => {
  let pg;
  /** Async psql, so two sessions can genuinely be in flight at once. */
  let psql;

  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    psql = (sql) =>
      execFileAsync(psqlBin, [
        "-h", pg.conn.socketDir, "-p", pg.conn.port, "-d", pg.conn.dbName,
        "-v", "ON_ERROR_STOP=1", "-q", "-tAc", sql,
      ]);
    pg.run(`insert into auth.users (id, email) values ('${NATE}','nate@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values ('${NATE}','nate@bcn-services.com','Nate')`);
    pg.run(`create table claim_witness (who text, got int)`);
  });
  after(() => pg?.stop());

  test("the column exists, is nullable, and is a timestamptz", () => {
    const row = pg.run(
      `select data_type || ':' || is_nullable from information_schema.columns
        where table_name = 'profiles' and column_name = 'briefing_claimed_at'`,
    );
    assert.equal(row, "timestamp with time zone:YES");
  });

  test("0009's last_briefed_at is untouched — two facts, two columns", () => {
    assert.equal(
      pg.run(`select count(*) from information_schema.columns
               where table_name='profiles' and column_name='last_briefed_at'`),
      "1",
    );
  });

  test("TWO SIMULTANEOUS CLAIMS: exactly one wins", async () => {
    pg.run(`delete from claim_witness`);
    pg.run(`update profiles set briefing_claimed_at = null where id = '${NATE}'`);

    // A opens a transaction, claims, and HOLDS the row lock for a second and a
    // half. B is launched into that window: its UPDATE blocks on A's lock, and
    // when A commits, B re-evaluates its WHERE against the new row.
    const a = psql(`begin; ${CLAIM("A")} select pg_sleep(1.5); commit;`);
    await new Promise((r) => setTimeout(r, 300));
    const b = psql(`${CLAIM("B")}`);
    await Promise.all([a, b]);

    const total = pg.run(`select coalesce(sum(got), 0) from claim_witness`);
    const winners = pg.run(`select string_agg(who, ',' order by who) from claim_witness where got = 1`);
    assert.equal(pg.run(`select count(*) from claim_witness`), "2", "both sessions ran");
    assert.equal(total, "1", `exactly one claim was granted (winner: ${winners})`);
  });

  test("a second claim inside 20 hours is refused, and outside it is granted", () => {
    pg.run(`update profiles set briefing_claimed_at = now() - interval '19 hours' where id='${NATE}'`);
    pg.run(`delete from claim_witness`);
    pg.run(CLAIM("nineteen"));
    assert.equal(pg.run(`select got from claim_witness`), "0", "19 hours: refused");

    pg.run(`update profiles set briefing_claimed_at = now() - interval '21 hours' where id='${NATE}'`);
    pg.run(`delete from claim_witness`);
    pg.run(CLAIM("twentyone"));
    assert.equal(pg.run(`select got from claim_witness`), "1", "21 hours: granted");
  });

  test("a claim does not move last_briefed_at — only a delivered briefing does", () => {
    pg.run(`update profiles set briefing_claimed_at = null, last_briefed_at = null where id='${NATE}'`);
    pg.run(`delete from claim_witness`);
    pg.run(CLAIM("window"));
    assert.equal(
      pg.run(`select coalesce(last_briefed_at::text, 'null') from profiles where id='${NATE}'`),
      "null",
      "the window boundary is untouched by an attempt",
    );
  });

  test("the down migration drops the claim and keeps the window", () => {
    pg.runFile("0013_briefing_claim.down.sql");
    assert.equal(
      pg.run(`select count(*) from information_schema.columns
               where table_name='profiles' and column_name='briefing_claimed_at'`),
      "0",
    );
    assert.equal(
      pg.run(`select count(*) from information_schema.columns
               where table_name='profiles' and column_name='last_briefed_at'`),
      "1",
      "last_briefed_at survives — it is 0009's, not this migration's",
    );
    pg.runFile("0013_briefing_claim.sql");
  });
});
