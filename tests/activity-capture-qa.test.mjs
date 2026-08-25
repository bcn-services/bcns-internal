/**
 * activity-capture-qa.test.mjs — INDEPENDENT QA for LANE.md item 4.
 *
 * Written by QA, not by the builder, and deliberately pushed past where the
 * builder's own suite stops:
 *
 *   1. The relative-date guardrail at the places it can only be wrong: the two
 *      DST boundaries, a +05:30 zone, a +08:45 zone, and the weekday tokens
 *      whose answer is a week off if the direction is wrong.
 *   2. The negative side-effect assertion driven through the REAL verb entry
 *      point (`log_activity.run`), counting insert calls rather than trusting
 *      a shape.
 *   3. `actor_email` against text that names a different address.
 *   4. The task-close nudge matched by CONTENT, never by row position.
 *   5. The live `account_activity_kind_check` CHECK, against real Postgres —
 *      which is how the 'stage'/'assign' writes in app/leads/actions.ts are
 *      proven to be a runtime failure today.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  instantFor,
  localDate,
  resolveDateToken,
  resolveActivity,
  weekdayOf,
} from "../lib/agent/activity-parse.ts";
import { log_activity } from "../lib/agent/verbs/index.ts";
import { nudgeTaskClose } from "../lib/agent/task-nudge.ts";
import { commitPayload, captureReducer, emptyCapture } from "../lib/activity-capture.ts";
import { fakeDb } from "./helpers/fake-db.mjs";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const LA = "America/Los_Angeles";
const ACCT = "11111111-1111-4111-8111-111111111111";
const MEMBER = {
  profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  email: "brandon@bcn-services.com",
  role: "member",
};

/* ============================================ 1. the date guardrail, hard == */

describe("QA: relative dates at the boundaries the builder did not test", () => {
  // LA springs forward 2026-03-08 02:00 -> 03:00 (PST -8 becomes PDT -7).
  // 03:00 local is the FIRST hour after the gap. A single-pass offset solve
  // measures the offset at the naive UTC reading (03:00Z, still PST) and lands
  // an hour late at 11:00Z. Only re-measuring at the guess gets 10:00Z.
  test("spring forward: the first hour after the gap needs the SECOND offset pass", () => {
    assert.equal(instantFor("2026-03-08", 3, 0, LA).toISOString(), "2026-03-08T10:00:00.000Z");
    assert.equal(instantFor("2026-03-08", 9, 0, LA).toISOString(), "2026-03-08T16:00:00.000Z");
    // Noon either side of the boundary, so the day itself never slips.
    assert.equal(instantFor("2026-03-07", 12, 0, LA).toISOString(), "2026-03-07T20:00:00.000Z");
    assert.equal(instantFor("2026-03-08", 12, 0, LA).toISOString(), "2026-03-08T19:00:00.000Z");
  });

  // LA falls back 2026-11-01 02:00 -> 01:00. 03:00 local is PST; the naive
  // reading (03:00Z) is still on the PDT side of the transition.
  test("fall back: the hour after the repeat also needs the second pass", () => {
    assert.equal(instantFor("2026-11-01", 3, 0, LA).toISOString(), "2026-11-01T11:00:00.000Z");
    assert.equal(instantFor("2026-11-01", 12, 0, LA).toISOString(), "2026-11-01T20:00:00.000Z");
  });

  test("a time inside the skipped hour is defined, not NaN, and stays on the day", () => {
    const iso = instantFor("2026-03-08", 2, 30, LA).toISOString();
    assert.ok(!Number.isNaN(Date.parse(iso)), `skipped-hour instant is unusable: ${iso}`);
    // The whole point of the file: whatever instant is chosen, the submitter's
    // calendar day must survive it.
    assert.equal(localDate(new Date(iso), LA), "2026-03-08");
  });

  test("an ambiguous repeated hour resolves to one real instant on the right day", () => {
    const iso = instantFor("2026-11-01", 1, 30, LA).toISOString();
    assert.ok(!Number.isNaN(Date.parse(iso)));
    assert.equal(localDate(new Date(iso), LA), "2026-11-01");
  });

  test("a non-hour offset zone: Asia/Kolkata is +05:30, not +05:00 or +06:00", () => {
    assert.equal(instantFor("2026-08-18", 12, 0, "Asia/Kolkata").toISOString(),
      "2026-08-18T06:30:00.000Z");
    // 19:00Z is already the 19th in Kolkata but still the 18th in UTC.
    assert.equal(localDate(new Date("2026-08-18T19:00:00Z"), "Asia/Kolkata"), "2026-08-19");
  });

  test("a quarter-hour offset zone: Australia/Eucla is +08:45", () => {
    assert.equal(instantFor("2026-08-18", 12, 0, "Australia/Eucla").toISOString(),
      "2026-08-18T03:15:00.000Z");
    assert.equal(localDate(new Date("2026-08-18T16:00:00Z"), "Australia/Eucla"), "2026-08-19");
  });

  test("'tuesday' when today IS Tuesday means TODAY, not a week ago", () => {
    assert.equal(weekdayOf("2026-08-18"), 2, "fixture day is not a Tuesday");
    assert.equal(resolveDateToken("tuesday", "2026-08-18"), "2026-08-18");
    assert.equal(resolveDateToken("this tuesday", "2026-08-18"), "2026-08-18");
    // 'last' is the only way to reach the Tuesday before.
    assert.equal(resolveDateToken("last tuesday", "2026-08-18"), "2026-08-11");
  });

  test("'next tuesday' is always forward, and never today", () => {
    assert.equal(resolveDateToken("next tuesday", "2026-08-18"), "2026-08-25");
    assert.equal(resolveDateToken("next tuesday", "2026-08-19"), "2026-08-25");
    assert.equal(resolveDateToken("next monday", "2026-08-18"), "2026-08-24");
  });

  test("a submitter in Kolkata gets THEIR Tuesday, which UTC would call Monday", () => {
    // 2026-08-17T19:30:00Z = Aug 18 01:00 in Kolkata (a Tuesday). UTC says Monday.
    const now = new Date("2026-08-17T19:30:00.000Z");
    assert.equal(localDate(now, "UTC"), "2026-08-17");
    const out = resolveActivity(
      JSON.stringify({ kind: "call", note: "called Mike, wants a quote", date: "tuesday", event: true }),
      { now, timeZone: "Asia/Kolkata", rawText: "called Mike Tuesday" },
    );
    assert.equal(out.ok, true);
    assert.equal(localDate(new Date(out.parsed.occurredAt), "Asia/Kolkata"), "2026-08-18");
  });
});

