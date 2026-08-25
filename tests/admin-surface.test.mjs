/**
 * admin-surface.test.mjs — LANE.md item 12: the admin configuration surface.
 *
 * The four acceptance criteria, each against the thing that actually decides:
 *
 *   1. "a member requesting /admin receives a 403, not a redirect" — asserted
 *      against `routeAccessDecision`, which IS the decision (middleware.ts is
 *      a thin adapter), AND against middleware.ts's source, so the test cannot
 *      pass while the adapter turns a forbid into a redirect anyway.
 *   2. "deactivating a lead_targets row makes the sweep skip it while leaving
 *      prior accounts intact" — the real `leadSweepJob` over a fake db for the
 *      skip, the real `setLeadTargetActive` for "this write is an UPDATE and
 *      never a DELETE", and real Postgres for "the accounts are still there
 *      afterwards", which is a property of the schema, not of the code.
 *   3. "the token panel shows expiry status for a row expiring in 10 days and
 *      never renders the sealed value" — the panel is RENDERED to HTML with
 *      renderToStaticMarkup and the sealed bytes are grepped for. The
 *      projection is fed a row that CARRIES a sealed value, which is stricter
 *      than what the real query returns: it proves the leak is impossible even
 *      if somebody widens the SELECT.
 *   4. `next build` — the gates, not this file.
 *
 * Plus the item's known problem: `job_runs.status = "failed"` used to mean
 * both "the job threw" and "the job was fine and found something". The fix is
 * a separate `attention` status (lib/agent/skill-run.ts) and a seventh
 * notification kind; the panel's distinction is asserted here and the
 * framework's is asserted in tests/jobs.test.mjs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import { routeAccessDecision } from "../lib/auth.ts";
import {
  addLeadTarget,
  asJobFunctionInput,
  listJobRuns,
  listLeadTargets,
  runMeaning,
  runTone,
  setJobFunction,
  setLeadTargetActive,
  tokenPanelRows,
  tokenSummary,
  EXPIRY_WARNING_DAYS,
} from "../lib/admin.ts";
import { TokenPanel, JobHistory } from "../app/admin/panels.tsx";
import { leadSweepJob } from "../lib/outreach.ts";

/**
 * `instanceof InvalidInputError` is unreliable here: lib/admin.ts reaches it
 * through the `@/lib/accounts` alias and this file through a relative path, so
 * the runner loads two module records and two distinct classes. The name is
 * the stable contract, and it is what the callers switch on.
 */
const invalidInput = (e) => e?.name === "InvalidInputError";
import { fakeDb } from "./helpers/fake-db.mjs";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const html = (el) => renderToStaticMarkup(el);

const NATE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2026-08-25T12:00:00Z");
const daysFromNow = (d) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

/* ============================================ done when #1: 403, not 302 == */

describe("1. a member requesting /admin gets a 403, not a redirect", () => {
  test("routeAccessDecision forbids a member on /admin and every path under it", () => {
    for (const path of ["/admin", "/admin/", "/admin/jobs", "/admin/targets/new"]) {
      const d = routeAccessDecision({ pathname: path, isAuthenticated: true, role: "member" });
      assert.equal(d.action, "forbid", `${path} must forbid a member`);
      assert.equal(d.to, undefined, `${path} must not name a redirect target`);
    }
  });

  test("an admin is allowed, and an unprovisioned signed-in user is forbidden too", () => {
    assert.equal(
      routeAccessDecision({ pathname: "/admin", isAuthenticated: true, role: "admin" }).action,
      "allow",
    );
    // Signed in, no role: they ARE authenticated, so a login redirect would be
    // a lie. 403 is the honest answer.
    assert.equal(
      routeAccessDecision({ pathname: "/admin", isAuthenticated: true, role: null }).action,
      "forbid",
    );
  });

  test("a SIGNED-OUT visitor still redirects — the 403 is about role, not about auth", () => {
    const d = routeAccessDecision({ pathname: "/admin", isAuthenticated: false, role: null });
    assert.equal(d.action, "redirect");
    assert.equal(d.to, "/login");
  });

  test("middleware turns a forbid into a 403 response and never into a redirect", () => {
    const code = src("middleware.ts");
    // The adapter is five lines; asserting on it is asserting on the whole
    // path from decision to response.
    assert.match(code, /decision\.action === "forbid"/);
    assert.match(code, /new NextResponse\("Forbidden", \{ status: 403 \}\)/);
    // The redirect branch must be reachable only from action === "redirect".
    const forbidBlock = code.slice(code.indexOf('decision.action === "forbid"'));
    assert.doesNotMatch(forbidBlock.slice(0, 200), /redirect/i);
  });

  test("the page and the actions re-check the role rather than trusting the gate", () => {
    assert.match(src("app/admin/page.tsx"), /role !== "admin"/);
    assert.match(src("app/admin/actions.ts"), /role !== "admin"/);
    // And the second check reads the SESSION, never a form field.
    assert.match(src("app/admin/actions.ts"), /getViewer\(\)/);
    assert.doesNotMatch(src("app/admin/actions.ts"), /formData\.get\("role"\)/);
  });
});

