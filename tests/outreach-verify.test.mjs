/**
 * outreach-verify.test.mjs — INDEPENDENT QA for item 10.
 *
 * Written against the four `done when:` criteria verbatim, not against the
 * builder's account of them. Every test here was mutation-checked: the source
 * was deliberately broken and the test confirmed to go red before being kept.
 *
 * Nothing here touches a network, a real model or a production database. The
 * site reader and the evaluator are injected in every case.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fakeDb } from "./helpers/fake-db.mjs";
import { startClusterWithMigrations, toolsPresent, CLAIMS } from "./helpers/pg-cluster.mjs";
import { outreachJob, leadSweepJob, MAX_BOT_TOUCHES } from "../lib/outreach.ts";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * The same file with every comment removed. Item 10's source is heavily
 * commented and several of those comments name the very things a guardrail
 * grep hunts for ("nothing in this file spawns a CLI", "allowPrivateHosts is
 * deliberately not set"). Matching prose would make the guardrails both
 * false-positive and, worse, satisfiable by deleting a comment — so they run
 * against CODE only.
 */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Run a JobDefinition's body directly against a fake db. */
const runBody = (def, db, now = new Date("2026-08-24T12:00:00Z")) => def.run({ db, now });

/** The unique index 0015 actually creates, taught to the fake. */
const DRAFT_UNIQUE = { outreach_drafts: [["account_id", "touch_number"]] };

const acct = (over) => ({
  id: "a", business_name: "Acme", business_type: "plumber", city: "Rye",
  website: null, has_website: false, source_query: null, notes: null,
  status: "new", outreach_mode: "ai", ...over,
});

/* ================================================================ criterion 1 */
//
// "Writing a human account_activity row on an ai lead sets outreach_mode to
//  paused, AND the outreach job then selects 0 rows for it."
//
// Two independent halves. The trigger half is Postgres (below); this is the
// job half — a lead in any lane but 'ai' is not in the job's result set at all.

