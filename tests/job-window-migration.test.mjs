/**
 * job-window-migration.test.mjs — 0014, and the one property a fake database
 * cannot prove: a job's idempotency holds in POSTGRES, under real concurrency.
 *
 * tests/jobs.test.mjs asserts the SHAPE of the claim — one insert, one winner,
 * the loser doing no work and notifying nobody — against an in-memory fake
 * whose "unique index" is a JavaScript loop and whose "simultaneous" is really
 * "sequential in one thread". That proves the framework reacts correctly to a
 * 23505. It cannot prove that a 23505 is what two genuinely overlapping
 * processes get.
 *
 * So this file runs two real psql sessions that overlap — the first holds its
 * transaction open across a pg_sleep with the index entry already written,
 * while the second is blocked on it — and asserts exactly ONE row exists and
 * the other session was told 23505. That is the item's "running it twice in one
 * window produces one notification, not two", proven at the layer the guarantee
 * actually lives in.
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
  "0014_job_windows.sql",
];

/** The claim, exactly as lib/agent/skill-run.ts's claimRun issues it. */
const CLAIM = (job, window) =>
  `insert into job_runs (job, actor, status, window_key)
   values ('${job}', 'scheduler', 'running', ${window === null ? "null" : `'${window}'`})
   returning id`;

describe("0014 job windows", { skip: !toolsPresent && "no local Postgres" }, () => {
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
  });
  after(() => pg?.stop());

  test("the column exists, is nullable, and is text", () => {
    assert.equal(
      pg.run(`select data_type || ':' || is_nullable from information_schema.columns
               where table_name = 'job_runs' and column_name = 'window_key'`),
      "text:YES",
    );
  });

  test("the index is unique and partial on window_key is not null", () => {
    const def = pg.run(`select indexdef from pg_indexes where indexname = 'job_runs_window_idx'`);
    assert.match(def, /CREATE UNIQUE INDEX/);
    assert.match(def, /\(job, window_key\)/);
    assert.match(def, /WHERE \(window_key IS NOT NULL\)/);
  });

  test("0009's indexes survive — this migration adds, it does not replace", () => {
    const names = pg.run(
      `select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename='job_runs'`,
    );
    for (const idx of ["job_runs_job_idx", "job_runs_unfinished_idx"]) {
      assert.ok(names.includes(idx), `${idx} missing; got ${names}`);
    }
  });

  test("a second claim on the same (job, window) is refused with 23505", () => {
    pg.run(`delete from job_runs`);
    pg.run(CLAIM("site_health", "2026-08-24"));
    const again = pg.tryRun(CLAIM("site_health", "2026-08-24"));
    assert.equal(again.ok, false, "the same window may be claimed only once");
    assert.match(again.error, /duplicate key value|job_runs_window_idx/);
    assert.equal(pg.run(`select count(*) from job_runs`), "1");
  });

  test("a different job, or a different window, is free", () => {
    pg.run(`delete from job_runs`);
    pg.run(CLAIM("site_health", "2026-08-24"));
    pg.run(CLAIM("quiet_clients", "2026-08-24"));
    pg.run(CLAIM("site_health", "2026-08-25"));
    assert.equal(pg.run(`select count(*) from job_runs`), "3");
  });

  test("unwindowed runs are exempt — item 5's button still runs on every press", () => {
    pg.run(`delete from job_runs`);
    pg.run(CLAIM("leads", null));
    pg.run(CLAIM("leads", null));
    pg.run(CLAIM("leads", null));
    assert.equal(pg.run(`select count(*) from job_runs`), "3", "a partial index ignores nulls");
  });

  test("TWO SIMULTANEOUS CLAIMS: exactly one row, and the loser is told 23505", async () => {
    pg.run(`delete from job_runs`);

    // A inserts and HOLDS the transaction open for a second and a half, so its
    // index entry is written but uncommitted. B is launched into that window:
    // its insert blocks on A's uncommitted entry, and when A commits, B is
    // woken with a unique violation rather than being allowed through.
    const a = psql(`begin; ${CLAIM("site_health", "2026-08-24")}; select pg_sleep(1.5); commit;`);
    await new Promise((r) => setTimeout(r, 300));
    const b = psql(CLAIM("site_health", "2026-08-24")).then(
      () => ({ won: true }),
      (e) => ({ won: false, err: String(e.stderr ?? e.message ?? e) }),
    );

    const [, second] = await Promise.all([a, b]);

    assert.equal(pg.run(`select count(*) from job_runs`), "1", "exactly ONE run row exists");
    assert.equal(second.won, false, "the overlapping session did not get a row");
    assert.match(second.err, /duplicate key value|unique constraint/);
    // SQLSTATE 23505 is what claimRun reads as `taken`; anything else it treats
    // as a real fault and reports rather than silently skipping.
    assert.match(second.err, /23505|duplicate key value violates unique constraint/);
  });

  test("BOTH LOSING: three overlapping sessions still leave one row", async () => {
    pg.run(`delete from job_runs`);
    const runs = [1, 2, 3].map(() =>
      psql(CLAIM("quiet_clients", "2026-08-24")).then(
        () => 1,
        () => 0,
      ),
    );
    const wins = (await Promise.all(runs)).reduce((a, b) => a + b, 0);
    assert.equal(wins, 1, "exactly one of three concurrent claims succeeded");
    assert.equal(pg.run(`select count(*) from job_runs`), "1");
  });

  test("a closed run still occupies its window — a retry after a failure is not a re-run", () => {
    pg.run(`delete from job_runs`);
    pg.run(CLAIM("credential_expiry", "w2951"));
    pg.run(`update job_runs set status='failed', finished_at=now() where window_key='w2951'`);
    const retry = pg.tryRun(CLAIM("credential_expiry", "w2951"));
    assert.equal(retry.ok, false, "the window is spent whether the run succeeded or not");
  });

  test("staff can read a windowed run; a member cannot forge one", () => {
    pg.run(`delete from job_runs`);
    pg.run(CLAIM("site_health", "2026-08-24"));
    const read = pg.runClaims({ app_metadata: { role: "member" } }, `select count(*) from job_runs`);
    assert.equal(read.ok && read.out, "1", "0009's staff-read policy still applies");
    const forge = pg.runClaims(
      { app_metadata: { role: "member" } },
      `${CLAIM("site_health", "2026-08-25")}`,
    );
    assert.equal(forge.ok, false, "a member may not write a job run");
  });

  test("the service role — what a job actually runs as — may claim", () => {
    pg.run(`delete from job_runs`);
    const res = pg.runClaims({}, CLAIM("site_health", "2026-08-26"), "service_role");
    assert.equal(res.ok, true, `service_role must be able to open a run: ${res.error ?? ""}`);
  });

  test("the down migration removes the index with the column, and keeps the rows", () => {
    pg.run(`delete from job_runs`);
    pg.run(CLAIM("site_health", "2026-08-27"));
    pg.runFile("0014_job_windows.down.sql");
    assert.equal(
      pg.run(`select count(*) from information_schema.columns
               where table_name='job_runs' and column_name='window_key'`),
      "0",
    );
    assert.equal(
      pg.run(`select count(*) from pg_indexes where indexname='job_runs_window_idx'`),
      "0",
    );
    assert.equal(pg.run(`select count(*) from job_runs`), "1", "the run itself survives");
    pg.runFile("0014_job_windows.sql");
    assert.equal(
      pg.run(`select count(*) from pg_indexes where indexname='job_runs_window_idx'`),
      "1",
      "and it re-applies onto a populated table",
    );
  });
});