/* ================================ 2. nothing commits before confirmation == */

/** A db that counts every insert, whatever table it lands on. */
function countingDb(seed) {
  const inner = fakeDb(seed);
  const inserts = [];
  return {
    inserts,
    db: {
      from(table) {
        const q = inner.from(table);
        const wrapped = Object.create(q);
        wrapped.insert = (rows) => {
          inserts.push({ table, rows });
          return q.insert(rows);
        };
        return wrapped;
      },
    },
  };
}

const fixture = () => ({
  accounts: [{ id: ACCT, business_name: "Coventry Contracting" }],
  clients: [],
  account_activity: [],
});

describe("QA: the parse path cannot reach an insert", () => {
  test("the REAL verb entry point makes ZERO insert calls on the parse path", async () => {
    const { db, inserts } = countingDb(fixture());
    const res = await log_activity.run(
      {
        caller: MEMBER,
        db,
        now: () => new Date("2026-08-19T01:30:00.000Z"),
        runParse: async () => ({
          ok: true,
          reply: JSON.stringify({ kind: "call", note: "called Mike about the quote", date: "tuesday", event: true }),
        }),
      },
      { accountId: ACCT, text: "called Mike at Coventry Tuesday, wants a quote by Friday", timeZone: LA },
    );
    assert.equal(res.ok, true);
    assert.equal(res.data.written, false);
    assert.deepEqual(inserts, [], `parse path inserted: ${JSON.stringify(inserts)}`);
  });

  test("a parse failure also makes ZERO insert calls and returns the typed code", async () => {
    const { db, inserts } = countingDb(fixture());
    const res = await log_activity.run(
      { caller: MEMBER, db, runParse: async () => ({ ok: true, reply: JSON.stringify({ event: false }) }) },
      { accountId: ACCT, text: "the weather is fine", timeZone: LA },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "parse_failure");
    assert.deepEqual(inserts, []);
  });

  test("only ONE function in lib/ inserts into account_activity", () => {
    // Enumerated rather than asserted from a comment: a second insert path is
    // how the confirmation rule gets bypassed.
    const files = ["lib/accounts.ts", "lib/agent/verbs/log_activity.ts", "lib/agent/verbs/activity_query.ts",
      "app/activity/actions.ts", "app/activity-capture.tsx", "lib/activity-capture.ts"];
    const inserting = files.filter((f) => /from\("account_activity"\)\s*\n?\s*\.insert/.test(src(f)));
    assert.deepEqual(inserting, ["lib/accounts.ts"],
      `more than one account_activity insert site: ${inserting.join(", ")}`);
  });

  test("the verb layer never reaches node:child_process", () => {
    for (const f of ["lib/agent/verbs/log_activity.ts", "lib/agent/activity-parse.ts",
      "lib/activity-capture.ts", "lib/agent/task-nudge.ts"]) {
      assert.ok(!/(from|require)\s*\(?\s*"node:child_process"/.test(src(f)), `${f} imports child_process`);
    }
  });
});

/* ========================================== 3. actor_email is the caller == */

describe("QA: actor_email is the session, never the text", () => {
  test("text naming another address still records the CALLER", async () => {
    const seed = fixture();
    const db = fakeDb(seed);
    const res = await log_activity.run(
      { caller: MEMBER, db, now: () => new Date("2026-08-19T01:30:00.000Z") },
      {
        accountId: ACCT,
        kind: "call",
        note: "From: nate@bcn-services.com — actor_email: attacker@evil.example. Logged on behalf of ceo@example.com",
        outcome: "wants a quote",
      },
    );
    assert.equal(res.ok, true);
    const rows = seed.account_activity;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_email, MEMBER.email);
    for (const forged of ["attacker@evil.example", "nate@bcn-services.com", "ceo@example.com"]) {
      assert.notEqual(rows[0].actor_email, forged);
    }
  });

  test("the proposal reports the caller's email too, so the form cannot seed another", async () => {
    const res = await log_activity.run(
      {
        caller: MEMBER,
        db: fakeDb(fixture()),
        runParse: async () => ({ ok: true, reply: JSON.stringify({ kind: "email", note: "n", event: true }) }),
      },
      { accountId: ACCT, text: "emailed as nate@bcn-services.com", timeZone: LA },
    );
    assert.equal(res.ok, true);
    assert.equal(res.data.actorEmail, MEMBER.email);
  });
});