describe("C1b — the job selects 0 rows for a paused lead", () => {
  test("a lead the trigger paused is never considered, drafted or parked", async () => {
    const db = fakeDb(
      { accounts: [acct({ id: "paused-one", outreach_mode: "paused", website: "x.test" })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    const res = await runBody(
      outreachJob({
        readSite: async () => ({ ok: true, text: "t", finalUrl: "https://x.test", title: null }),
        evaluate: async () => ({ ok: true, reply: '{"description":"d","subject":"s","body":"b"}' }),
      }),
      db,
    );
    assert.equal(res.facts.considered, 0, "a paused lead must not be considered");
    assert.equal(res.facts.drafted, 0);
    assert.equal(db.calls.find((c) => c.table === "outreach_drafts"), undefined, "no draft table write at all");
  });

  test("the guardrail fixture: ALL lane states and ALL stages at once, only the ai/open lead survives", async () => {
    const accounts = [
      acct({ id: "won-1", status: "won" }),
      acct({ id: "won-2", status: "won", outreach_mode: "ai" }),
      acct({ id: "lost-1", status: "lost" }),
      acct({ id: "dead-1", status: "dead" }),
      acct({ id: "human-1", outreach_mode: "human" }),
      acct({ id: "paused-1", outreach_mode: "paused" }),
      acct({ id: "parked-1", outreach_mode: "no_response" }),
      acct({ id: "live-1", outreach_mode: "ai", status: "new", website: "live.test" }),
      acct({ id: "stale-1", outreach_mode: "ai", status: "consult_done", website: "live.test" }),
      acct({ id: "live-2", outreach_mode: "ai", status: "reached", website: "live.test" }),
    ];
    // Snapshot BEFORE the run: fakeDb updates mutate these rows in place, so a
    // comparison against the live objects would compare a value to itself.
    const expected = accounts.map((a) => ({ id: a.id, outreach_mode: a.outreach_mode, status: a.status }));
    const db = fakeDb({ accounts, account_activity: [], outreach_drafts: [] }, { unique: DRAFT_UNIQUE });
    const res = await runBody(
      outreachJob({
        readSite: async () => ({ ok: true, text: "we fix pipes", finalUrl: "https://live.test", title: null }),
        evaluate: async () => ({ ok: true, reply: '{"description":"a plumber","subject":"s","body":"b"}' }),
      }),
      db,
    );
    assert.equal(res.facts.considered, 3, "only the open 'ai' leads are in scope");
    assert.equal(res.facts.parked, 0);
    const rows = await fakeRows(db, "outreach_drafts");
    assert.deepEqual(rows.map((r) => r.account_id).sort(), ["live-1", "live-2", "stale-1"]);
    // Every won / lost / dead / human / paused / no_response row: untouched.
    const after = await fakeRows(db, "accounts");
    for (const a of expected) {
      if (a.id.startsWith("live") || a.id === "stale-1") continue;
      const now = after.find((x) => x.id === a.id);
      assert.equal(now.outreach_mode, a.outreach_mode, `${a.id}'s lane must be unchanged`);
      assert.equal(now.status, a.status, `${a.id}'s stage must be unchanged`);
      assert.ok(!rows.some((r) => r.account_id === a.id), `${a.id} must have no draft`);
    }
  });

  test("a won account in the ai lane is still excluded — the stage filter, not the lane, catches it", async () => {
    const db = fakeDb({ accounts: [acct({ id: "won-ai", status: "won", outreach_mode: "ai", website: "w.test" })], account_activity: [], outreach_drafts: [] }, { unique: DRAFT_UNIQUE });
    const res = await runBody(outreachJob({ readSite: async () => ({ ok: true, text: "t", finalUrl: "u", title: null }), evaluate: async () => ({ ok: true, reply: "{}" }) }), db);
    assert.equal(res.facts.considered, 0);
  });
});

/* ================================================================ criterion 2 */
//
// "A lead with 3 bot activity rows and no reply is set to no_response and
//  receives no 4th draft."
//
// Boundary at 2, 3 and 4. A reply must stop the parking.

describe("C2 — the three-touch cap, at the boundary", () => {
  const withTouches = (n, extra = []) => {
    const activity = [];
    for (let i = 0; i < n; i += 1) activity.push({ account_id: "a", kind: "ai_email_sent" });
    return fakeDb(
      { accounts: [acct({ website: "a.test" })], account_activity: [...activity, ...extra], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
  };
  const job = outreachJob({
    readSite: async () => ({ ok: true, text: "pipes", finalUrl: "https://a.test", title: null }),
    evaluate: async () => ({ ok: true, reply: '{"description":"d","subject":"s","body":"b"}' }),
  });

  test("2 touches → a third draft, no parking", async () => {
    const db = withTouches(2);
    const res = await runBody(job, db);
    assert.equal(res.facts.drafted, 1);
    assert.equal(res.facts.parked, 0);
    const rows = await fakeRows(db, "outreach_drafts");
    assert.equal(rows[0].touch_number, 3);
    assert.equal((await fakeRows(db, "accounts"))[0].outreach_mode, "ai");
  });

  test("the cap is literally three", () => {
    assert.equal(MAX_BOT_TOUCHES, 3, "the criterion names 3 touches");
  });

  test("3 touches, no reply → parked as no_response and NO fourth draft", async () => {
    const db = withTouches(3);
    const res = await runBody(job, db);
    assert.equal(res.facts.parked, 1);
    assert.equal(res.facts.drafted, 0, "no fourth draft");
    assert.equal((await fakeRows(db, "outreach_drafts")).length, 0);
    assert.equal((await fakeRows(db, "accounts"))[0].outreach_mode, "no_response");
  });

  test("4 touches → still parked, still no draft", async () => {
    const db = withTouches(4);
    const res = await runBody(job, db);
    assert.equal(res.facts.parked, 1);
    assert.equal(res.facts.drafted, 0);
    assert.equal((await fakeRows(db, "accounts"))[0].outreach_mode, "no_response");
  });

  test("3 touches WITH a reply → not parked, not drafted: a human owns it", async () => {
    const db = withTouches(3, [{ account_id: "a", kind: "ai_email_reply" }]);
    const res = await runBody(job, db);
    assert.equal(res.facts.parked, 0, "a lead that replied must not be parked");
    assert.equal(res.facts.drafted, 0, "a lead that replied gets no further draft");
    assert.equal((await fakeRows(db, "accounts"))[0].outreach_mode, "ai");
  });

  test("1 touch WITH a reply → still skipped; the reply outranks the count", async () => {
    const db = withTouches(1, [{ account_id: "a", kind: "ai_email_reply" }]);
    const res = await runBody(job, db);
    assert.equal(res.facts.drafted, 0);
    assert.equal((await fakeRows(db, "outreach_drafts")).length, 0);
  });

  test("another lead's activity rows never count toward this lead", async () => {
    const db = fakeDb(
      {
        accounts: [acct({ id: "a", website: "a.test" })],
        account_activity: [
          { account_id: "other", kind: "ai_email_sent" },
          { account_id: "other", kind: "ai_email_sent" },
          { account_id: "other", kind: "ai_email_sent" },
          { account_id: "other", kind: "ai_email_reply" },
        ],
        outreach_drafts: [],
      },
      { unique: DRAFT_UNIQUE },
    );
    const res = await runBody(job, db);
    assert.equal(res.facts.drafted, 1);
    assert.equal((await fakeRows(db, "outreach_drafts"))[0].touch_number, 1);
  });

  test("the park is conditional on the lane still being 'ai' — a human's pause wins the race", async () => {
    // The park's UPDATE must carry the lane predicate, so a pause landing
    // between the read and the write makes it match nothing.
    const db = withTouches(3);
    await runBody(job, db);
    const update = db.calls.find((c) => c.table === "accounts" && c.ops.some(([op]) => op === "update"));
    assert.ok(update, "the park updates accounts");
    assert.ok(
      update.ops.some(([op, col, val]) => op === "eq" && col === "outreach_mode" && val === "ai"),
      "the park must be conditional on the lane still being 'ai'",
    );

    const raced = fakeDb(
      {
        accounts: [acct({ website: "a.test", outreach_mode: "paused" })],
        account_activity: [1, 2, 3].map(() => ({ account_id: "a", kind: "ai_email_sent" })),
        outreach_drafts: [],
      },
      { unique: DRAFT_UNIQUE },
    );
    const res = await runBody(job, raced);
    assert.equal(res.facts.parked, 0, "a paused lead is never parked out from under the human");
    assert.equal((await fakeRows(raced, "accounts"))[0].outreach_mode, "paused");
  });
});

/* ================================================================ criterion 3 */
//
// "An outreach draft for a lead with a reachable website contains a business
//  description derived from that site's content, not from its source_query."
//
// The evaluator here answers ONLY when the fetched page's private phrase is
// present in the prompt it was handed. If the code ever stopped putting the
// page text into the prompt — or substituted source_query — the evaluator
// returns nothing and business_description lands null, which these tests fail
// on. The description string itself is derived from the page text, so it
// cannot be produced without having read it.

describe("C3 — the description comes from the fetched page, not source_query", () => {
  const PAGE_PHRASE = "we regrout Victorian tiling in Rye since 1974";
  const SOURCE_QUERY = "plumber near Rye NY";

  /** Answers only if the prompt actually carries the page text. */
  const strictEvaluator = (seen) => async (prompt) => {
    seen.push(prompt);
    if (!prompt.includes(PAGE_PHRASE)) return { ok: false, error: "the page text was not in the prompt" };
    return { ok: true, reply: JSON.stringify({ description: `tiling: ${PAGE_PHRASE}`, notes: "n", subject: "s", body: "b" }) };
  };

  test("the fetched page text reaches the model prompt, and the description is built from it", async () => {
    const seen = [];
    const db = fakeDb(
      { accounts: [acct({ website: "tiles.test", source_query: SOURCE_QUERY })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    const res = await runBody(
      outreachJob({
        readSite: async (url) => {
          assert.match(url, /tiles\.test/, "the lead's own website is what is read");
          return { ok: true, text: `Home. ${PAGE_PHRASE}. Contact us.`, finalUrl: "https://tiles.test/", title: "Tiles" };
        },
        evaluate: strictEvaluator(seen),
      }),
      db,
    );
    assert.equal(res.facts.drafted, 1);
    assert.equal(seen.length, 1, "the evaluator was actually called");
    assert.ok(seen[0].includes(PAGE_PHRASE), "the page text must be in the prompt");

    const row = (await fakeRows(db, "outreach_drafts"))[0];
    assert.ok(row.business_description, "a reachable site must yield a description");
    assert.ok(row.business_description.includes(PAGE_PHRASE), "the description is derived from the page");
    assert.ok(!row.business_description.includes(SOURCE_QUERY), "never the source_query");
    assert.equal(row.site_url, "https://tiles.test/", "the page it came from is recorded");
  });

  test("source_query is labelled as provenance in the prompt, never offered as the description", async () => {
    const seen = [];
    const db = fakeDb(
      { accounts: [acct({ website: "tiles.test", source_query: SOURCE_QUERY })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    await runBody(
      outreachJob({
        readSite: async () => ({ ok: true, text: PAGE_PHRASE, finalUrl: "https://tiles.test/", title: null }),
        evaluate: strictEvaluator(seen),
      }),
      db,
    );
    const prompt = seen[0];
    const idx = prompt.indexOf(SOURCE_QUERY);
    assert.ok(idx > 0, "source_query is passed, as provenance");
    assert.match(prompt.slice(Math.max(0, idx - 90), idx), /NOT a description/i,
      "it must be labelled as NOT a description where it appears");
  });

  test("an UNREACHABLE site yields a NULL description — never one reconstructed from source_query", async () => {
    const calls = [];
    const db = fakeDb(
      { accounts: [acct({ website: "down.test", source_query: SOURCE_QUERY })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    const res = await runBody(
      outreachJob({
        readSite: async () => ({ ok: false, error: "connect ECONNREFUSED" }),
        evaluate: async (p) => { calls.push(p); return { ok: true, reply: JSON.stringify({ description: SOURCE_QUERY, subject: "s", body: "b" }) }; },
      }),
      db,
    );
    assert.equal(calls.length, 0, "no model call at all when the site could not be read");
    const row = (await fakeRows(db, "outreach_drafts"))[0];
    assert.equal(row.business_description, null);
    assert.equal(row.site_url, null);
    assert.equal(res.facts.drafted, 1, "the draft is still written, it just admits it read nothing");
  });

  test("a lead with no website on file is never fetched and gets no description", async () => {
    let fetched = 0;
    const db = fakeDb(
      { accounts: [acct({ website: null, source_query: SOURCE_QUERY })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    await runBody(
      outreachJob({ readSite: async () => { fetched += 1; return { ok: true, text: "x", finalUrl: "u", title: null }; }, evaluate: async () => ({ ok: true, reply: "{}" }) }),
      db,
    );
    assert.equal(fetched, 0, "no website means no fetch");
    assert.equal((await fakeRows(db, "outreach_drafts"))[0].business_description, null);
  });

  test("an evaluator that throws degrades to no description, not to a guess", async () => {
    const db = fakeDb(
      { accounts: [acct({ website: "t.test", source_query: SOURCE_QUERY })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    await runBody(
      outreachJob({ readSite: async () => ({ ok: true, text: "x", finalUrl: "u", title: null }), evaluate: async () => { throw new Error("model down"); } }),
      db,
    );
    const row = (await fakeRows(db, "outreach_drafts"))[0];
    assert.equal(row.business_description, null);
    assert.ok(!JSON.stringify(row).includes(SOURCE_QUERY), "source_query never leaks into a draft row");
  });
});

/* ================================================================ criterion 4 */
//
// "The sweep with zero enough_data:true segments draws every target from
//  lead_targets and invents none."

describe("C4 — the sweep never invents a territory", () => {
  const sweep = leadSweepJob();

  test("zero enough_data segments: every target is a lead_targets row and its reason says so", async () => {
    // Four accounts in one trade/town — below the 5-row floor, and a 100% win
    // rate, which is exactly the bait a broken implementation takes.
    const accounts = Array.from({ length: 4 }, () => ({ business_type: "roofer", city: "Mamaroneck", status: "won" }));
    const db = fakeDb({
      lead_targets: [
        { trade: "plumber", town: "Rye", active: true, created_at: "2026-01-01" },
        { trade: "electrician", town: "Harrison", active: true, created_at: "2026-01-02" },
      ],
      accounts,
    });
    const res = await runBody(sweep, db);
    assert.equal(res.facts.segments_with_enough_data, 0);
    assert.equal(res.facts.targets, 2);
    assert.equal(res.facts.from_lead_targets, 2, "every target came from lead_targets");
    assert.ok(!res.log.includes("roofer"), "an under-evidenced segment must not appear as a target");
    assert.match(res.log, /plumber in Rye — lead_targets/);
    assert.match(res.log, /electrician in Harrison — lead_targets/);
  });

  test("EMPTY lead_targets and zero enough_data segments yields zero targets — no fallback guess", async () => {
    const db = fakeDb({
      lead_targets: [],
      accounts: [
        { business_type: "roofer", city: "Mamaroneck", status: "won" },
        { business_type: "roofer", city: "Mamaroneck", status: "won" },
      ],
    });
    const res = await runBody(sweep, db);
    assert.equal(res.facts.targets, 0, "nothing configured and nothing earned means nothing to prospect");
    assert.equal(res.facts.from_lead_targets, 0);
    assert.deepEqual(res.findings, [], "a blank target table is a configuration gap, not a finding");
    assert.ok(!/\d+\.\s/.test(res.log), "the log must list no numbered target");
  });

  test("an entirely empty database yields zero targets", async () => {
    const res = await runBody(sweep, fakeDb({ lead_targets: [], accounts: [] }));
    assert.equal(res.facts.targets, 0);
  });

  test("inactive lead_targets rows are not swept", async () => {
    const db = fakeDb({ lead_targets: [{ trade: "plumber", town: "Rye", active: false, created_at: "2026-01-01" }], accounts: [] });
    assert.equal((await runBody(sweep, db)).facts.targets, 0);
  });

  test("once a segment EARNS it, the evidence target is still a trade/town we already have leads in", async () => {
    const accounts = Array.from({ length: 6 }, () => ({ business_type: "roofer", city: "Mamaroneck", status: "won" }));
    const db = fakeDb({ lead_targets: [{ trade: "plumber", town: "Rye", active: true, created_at: "2026-01-01" }], accounts });
    const res = await runBody(sweep, db);
    assert.equal(res.facts.segments_with_enough_data, 1);
    assert.equal(res.facts.targets, 2);
    assert.match(res.log, /roofer in Mamaroneck — roofer\/Mamaroneck is 6\/6 won/,
      "an evidence target must cite its evidence");
  });

  test("no trade or town string is hardcoded anywhere in the sweep", () => {
    const text = codeOnly(src("../lib/outreach.ts"));
    const body = text.slice(text.indexOf("export const SWEEP_JOB"));
    // Every town and trade named anywhere in this repo's fixtures/seed.
    for (const word of ["Rye", "Mamaroneck", "Harrison", "plumber", "roofer", "electrician",
                        "contractor", "restaurant", "landscaper", "dentist", "Westchester", "New Rochelle"]) {
      assert.ok(!new RegExp(`\\b${word}\\b`, "i").test(body), `the sweep must not name '${word}'`);
    }
  });
});

/* ================================================================= guardrails */

describe("guardrails — nothing sends, and the leads skill is untouched", () => {
  const outreachSrc = codeOnly(src("../lib/outreach.ts"));

  test("lib/outreach.ts contains no send path, dormant or otherwise", () => {
    for (const pattern of [
      /nodemailer/i, /\bresend\b/i, /sendgrid/i, /postmark/i, /mailgun/i, /twilio/i, /\bsmtp\b/i,
      /\bsms\b/i, /webhook/i, /send_?email/i, /sendMail/i, /\bdeliver\b/i, /mailer/i, /transport\(/i,
    ]) {
      assert.ok(!pattern.test(outreachSrc), `lib/outreach.ts must contain no ${pattern}`);
    }
  });

  test("the only network reach is the injected site READ — no bare fetch, no http client", () => {
    assert.ok(!/\bfetch\s*\(/.test(outreachSrc), "no direct fetch in lib/outreach.ts");
    assert.ok(!/require\(['"]https?['"]\)|from ['"]node:https?['"]/.test(outreachSrc), "no node http client");
    // read_site is the one reader, imported unchanged and never given
    // allowPrivateHosts.
    assert.match(outreachSrc, /import \{ read_site \} from "\.\/agent\/verbs\/read_site"/);
    assert.ok(!/allowPrivateHosts/.test(outreachSrc), "the SSRF gate is not loosened");
  });

  test("a draft row can never name a recipient or a send", async () => {
    const db = fakeDb(
      { accounts: [acct({ website: "t.test" })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    await runBody(
      outreachJob({ readSite: async () => ({ ok: true, text: "x", finalUrl: "u", title: null }), evaluate: async () => ({ ok: true, reply: '{"description":"d","subject":"s","body":"b"}' }) }),
      db,
    );
    const row = (await fakeRows(db, "outreach_drafts"))[0];
    for (const forbidden of ["to_email", "recipient", "to", "email", "sent_at", "sent", "status", "message_id"]) {
      assert.ok(!(forbidden in row), `a draft must carry no '${forbidden}'`);
    }
  });

  test("the drafting job writes to exactly two tables: outreach_drafts and (on a park) accounts + its trace", async () => {
    const db = fakeDb(
      { accounts: [acct({ website: "t.test" })], account_activity: [], outreach_drafts: [] },
      { unique: DRAFT_UNIQUE },
    );
    await runBody(
      outreachJob({ readSite: async () => ({ ok: true, text: "x", finalUrl: "u", title: null }), evaluate: async () => ({ ok: true, reply: "{}" }) }),
      db,
    );
    const writes = new Set(db.calls.filter((c) => c.ops.some(([op]) => op === "insert" || op === "update")).map((c) => c.table));
    assert.deepEqual([...writes].sort(), ["outreach_drafts"]);
  });

  test("the park's trace is an AGENT kind, so the bot cannot pause the lane it just parked", async () => {
    const db = fakeDb(
      {
        accounts: [acct({ website: "t.test" })],
        account_activity: [1, 2, 3].map(() => ({ account_id: "a", kind: "ai_email_sent" })),
        outreach_drafts: [],
      },
      { unique: DRAFT_UNIQUE },
    );
    await runBody(outreachJob({ readSite: async () => ({ ok: false, error: "x" }), evaluate: async () => ({ ok: false, error: "x" }) }), db);
    const trace = (await fakeRows(db, "account_activity")).filter((r) => r.note?.includes("no_response"));
    assert.equal(trace.length, 1);
    assert.equal(trace[0].kind, "agent_run", "an agent kind — 0015's trigger skips it");
  });

  test("nothing in this item runs the leads skill or touches its budget cap", () => {
    // No execution of, or import from, the skill — a prose mention is fine.
    for (const pattern of [
      /spawn|execFile|execSync|child_process/, /googleapis|google-auth|gspread/i, /sheets\.py/,
      /from ["'][^"']*skills\/leads/, /require\(["'][^"']*skills\/leads/,
      /process\.env\.[A-Z_]*BUDGET/, /budget_?cap\s*[=:]/i,
    ]) {
      assert.ok(!pattern.test(outreachSrc), `lib/outreach.ts must not match ${pattern}`);
    }
    // And no migration or job code alters the skill's cap: it lives outside this repo.
    assert.ok(!/leads\/SKILL\.md/.test(outreachSrc));
  });
});

/* ================================================== the trigger, real Postgres */

const MIGRATIONS = [
  "0001_core_schema.sql", "0002_rls_policies.sql", "0003_project_manual.sql",
  "0004_profiles.sql", "0005_tasks.sql", "0006_seed_clients.sql", "0007_own_tasks_only.sql",
  "0008_agent_tokens.sql", "0009_automation_schema.sql", "0010_activity_audit_trail.sql",
  "0011_inbox_unread_index.sql", "0012_email_outbox.sql", "0013_briefing_claim.sql",
  "0014_job_windows.sql", "0015_outreach_lanes.sql", "0016_pause_on_authenticated.sql",
];

const A = { ai: "dddddddd-0000-4000-8000-000000000001", won: "dddddddd-0000-4000-8000-000000000002" };

describe("C1a — the pause trigger, against real Postgres", { skip: !toolsPresent && "no local Postgres" }, () => {
  let pg;
  const modeOf = (id) => pg.run(`select outreach_mode from accounts where id='${id}'`);

  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    pg.run(`insert into accounts (id, business_name, status, outreach_mode)
            values ('${A.ai}', 'Live Lead', 'new', 'ai')`);
    pg.run(`insert into accounts (id, business_name, status, outreach_mode, deal_value_cents)
            values ('${A.won}', 'Won Client', 'won', 'ai', 100000)`);
  });
  after(() => pg?.stop());

  test("EVERY human activity kind pauses an 'ai' lead — enumerated from the CHECK, not from a list I chose", () => {
    // The kinds the column actually permits, minus the three agent ones. If a
    // future migration adds a human kind, this test covers it automatically.
    const kinds = pg
      .run(`select pg_get_constraintdef(oid) from pg_constraint
             where conrelid='account_activity'::regclass and contype='c'
               and pg_get_constraintdef(oid) like '%kind%'`)
      .match(/'[a-z_]+'::text/g)
      .map((s) => s.slice(1, s.indexOf("'", 1)));
    const human = [...new Set(kinds)].filter((k) => !["ai_email_sent", "ai_email_reply", "agent_run"].includes(k));
    assert.ok(human.length >= 4, `expected several human kinds, got ${human}`);
    for (const kind of human) {
      pg.run(`update accounts set outreach_mode='ai' where id='${A.ai}'; select 1`);
      // As `authenticated`, which is what 0016 keys the pause on and what a
      // person writing this row actually is.
      const r = pg.runClaims(
        CLAIMS.member,
        `insert into account_activity (account_id, kind) values ('${A.ai}', '${kind}');
         select outreach_mode from accounts where id='${A.ai}';`,
      );
      assert.ok(r.ok, `a member may write a '${kind}' row: ${r.error}`);
      assert.equal(r.out, "paused", `a '${kind}' row must pause the lane`);
    }
  });

  test("a MEMBER's own write through RLS pauses the lane, inside their own transaction", () => {
    pg.run(`update accounts set outreach_mode='ai' where id='${A.ai}'; select 1`);
    const r = pg.runClaims(
      CLAIMS.member,
      `insert into account_activity (account_id, kind, note) values ('${A.ai}', 'call', 'rang them');
       select outreach_mode from accounts where id='${A.ai}';`,
    );
    assert.ok(r.ok, `a member may log a call: ${r.error}`);
    assert.equal(r.out, "paused", "the pause must land on the member's own write");
  });

  test("the three AGENT kinds never pause a lane — the bot cannot pause itself", () => {
    for (const kind of ["ai_email_sent", "ai_email_reply", "agent_run"]) {
      pg.run(`update accounts set outreach_mode='ai' where id='${A.ai}'; select 1`);
      pg.run(`insert into account_activity (account_id, kind) values ('${A.ai}', '${kind}')`);
      assert.equal(modeOf(A.ai), "ai", `a '${kind}' row must leave the lane alone`);
    }
  });

  test("a fourth touch is refused by the database, whatever the job believes", () => {
    pg.run(`delete from outreach_drafts where account_id='${A.ai}'`);
    for (const n of [1, 2, 3]) {
      const r = pg.tryRun(`insert into outreach_drafts (account_id, touch_number, subject, body)
                           values ('${A.ai}', ${n}, 's', 'b')`);
      assert.ok(r.ok, `touch ${n} must be writable: ${r.error}`);
    }
    const fourth = pg.tryRun(`insert into outreach_drafts (account_id, touch_number, subject, body)
                              values ('${A.ai}', 4, 's', 'b')`);
    assert.equal(fourth.ok, false, "there is no fourth touch");
    assert.match(fourth.error, /touch_number/);
    const dup = pg.tryRun(`insert into outreach_drafts (account_id, touch_number, subject, body)
                           values ('${A.ai}', 2, 's', 'b')`);
    assert.equal(dup.ok, false, "and the same touch cannot be drafted twice");
  });

  test("the trigger function is SECURITY DEFINER with a pinned search_path", () => {
    const row = pg.run(
      `select p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), 'none')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='pause_outreach_on_human_activity'`,
    );
    assert.match(row.split("|")[0], /^(t|true)$/, "the pause must not depend on the writer's own UPDATE policy");
    assert.match(row, /search_path=/);
  });

  test("a 'won' account in the ai lane pauses like any other — and is still never selectable by the job", () => {
    const r = pg.runClaims(
      CLAIMS.member,
      `insert into account_activity (account_id, kind) values ('${A.won}', 'note');
       select outreach_mode from accounts where id='${A.won}';`,
    );
    assert.ok(r.ok, `a member may log a note: ${r.error}`);
    assert.equal(r.out, "paused");
    // And the job's own predicate, run as SQL: no won/human/paused/no_response row.
    pg.run(`update accounts set outreach_mode='ai' where id='${A.won}'; select 1`);
    const selectable = pg.run(
      `select coalesce(string_agg(id::text, ','), '') from accounts
        where outreach_mode='ai' and status in ('new','attempted','reached','consult_scheduled','consult_done')`,
    );
    assert.ok(!selectable.includes(A.won), "a won account is out of scope whatever its lane");
  });

  test("outreach_drafts' policies do not mask each other — staff read is real, member write is refused on all four verbs", () => {
    const policies = pg.run(
      `select string_agg(policyname || ':' || cmd || ':' || permissive, ' | ' order by policyname)
         from pg_policies where tablename='outreach_drafts'`,
    );
    assert.equal(
      policies,
      "outreach_drafts_admin_all:ALL:PERMISSIVE | outreach_drafts_staff_select:SELECT:PERMISSIVE",
      "exactly two policies, and the staff one is SELECT-only",
    );
    pg.run(`delete from outreach_drafts where account_id='${A.ai}'`);
    pg.run(`insert into outreach_drafts (account_id, touch_number, subject, body)
            values ('${A.ai}', 1, 's', 'b')`);
    // The staff SELECT policy is load-bearing: a member is not an admin.
    const read = pg.runClaims(CLAIMS.member, `select count(*) from outreach_drafts;`);
    assert.ok(read.ok && Number(read.out) >= 1, `a member must read drafts: ${read.error}`);
    for (const [verb, sql] of [
      ["insert", `insert into outreach_drafts (account_id, touch_number, subject, body) values ('${A.ai}', 2, 'f', 'f');`],
      ["update", `update outreach_drafts set subject='f' where account_id='${A.ai}';`],
      ["delete", `delete from outreach_drafts where account_id='${A.ai}';`],
    ]) {
      const r = pg.runClaims(CLAIMS.member, `${sql} select count(*) from outreach_drafts;`);
      if (verb === "insert") assert.equal(r.ok, false, "a member must not forge a draft");
      // update/delete silently affect 0 rows under RLS rather than erroring.
      else assert.ok(!r.ok || Number(r.out) >= 1, `a member's ${verb} must change nothing`);
    }
    const stillThere = pg.run(`select subject from outreach_drafts where account_id='${A.ai}' and touch_number=1`);
    assert.equal(stillThere, "s", "no member write landed");
  });
});

/** Read a fake-db table's current rows. */
async function fakeRows(db, table) {
  const { data } = await db.from(table).select("*");
  return data ?? [];
}
