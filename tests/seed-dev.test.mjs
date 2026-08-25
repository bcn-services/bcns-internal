/**
 * seed-dev.test.mjs — LANE.md item 13: the development fixture seed.
 *
 * Three things are worth proving about a seed, and none of them is "the SQL
 * parses":
 *
 *   1. IT CANNOT REACH PRODUCTION. `assertLocalTarget` is the only thing
 *      standing between a file full of invented businesses and a shared
 *      database, so it is tested as a pure function against the shapes that
 *      actually turn up — a Supabase pooler URL, a bare IP, the userinfo trick
 *      that makes a remote host LOOK local, and an unset variable.
 *   2. IT APPLIES TO THE REAL SCHEMA. Not a mock: the whole migrations
 *      directory is replayed onto a throwaway cluster and the seed is applied
 *      over it with psql, so every CHECK, every foreign key and both of
 *      account_activity's triggers get a vote.
 *   3. IT COVERS EVERY SURFACE. Each assertion below names the surface it
 *      keeps out of an empty state. A fixture file that silently stops seeding
 *      `attention` runs, or the `no_response` lane, or an unread inbox item,
 *      fails here rather than being noticed by eye three surfaces later.
 *
 * And one thing worth proving about the DATA: every seeded contact detail is
 * fiction. That is asserted mechanically (the +1-555-01xx block, example.com /
 * example.org) rather than trusted to the author's care.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not prove a page renders. Two admin
 * panels are genuinely rendered to HTML from seeded rows at the bottom,
 * because those components take plain props; every other surface reads
 * Supabase through `server-only` modules that cannot be imported under plain
 * node, so what is proven for those is "the query the page runs returns rows",
 * which is a different and weaker claim.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import { assertLocalTarget, NotLocalError } from "../scripts/seed-dev.mjs";
import { tokenPanelRows } from "../lib/admin.ts";
import { TokenPanel, JobHistory } from "../app/admin/panels.tsx";
import { startClusterWithMigrations, toolsPresent, psqlBin } from "./helpers/pg-cluster.mjs";

const SEED_FILE = fileURLToPath(new URL("../supabase/seed/0002_dev_fixtures.sql", import.meta.url));

// Discovered, not listed, for the same reason migration-replay.test.mjs
// discovers them: a migration added later must be under the seed on the day it
// lands. Not imported FROM that file — importing a test module would register
// its (cluster-booting) tests a second time in this process.
const upMigrations = () =>
  readdirSync(fileURLToPath(new URL("../supabase/migrations", import.meta.url)))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith(".down.sql"))
    .sort();

/* ============================================================== the guard == */