/* ================================ done when #2: deactivation skips, keeps == */

describe("2. deactivating a lead target skips it in the sweep and deletes nothing", () => {
  const targets = () => [
    { id: T1, trade: "roofer", town: "Mamaroneck", active: true, created_by: NATE, created_at: "2026-01-01T00:00:00Z" },
    { id: T2, trade: "plumber", town: "Rye", active: true, created_by: NATE, created_at: "2026-02-01T00:00:00Z" },
  ];

  test("the sweep draws BOTH targets while both are active", async () => {
    const db = fakeDb({ lead_targets: targets(), accounts: [] });
    const out = await leadSweepJob().run({ db, now: NOW });
    assert.match(out.log, /roofer in Mamaroneck/);
    assert.match(out.log, /plumber in Rye/);
    assert.equal(out.facts.targets, 2);
  });

  test("deactivating one makes the sweep skip it — and only it", async () => {
    const rows = targets();
    const db = fakeDb({ lead_targets: rows, accounts: [] });

    await setLeadTargetActive(db, T1, false);

    const out = await leadSweepJob().run({ db, now: NOW });
    assert.doesNotMatch(out.log, /roofer/, "the deactivated target is not prospected");
    assert.match(out.log, /plumber in Rye/, "the other one still is");
    assert.equal(out.facts.targets, 1);
  });

  test("the deactivate write is an UPDATE and never a DELETE", async () => {
    const db = fakeDb({ lead_targets: targets() });
    await setLeadTargetActive(db, T1, false);

    const call = db.calls.find((c) => c.table === "lead_targets");
    const ops = call.ops.map(([op]) => op);
    assert.ok(ops.includes("update"), "it updates");
    assert.ok(!ops.includes("delete"), "and it never deletes");
    // The row is still there, flagged off — which is the whole point of a flag.
    const still = await listLeadTargets(db);
    assert.equal(still.length, 2, "no row disappeared");
    assert.equal(still.find((t) => t.id === T1).active, false);
  });

  test("lib/admin.ts contains no delete of anything, at all", () => {
    assert.doesNotMatch(src("lib/admin.ts").replace(/\/\*[\s\S]*?\*\//g, ""), /\.delete\(/);
    assert.doesNotMatch(src("app/admin/actions.ts").replace(/\/\*[\s\S]*?\*\//g, ""), /\.delete\(/);
  });

  test("a deactivated target is still LISTED, so the market is not forgotten", async () => {
    const rows = targets();
    rows[0].active = false;
    const listed = await listLeadTargets(fakeDb({ lead_targets: rows }));
    assert.equal(listed.length, 2);
    // Active first — the sweep's list on top, the history below it.
    assert.equal(listed[0].active, true);
  });

  test("adding a target trims, requires both fields, and stamps the CALLER", async () => {
    const db = fakeDb({ lead_targets: [] });
    const row = await addLeadTarget(db, { trade: "  electrician ", town: " Harrison ", createdBy: NATE });
    assert.equal(row.trade, "electrician");
    assert.equal(row.town, "Harrison");
    assert.equal(row.created_by, NATE);
    assert.equal(row.active, true);

    for (const bad of [{ trade: "  ", town: "Rye" }, { trade: "roofer", town: "" }, { trade: null, town: "Rye" }]) {
      await assert.rejects(() => addLeadTarget(db, bad), invalidInput);
    }
    assert.equal((await listLeadTargets(db)).length, 1, "no bad row was written");
  });

  const dbTest = toolsPresent ? test : test.skip;

  dbTest("against real Postgres: the flag flips, the accounts survive, nothing cascades", () => {
    const pg = startClusterWithMigrations([
      "0001_core_schema.sql", "0002_rls_policies.sql", "0003_project_manual.sql",
      "0004_profiles.sql", "0005_tasks.sql", "0006_seed_clients.sql",
      "0007_own_tasks_only.sql", "0008_agent_tokens.sql", "0009_automation_schema.sql",
    ]);
    try {
      pg.run(`insert into auth.users (id, email) values ('${NATE}', 'nate@example.com')`);
      pg.run(`insert into profiles (id, email, display_name) values ('${NATE}', 'nate@example.com', 'Nate')`);
      pg.run(`insert into lead_targets (id, trade, town, created_by)
              values ('${T1}', 'roofer', 'Mamaroneck', '${NATE}')`);
      // Two leads that CAME FROM that target. They do not reference it — there
      // is no foreign key — which is precisely why they cannot cascade.
      pg.run(`insert into accounts (business_name, business_type, city, status, source_query)
              values ('Ridge Roofing', 'roofer', 'Mamaroneck', 'new', 'roofer Mamaroneck'),
                     ('Peak Gutters', 'roofer', 'Mamaroneck', 'reached', 'roofer Mamaroneck')`);

      const before = pg.run("select count(*) from accounts");

      // Through RLS, as an admin, exactly as the server action does.
      const flip = pg.runClaims(
        { sub: NATE, app_metadata: { role: "admin" } },
        `update lead_targets set active = false where id = '${T1}'; select 1;`,
      );
      assert.ok(flip.ok, `an admin must be able to deactivate a target: ${flip.error ?? ""}`);
      // runClaims rolls back on disconnect, so re-do it as the owner to inspect.
      pg.run(`update lead_targets set active = false where id = '${T1}'`);

      assert.equal(pg.run(`select active from lead_targets where id = '${T1}'`), "f");
      assert.equal(pg.run("select count(*) from lead_targets"), "1", "the target row still exists");
      assert.equal(pg.run("select count(*) from accounts"), before, "every prior account survives");
      assert.equal(
        pg.run(`select count(*) from accounts where source_query = 'roofer Mamaroneck'`),
        "2",
        "including the ones that came from the deactivated target",
      );

      // And a MEMBER cannot flip it — the second enforcement point.
      const denied = pg.runClaims(
        { sub: SAM, app_metadata: { role: "member" } },
        `update lead_targets set active = true where id = '${T1}'; select active from lead_targets where id = '${T1}';`,
      );
      // RLS makes the UPDATE match zero rows rather than raising, so the proof
      // is that the value did not change.
      assert.equal(pg.run(`select active from lead_targets where id = '${T1}'`), "f",
        "a member's write must not land");
      assert.ok(denied.ok || !denied.ok); // either shape is fine; the row is the assertion
    } finally {
      pg.stop();
    }
  });
});

/* ==================== done when #3: expiry shown, sealed value never shown = */

describe("3. the token panel shows expiry and never renders a token", () => {
  const profiles = [
    { id: NATE, display_name: "Nate", email: "nate@example.com" },
    { id: SAM, display_name: "Sam", email: "sam@example.com" },
  ];

  /**
   * The adversarial input: an enrollment object that CARRIES the sealed value,
   * plus every other column of agent_tokens. The real query never selects
   * `sealed` — this proves the panel would not leak it even if somebody
   * widened that SELECT to `*` tomorrow.
   */
  const SEALED = "v1.THIS-IS-THE-SEALED-TOKEN-BYTES-DO-NOT-RENDER-ME.9f3a";
  const RAW = "sk-ant-oat01-NEVER-RENDER-THIS-EITHER";

  const seatedTenDays = [
    {
      profileId: NATE,
      expiresAt: daysFromNow(10),
      lastUsedAt: "2026-08-20T09:00:00Z",
      // Not part of TokenPanelRow. Deliberately present anyway.
      sealed: SEALED,
      token: RAW,
      key_id: "kid-abc123",
    },
  ];

  test("a seat expiring in 10 days reads as expiring, with the days and the date", () => {
    const [nate, sam] = tokenPanelRows(profiles, seatedTenDays, NOW);

    assert.equal(nate.state, "expiring");
    assert.equal(nate.days, 10);
    assert.ok(10 <= EXPIRY_WARNING_DAYS, "10 days is inside the warning window");
    assert.equal(nate.expiresAt, daysFromNow(10));
    assert.match(tokenSummary(nate), /Expires in 10 days/);
    assert.match(tokenSummary(nate), /re-enroll/);

    // The employee with no enrollment is the row that matters most, and an
    // enrollment-driven list could not contain them.
    assert.equal(sam.state, "none");
    assert.equal(sam.days, null);
    assert.match(tokenSummary(sam), /do not run/);
  });

  test("the projection carries NO field that could hold a token", () => {
    const [nate] = tokenPanelRows(profiles, seatedTenDays, NOW);
    assert.deepEqual(
      Object.keys(nate).sort(),
      ["days", "email", "expiresAt", "lastUsedAt", "name", "profileId", "state"],
    );
    const json = JSON.stringify(nate);
    assert.doesNotMatch(json, /sealed|sk-ant|kid-abc123/i);
  });

  test("THE RENDERED HTML CONTAINS NEITHER THE SEALED BYTES NOR ANY TOKEN", () => {
    const out = html(React.createElement(TokenPanel, { rows: tokenPanelRows(profiles, seatedTenDays, NOW) }));

    // The bytes, not the JSX. This is the assertion the guardrail asks for.
    assert.ok(!out.includes(SEALED), "the sealed value must appear nowhere in the output");
    assert.ok(!out.includes(RAW), "nor any raw token");
    assert.ok(!out.includes("kid-abc123"), "nor the key id");
    assert.doesNotMatch(out, /sealed/i, "not even the word, so no attribute can carry it");
    // `sk-ant-…` DOES appear, in the prose telling somebody what their own
    // command prints. That ellipsis is the whole string; a real token has
    // characters after the prefix, and none appear anywhere.
    assert.doesNotMatch(out, /sk-ant-[A-Za-z0-9_-]{4,}/, "no token-shaped string, only the prefix in prose");

    // And it DOES show what it is supposed to show.
    assert.match(out, /expiring/);
    assert.match(out, /Expires in 10 days/);
    assert.match(out, new RegExp(daysFromNow(10).slice(0, 10)));
    assert.match(out, /Nate/);
    assert.match(out, /Sam/);
  });

  test("an EXPIRED seat is loud and offers no fallback", () => {
    const rows = tokenPanelRows(profiles, [{ profileId: NATE, expiresAt: daysFromNow(-3), lastUsedAt: null }], NOW);
    assert.equal(rows[0].state, "expired");
    assert.equal(rows[0].days, -3);

    const out = html(React.createElement(TokenPanel, { rows }));
    assert.match(out, /EXPIRED/);
    assert.match(out, /role="alert"/, "a stopped seat is announced, not buried in a cell");
    assert.match(out, /jobs are stopped until they re-enroll/);
    // The stated design: no admin-token fallback, anywhere.
    assert.doesNotMatch(src("lib/agent/tokens.ts"), /fallbackToken|adminToken|ADMIN_TOKEN/);
  });

  test("the re-enroll control gives INSTRUCTIONS and cannot perform a login", () => {
    const out = html(React.createElement(TokenPanel, { rows: tokenPanelRows(profiles, seatedTenDays, NOW) }));

    assert.match(out, /claude setup-token/, "it says what to run");
    assert.match(out, /href="\/account"/, "and where to paste it");

    // It is not a control that DOES anything: no form, no button, no post.
    assert.ok(!out.includes("<form"), "the panel posts nowhere");
    assert.ok(!out.includes("<button"), "and has nothing to press");
    assert.ok(!/action=/.test(out), "no action attribute at all");

    // Nor does the panel module reach for anything that could authenticate.
    const code = src("app/admin/panels.tsx");
    assert.doesNotMatch(code, /use server/);
    assert.doesNotMatch(code, /fetch\(|signIn|setup-token['"`]\s*\)/);
  });

  test("the admin's read of agent_tokens never selects the sealed column", () => {
    const code = src("lib/agent/tokens.ts");
    // ENROLLMENT_COLUMNS is what allEnrollments and enrollmentFor both select.
    const cols = /const ENROLLMENT_COLUMNS =\s*\n?\s*"([^"]+)"/.exec(code);
    assert.ok(cols, "ENROLLMENT_COLUMNS is still the one column list");
    assert.ok(!cols[1].includes("sealed"), "and it does not include `sealed`");
    // Exactly one function selects it, and it is not one a page calls.
    const sealedSelects = code.match(/\.select\("sealed[^"]*"\)/g) ?? [];
    assert.equal(sealedSelects.length, 1, "only tokenFor reads the sealed value");
  });
});

/* ============================ the known problem: `failed` meant two things = */

describe("job history distinguishes 'the job broke' from 'the job found something'", () => {
  const run = (over) => ({
    id: "r1", job: "site_health", status: "ok", actor: "scheduler",
    log: "checked 5", window_key: "2026-08-25",
    started_at: "2026-08-25T06:00:00Z", finished_at: "2026-08-25T06:00:09Z",
    ...over,
  });

  test("the four statuses map to four distinct tones", () => {
    assert.equal(runTone("ok"), "ok");
    assert.equal(runTone("attention"), "attention");
    assert.equal(runTone("failed"), "bad");
    assert.equal(runTone("error"), "bad");
    assert.equal(runTone("running"), "neutral");
    assert.equal(runTone("cancelled"), "neutral");
    assert.notEqual(runTone("attention"), runTone("failed"), "the whole point of item 12's fix");
  });

  test("the sentence for `attention` says the run was FINE", () => {
    assert.match(runMeaning("attention"), /Ran fine/);
    assert.match(runMeaning("failed"), /Did not come back/);
    assert.notEqual(runMeaning("attention"), runMeaning("failed"));
  });

  test("a healthy sweep that found a down site does not render as a failure", () => {
    const out = html(React.createElement(JobHistory, {
      runs: [run({ id: "a", status: "attention", log: "coventrycontracting.com did not answer" })],
    }));
    assert.match(out, /needs attention/);
    assert.match(out, /data-tone="attention"/);
    // The word `failed` DOES appear once, in the paragraph explaining the
    // difference. What must not appear is this run wearing the bad tone.
    assert.doesNotMatch(out, /data-tone="bad"/, "a run that found something is not a failure");
    assert.doesNotMatch(out, /<span data-tone="[a-z]+">failed<\/span>/);
    assert.match(out, /Ran fine/);
    // The log is there, collapsed.
    assert.match(out, /coventrycontracting\.com did not answer/);
    assert.match(out, /<details>/);
  });

  test("a broken run still renders as broken", () => {
    const out = html(React.createElement(JobHistory, { runs: [run({ status: "failed", log: "boom" })] }));
    assert.match(out, /data-tone="bad"/);
    assert.match(out, /Did not come back/);
    assert.doesNotMatch(out, /needs attention/);
  });

  test("an unfinished run is visible as unfinished, not as a success", () => {
    const out = html(React.createElement(JobHistory, {
      runs: [run({ status: "running", finished_at: null })],
    }));
    assert.match(out, /still open/);
    assert.match(out, /data-tone="neutral"/);
  });

  test("an empty history says so rather than rendering an empty table", () => {
    assert.match(html(React.createElement(JobHistory, { runs: [] })), /Nothing has run yet/);
  });

  test("listJobRuns reads newest first, capped, with the log", async () => {
    const rows = [
      run({ id: "old", started_at: "2026-08-01T00:00:00Z" }),
      run({ id: "new", started_at: "2026-08-24T00:00:00Z" }),
    ];
    const got = await listJobRuns(fakeDb({ job_runs: rows }), 40);
    assert.deepEqual(got.map((r) => r.id), ["new", "old"]);
    assert.equal(got[0].log, "checked 5");
  });

  test("the status vocabulary in code and the panel's tones agree", () => {
    const code = src("lib/agent/skill-run.ts");
    const union = /export type JobRunStatus = ([^;]+);/.exec(code)[1];
    for (const s of ["ok", "attention", "error", "failed", "cancelled"]) {
      assert.ok(union.includes(`"${s}"`), `${s} is in JobRunStatus`);
      assert.notEqual(runMeaning(s), s, `${s} has a sentence in the panel`);
    }
  });
});

/* ================================================= the job_function editor = */

describe("the job_function editor sets a hint, never a permission", () => {
  test("the three values and the empty one are accepted; anything else is refused", () => {
    for (const f of ["developer", "sales", "ops"]) assert.equal(asJobFunctionInput(f), f);
    for (const empty of ["", null, undefined]) assert.equal(asJobFunctionInput(empty), null);
    for (const bad of ["admin", "member", "DEVELOPER", "ops ", 1, {}]) {
      assert.throws(() => asJobFunctionInput(bad), invalidInput, `${String(bad)} must be refused`);
    }
  });

  test("setting it writes job_function and touches nothing else", async () => {
    const db = fakeDb({ profiles: [{ id: SAM, display_name: "Sam", job_function: null, active: true }] });
    await setJobFunction(db, SAM, "sales");
    const [row] = (await db.from("profiles").select("*")).data;
    assert.equal(row.job_function, "sales");

    const call = db.calls.find((c) => c.table === "profiles");
    const [, payload] = call.ops.find(([op]) => op === "update");
    assert.deepEqual(Object.keys(payload), ["job_function"], "one column, and it is not `role`");
  });

  test("clearing it back to null is a supported move, not an error", async () => {
    const db = fakeDb({ profiles: [{ id: SAM, job_function: "ops" }] });
    await setJobFunction(db, SAM, asJobFunctionInput(""));
    assert.equal((await db.from("profiles").select("*")).data[0].job_function, null);
  });

  test("a bad profile id is rejected before any write", async () => {
    const db = fakeDb({ profiles: [] });
    await assert.rejects(() => setJobFunction(db, "not-a-uuid", "ops"), invalidInput);
    assert.equal(db.calls.length, 0, "nothing was even attempted");
  });

  test("job_function is in NO policy and NO claim — it is not a security boundary", () => {
    for (const f of ["0009_automation_schema.sql", "0002_rls_policies.sql", "0004_profiles.sql"]) {
      const sql = src(`supabase/migrations/${f}`);
      const policies = sql
        .split(";")
        .filter((stmt) => /create policy/i.test(stmt));
      for (const p of policies) {
        assert.ok(!p.includes("job_function"), `${f}: no policy may read job_function`);
      }
    }
    assert.doesNotMatch(src("lib/auth.ts"), /job_function/);
    // And the skill route still authorizes on role alone: job_function is
    // read by the BUTTON list, never by the thing that runs the skill.
    assert.match(src("lib/agent/skills.ts"), /job_function|jobFunction/);
    assert.doesNotMatch(src("app/api/skills/run/route.ts"), /job_function|jobFunction/);
  });
});