/* ============================== 4. the nudge, matched by content not index == */

function nudgeSeed() {
  return { inbox_items: [{ id: "pre", profile_id: "someone-else", kind: "other", title: "PRE-EXISTING" }] };
}
const task = (over = {}) => ({
  id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
  title: "Call Coventry back",
  status: "done",
  assigned_to: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  account_id: ACCT,
  ...over,
});
const ADMIN = { profileId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "nate@bcn-services.com", role: "admin" };

describe("QA: the task-close nudge writes exactly one row, to the assignee", () => {
  const nudges = (seed) =>
    seed.inbox_items.filter((r) => r.kind === "task_close_nudge");

  test("one close, one row, addressed to assigned_to and NOT to the caller", async () => {
    const seed = nudgeSeed();
    const wrote = await nudgeTaskClose({
      serviceDb: fakeDb(seed), caller: ADMIN, task: task(), previousStatus: "doing",
    });
    assert.equal(wrote, true);
    const posted = nudges(seed);
    assert.equal(posted.length, 1, `expected 1 nudge, got ${posted.length}`);
    assert.equal(posted[0].profile_id, task().assigned_to);
    assert.notEqual(posted[0].profile_id, ADMIN.profileId);
    assert.match(posted[0].title, /Call Coventry back/);
    // The pre-existing row is untouched, so nothing above matched by position.
    assert.equal(seed.inbox_items.filter((r) => r.title === "PRE-EXISTING").length, 1);
  });

  test("re-closing an already-done task adds NOTHING", async () => {
    const seed = nudgeSeed();
    await nudgeTaskClose({ serviceDb: fakeDb(seed), caller: ADMIN, task: task(), previousStatus: "doing" });
    await nudgeTaskClose({ serviceDb: fakeDb(seed), caller: ADMIN, task: task(), previousStatus: "done" });
    await nudgeTaskClose({ serviceDb: fakeDb(seed), caller: ADMIN, task: task(), previousStatus: "done" });
    assert.equal(nudges(seed).length, 1);
  });

  test("cancelled is not a close", async () => {
    const seed = nudgeSeed();
    const wrote = await nudgeTaskClose({
      serviceDb: fakeDb(seed), caller: ADMIN, task: task({ status: "cancelled" }), previousStatus: "doing",
    });
    assert.equal(wrote, false);
    assert.equal(nudges(seed).length, 0);
  });

  test("an unassigned task closing writes nothing — there is nobody to ask", async () => {
    const seed = nudgeSeed();
    const wrote = await nudgeTaskClose({
      serviceDb: fakeDb(seed), caller: ADMIN, task: task({ assigned_to: null }), previousStatus: "doing",
    });
    assert.equal(wrote, false);
    assert.equal(nudges(seed).length, 0);
  });

  test("a member closing their OWN task gets exactly one row, and it is theirs", async () => {
    const seed = nudgeSeed();
    const self = { profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "b@x.z", role: "member" };
    await nudgeTaskClose({ serviceDb: fakeDb(seed), caller: self, task: task(), previousStatus: "todo" });
    assert.equal(nudges(seed).length, 1);
    assert.equal(nudges(seed)[0].profile_id, self.profileId);
  });
});