describe("seed-dev refuses anything that is not this machine", () => {
  const refused = [
    ["a Supabase pooler", "postgres://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres"],
    ["a direct Supabase host", "postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres"],
    ["a bare remote IP", "postgres://postgres@203.0.113.10:5432/postgres"],
    ["a hostname that merely ENDS in localhost", "postgres://postgres@evil-localhost.example.com/postgres"],
    ["a hostname that merely STARTS with localhost", "postgres://postgres@localhost.example.com/postgres"],
    // Postgres dials the host AFTER the last '@'. A check that pattern-matched
    // the string rather than parsing it would call this one local.
    ["a remote host smuggled into the userinfo", "postgres://postgres@localhost@db.abcdefgh.supabase.co/postgres"],
    ["a non-Postgres scheme", "https://127.0.0.1/postgres"],
    ["a relative socket path", "postgres:///postgres?host=tmp/sock"],
    ["a socket URL with userinfo, which is not a parseable URL", "postgres://postgres@/postgres?host=/tmp/sock"],
    ["nonsense", "not a url at all"],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["undefined", undefined],
    ["null", null],
  ];

  for (const [label, url] of refused) {
    test(`refuses ${label}`, () => {
      assert.throws(() => assertLocalTarget(url), NotLocalError, `${label} must be refused`);
    });
  }

  test("the refusal message never echoes the connection string", () => {
    const url = "postgresql://postgres:hunter2@db.abcdefgh.supabase.co:5432/postgres";
    try {
      assertLocalTarget(url);
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(!err.message.includes("hunter2"), "a password must never reach the terminal");
      assert.ok(!err.message.includes(url), "the whole URL must not be echoed");
      assert.match(err.message, /db\.abcdefgh\.supabase\.co/, "the host it refused should be named");
    }
  });

  const accepted = [
    ["localhost", "postgres://postgres@localhost:5432/postgres"],
    ["127.0.0.1", "postgres://postgres:pw@127.0.0.1:54322/postgres"],
    ["::1", "postgres://postgres@[::1]:5432/postgres"],
    ["uppercase LOCALHOST", "postgres://postgres@LOCALHOST:5432/postgres"],
    ["the postgresql:// scheme", "postgresql://postgres@127.0.0.1/postgres"],
    ["a unix socket", "postgres:///postgres?host=/tmp/pg-scratch"],
    ["a percent-encoded socket host", "postgres://%2Ftmp%2Fpg-scratch/postgres"],
  ];

  for (const [label, url] of accepted) {
    test(`accepts ${label}`, () => {
      assert.doesNotThrow(() => assertLocalTarget(url));
    });
  }

  test("a socket host wins over the hostname, and must still be absolute", () => {
    const t = assertLocalTarget("postgres:///postgres?host=/var/run/postgresql");
    assert.equal(t.kind, "socket");
    assert.equal(t.host, "/var/run/postgresql");
  });
});

/* ================================================== the seed, on real PG == */

describe("the fixture seed, applied over every migration", { skip: !toolsPresent && "no local Postgres" }, () => {
  test("applies cleanly and leaves every surface with content", () => {
    const h = startClusterWithMigrations(upMigrations());
    try {
      const applySeed = () =>
        execFileSync(
          psqlBin,
          ["-h", h.conn.socketDir, "-p", h.conn.port, "-d", h.conn.dbName, "-v", "ON_ERROR_STOP=1", "-q", "-f", SEED_FILE],
          { stdio: "pipe", encoding: "utf8" },
        );

      applySeed();

      const one = (sql) => h.run(sql);
      const num = (sql) => Number(h.run(sql));
      const set = (sql) => new Set(h.run(sql).split("\n").filter(Boolean));

      // -- /leads: the funnel and all four outreach lanes -------------------
      assert.ok(num("select count(*) from accounts where notes like 'FIXTURE ROW%'") >= 8,
        "the leads surface needs a spread of synthetic accounts");
      const lanes = set("select distinct outreach_mode from accounts where notes like 'FIXTURE ROW%'");
      for (const lane of ["ai", "human", "paused", "no_response"]) {
        assert.ok(lanes.has(lane), `outreach lane ${lane} is not represented; got ${[...lanes]}`);
      }
      const stages = set("select distinct status from accounts where notes like 'FIXTURE ROW%'");
      assert.ok(stages.size >= 5, `the funnel tiles need several stages; got ${[...stages]}`);
      assert.ok(stages.has("won") && stages.has("lost"), "a terminal stage must be present, or the funnel is all-open");

      // -- /clients ----------------------------------------------------------
      assert.ok(num("select count(*) from clients where notes like 'FIXTURE ROW%'") >= 1,
        "a synthetic client so /clients shows a launched row");

      // -- /activity, the timeline: human kinds AND agent kinds --------------
      const kinds = set("select distinct kind from account_activity");
      for (const k of ["call", "note", "meeting", "email", "status_change"]) {
        assert.ok(kinds.has(k), `human activity kind ${k} missing; got ${[...kinds]}`);
      }
      for (const k of ["ai_email_sent", "ai_email_reply", "agent_run"]) {
        assert.ok(kinds.has(k), `agent activity kind ${k} missing; got ${[...kinds]}`);
      }

      // The 0016 pause trigger keys on `current_user = 'authenticated'`. Seeding
      // as the superuser must therefore NOT have flipped a lane to 'paused' —
      // if it did, the fixture lanes are a lie about what the trigger does.
      assert.equal(one("select outreach_mode from accounts where id = 'f0000000-0000-4000-8000-000000000003'"), "human",
        "seeding human activity must not have tripped the pause trigger");

      // -- /inbox: read, unread, and a non-zero badge ------------------------
      assert.ok(num("select count(*) from inbox_items where read_at is null") >= 3, "unread mail, so the badge is non-zero");
      assert.ok(num("select count(*) from inbox_items where read_at is not null") >= 2, "read mail, so the split is visible");
      assert.ok(num("select count(distinct profile_id) from inbox_items") >= 3, "more than one person has mail");
      // The badge is per-profile; prove at least one profile's own unread count.
      assert.ok(num("select count(*) from inbox_items where profile_id = 'f2000000-0000-4000-8000-000000000002' and read_at is null") >= 2,
        "the sales fixture profile needs its own unread mail");

      // -- /admin: job history, every tone -----------------------------------
      const statuses = set("select distinct status from job_runs");
      for (const s of ["ok", "attention", "failed", "error", "cancelled", "running"]) {
        assert.ok(statuses.has(s), `job_runs status ${s} missing; got ${[...statuses]}`);
      }
      assert.ok(num("select count(*) from job_runs where finished_at is null") >= 1, "a stuck run must be visible");

      // -- /admin: lead targets, active and deactivated ----------------------
      assert.ok(num("select count(*) from lead_targets where active") >= 3, "active targets");
      assert.ok(num("select count(*) from lead_targets where not active") >= 1, "a deactivated target");

      // -- /admin: seats at every expiry distance ----------------------------
      assert.equal(num("select count(*) from agent_tokens where expires_at < now()"), 1, "one expired seat");
      assert.equal(num("select count(*) from agent_tokens where expires_at between now() and now() + interval '30 days'"), 1,
        "one seat inside the 30-day warning window");
      assert.equal(num("select count(*) from agent_tokens where expires_at > now() + interval '90 days'"), 1, "one seat far out");
      assert.ok(num("select count(*) from profiles p where not exists (select 1 from agent_tokens t where t.profile_id = p.id)") >= 1,
        "somebody with no seat at all — the row an enrollment-driven list cannot contain");

      // -- profiles: every job_function --------------------------------------
      const fns = set("select distinct job_function from profiles where job_function is not null");
      for (const f of ["developer", "sales", "ops"]) {
        assert.ok(fns.has(f), `job_function ${f} missing; got ${[...fns]}`);
      }
      assert.ok(num("select count(*) from profiles where job_function is null") >= 1, "the null 'skip me' case");
      assert.ok(num("select count(*) from profiles where not active") >= 1, "a deactivated person");

      // -- outreach drafts at more than one touch ----------------------------
      const touches = set("select distinct touch_number::text from outreach_drafts");
      assert.ok(touches.size >= 3, `drafts must span touch numbers; got ${[...touches]}`);

      // -- /tasks -------------------------------------------------------------
      const taskStatuses = set("select distinct status from tasks");
      for (const s of ["todo", "doing", "done", "cancelled"]) {
        assert.ok(taskStatuses.has(s), `task status ${s} missing; got ${[...taskStatuses]}`);
      }
      assert.ok(num("select count(*) from tasks where assigned_to is null") >= 1, "an unassigned task");
      assert.ok(num("select count(*) from tasks where due_date < current_date and status in ('todo','doing')") >= 1,
        "an overdue open task, which is the tile the morning board leads with");

      // -- the guardrail: nothing here is a real person's details ------------
      assert.equal(num(`select count(*) from accounts where notes like 'FIXTURE ROW%'
                        and phone is not null and phone !~ '^\\+1-555-01[0-9][0-9]$'`), 0,
        "every fixture phone must be in the +1-555-01xx fiction block");
      assert.equal(num(`select count(*) from accounts where notes like 'FIXTURE ROW%'
                        and website is not null and website !~ '^https://[a-z0-9-]+\\.example\\.com$'`), 0,
        "every fixture website must be an example.com host");
      assert.equal(num(`select count(*) from profiles where display_name like '%(synthetic)%'
                        and email !~ '@example\\.(com|org)$'`), 0,
        "every fixture email address must be example.com or example.org");
      assert.equal(num("select count(*) from agent_tokens where sealed not like '%NOT-A-REAL-TOKEN%'"), 0,
        "no seeded sealed value may be mistakable for a token");

      // -- the two known data gaps are LEFT ALONE ----------------------------
      // 0006 records four clients with no domain and no droplet_host, on
      // purpose. A seed that helpfully filled them in would be inventing facts.
      assert.equal(num("select count(*) from clients where domain is null and droplet_host is null and notes not like 'FIXTURE ROW%'"), 4,
        "the four real clients must still be missing domain and droplet_host");
      assert.equal(num("select count(*) from accounts where notes like 'Hosted-web client%' and (assigned_to is not null or consult_date is not null)"), 0,
        "the seed must not backfill assigned_to or consult_date on imported accounts");
      assert.equal(num("select count(*) from clients where monthly_rate_cents is null and notes not like 'FIXTURE ROW%'"), 4,
        "four real clients have no recorded monthly rate and the seed must not invent one");

      // -- re-runnable --------------------------------------------------------
      const before = h.run("select count(*)::text from accounts");
      applySeed();
      assert.equal(h.run("select count(*)::text from accounts"), before, "a second apply must be a no-op, not a duplicate set");

      /* ---------------------------------------------- rendered, not just read */
      // The two admin panels take plain props, so seeded rows can be pushed
      // through the real components and the real HTML asserted. This is the
      // only surface in the app that a headless test can render end to end.
      const rows = JSON.parse(
        h.run(`select coalesce(json_agg(json_build_object(
                 'id', id, 'job', job, 'status', status, 'actor', actor, 'log', log,
                 'window_key', window_key,
                 'started_at', started_at, 'finished_at', finished_at
               ) order by started_at desc), '[]')::text from job_runs`),
      );
      const jobHtml = renderToStaticMarkup(React.createElement(JobHistory, { runs: rows }));
      assert.ok(!jobHtml.includes("Nothing has run yet"), "the job panel must not render its empty state");
      assert.match(jobHtml, /needs attention/, "the attention tone must reach the HTML");
      assert.match(jobHtml, /data-tone="attention"/, "attention must render as its own tone, not as bad");
      assert.match(jobHtml, /data-tone="ok"/);
      assert.match(jobHtml, /data-tone="bad"/);
      assert.match(jobHtml, /data-tone="neutral"/);
      assert.match(jobHtml, /still open/, "the stuck run must render as still open");

      const profiles = JSON.parse(
        h.run(`select coalesce(json_agg(json_build_object('id', id, 'display_name', display_name, 'email', email)
                 order by display_name), '[]')::text from profiles`),
      );
      const seats = JSON.parse(
        h.run(`select coalesce(json_agg(json_build_object('profileId', profile_id, 'expiresAt', expires_at,
                 'lastUsedAt', last_used_at)), '[]')::text from agent_tokens`),
      );
      const panelRows = tokenPanelRows(profiles, seats);
      const states = new Set(panelRows.map((r) => r.state));
      for (const s of ["expired", "expiring", "ok", "none"]) {
        assert.ok(states.has(s), `token state ${s} not produced by the seed; got ${[...states]}`);
      }
      const tokenHtml = renderToStaticMarkup(React.createElement(TokenPanel, { rows: panelRows }));
      assert.match(tokenHtml, /EXPIRED/);
      assert.match(tokenHtml, /expiring/);
      assert.match(tokenHtml, /not connected/);
      assert.ok(!tokenHtml.includes("NOT-A-REAL-TOKEN"), "the sealed value must never reach the panel, fixture or not");
    } finally {
      h.stop();
    }
  });
});