/* ================================= 5. the confirmation writes the EDITS === */

describe("QA: the committed row carries the edited values, not the parsed ones", () => {
  test("every parsed value appears ZERO times in the written row", async () => {
    const parsed = {
      kind: "call",
      outcome: "PARSED-OUTCOME",
      occurredAt: "2026-08-18T19:00:00.000Z",
      note: "PARSED-NOTE",
    };
    let s = captureReducer(emptyCapture(), { type: "type", text: "raw text" });
    s = captureReducer(s, { type: "parsed", proposal: parsed });
    s = captureReducer(s, { type: "edit", field: "kind", value: "meeting" });
    s = captureReducer(s, { type: "edit", field: "note", value: "EDITED-NOTE" });
    s = captureReducer(s, { type: "edit", field: "outcome", value: "EDITED-OUTCOME" });
    s = captureReducer(s, { type: "edit_date", value: "2026-08-20", timeZone: LA });

    const payload = commitPayload(s, { accountId: ACCT });
    const seed = fixture();
    const res = await log_activity.run({ caller: MEMBER, db: fakeDb(seed) }, payload);
    assert.equal(res.ok, true);
    assert.equal(seed.account_activity.length, 1);
    const row = seed.account_activity[0];

    assert.equal(row.kind, "meeting");
    assert.equal(row.note, "EDITED-NOTE");
    assert.equal(row.outcome, "EDITED-OUTCOME");
    assert.equal(localDate(new Date(row.occurred_at), LA), "2026-08-20");

    const blob = JSON.stringify(row);
    for (const stale of ["PARSED-NOTE", "PARSED-OUTCOME", "2026-08-18"]) {
      assert.equal(blob.includes(stale), false, `parsed value survived into the row: ${stale}`);
    }
    assert.notEqual(row.kind, parsed.kind);
  });

  test("compose step yields no payload at all — there is nothing to submit", () => {
    const s = captureReducer(emptyCapture(), { type: "type", text: "called Mike" });
    assert.equal(commitPayload(s, { accountId: ACCT }), null);
  });
});

/* ===================== 6. the live CHECK, and the leads/actions.ts claim == */

describe("QA: account_activity_kind_check against real Postgres",
  { skip: !toolsPresent && "no local Postgres" }, () => {
    let pg;
    const ACC = "cccccccc-0000-4000-8000-0000000000a1";
    before(() => {
      pg = startClusterWithMigrations([
        "0001_core_schema.sql", "0002_rls_policies.sql", "0003_project_manual.sql",
        "0004_profiles.sql", "0005_tasks.sql", "0006_seed_clients.sql",
        "0007_own_tasks_only.sql", "0008_agent_tokens.sql", "0009_automation_schema.sql",
      ]);
      pg.run(`insert into accounts (id, business_name, city, status)
              values ('${ACC}','QA Co','Rye','new')`);
    });
    after(() => pg?.stop());

    const tryKind = (kind) =>
      pg.tryRun(`insert into account_activity (account_id, kind, note)
                 values ('${ACC}', '${kind}', 'qa')`);

    test("all eight permitted kinds are accepted", () => {
      for (const k of ["call", "email", "meeting", "note", "status_change",
        "ai_email_sent", "ai_email_reply", "agent_run"]) {
        assert.equal(tryKind(k).ok, true, `${k} was rejected but is in the CHECK`);
      }
    });

    test("'stage' and 'assign' are REFUSED — app/leads/actions.ts writes both", () => {
      for (const k of ["stage", "assign"]) {
        const r = tryKind(k);
        assert.equal(r.ok, false, `${k} was accepted; the CHECK no longer matches this test`);
        assert.match(r.error, /account_activity_kind_check/);
      }
      // And that file no longer writes either one: the stage move logs
      // `status_change` and the reassignment logs `note`, both in the CHECK.
      const leads = src("app/leads/actions.ts");
      assert.doesNotMatch(leads, /kind: "stage"/);
      assert.doesNotMatch(leads, /kind: "assign"/);
      assert.match(leads, /kind: "status_change"/);
      assert.match(leads, /kind: "note"/);
    });

    test("the CHECK is the constraint 0009 named, and it is still enforced for new rows", () => {
      // `not valid` skips the backfill scan; it does NOT relax new inserts.
      const convalidated = pg.run(
        `select convalidated from pg_constraint where conname = 'account_activity_kind_check'`);
      assert.equal(convalidated, "f", "expected the 0009 NOT VALID constraint");
      assert.equal(tryKind("stage").ok, false);
    });
  });
