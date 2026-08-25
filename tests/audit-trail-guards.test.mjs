/**
 * audit-trail-guards.test.mjs — the app-side half of the audit-trail fixes.
 *
 * The database is the boundary (tests/activity-audit-trail-migration.test.mjs
 * proves that). This file covers what the database cannot: that the app fails
 * READABLY and early, that the two writes which violated the kind CHECK at
 * runtime no longer do, that the task-close nudge actually fires for the common
 * case, and that the free-text parse reaches the CLI with no tools at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { logActivity, InvalidInputError } from "../lib/accounts.ts";
import { AGENT_KINDS, HUMAN_KINDS } from "../lib/agent/verbs/activity_query.ts";
import { log_activity } from "../lib/agent/verbs/index.ts";
import { nudgeTaskClose, TASK_CLOSE_NUDGE_KIND } from "../lib/agent/task-nudge.ts";
import { updateTaskStatusIfNot } from "../lib/tasks.ts";
import { buildArgs, NO_TOOLS } from "../lib/agent/runner.ts";
import { fakeDb } from "./helpers/fake-db.mjs";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const ACCT = "11111111-1111-4111-8111-111111111111";
const TASK = "44444444-4444-4444-8444-444444444444";
const MEMBER = {
  profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  email: "brandon@bcn-services.com",
  role: "member",
};
const ADMIN = {
  profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "nate@bcn-services.com",
  role: "admin",
};

/* ================================ 1. the one shared insert refuses the rest == */

describe("logActivity is the single guard every caller passes through", () => {
  for (const kind of AGENT_KINDS) {
    test(`refuses the agent kind '${kind}', and writes nothing`, async () => {
      const db = fakeDb({ account_activity: [] });
      await assert.rejects(
        () => logActivity(db, { accountId: ACCT, kind }),
        InvalidInputError,
      );
      assert.equal(
        db.calls.filter((c) => c.table === "account_activity").length, 0,
        "an agent kind reached the insert",
      );
    });
  }

  // The two kinds app/leads/actions.ts used to send. Neither is in the CHECK,
  // so both failed at the database AFTER the account had already been changed.
  for (const kind of ["stage", "assign", "whatever"]) {
    test(`refuses the unknown kind '${kind}'`, async () => {
      const db = fakeDb({ account_activity: [] });
      await assert.rejects(() => logActivity(db, { accountId: ACCT, kind }), InvalidInputError);
    });
  }

  for (const kind of HUMAN_KINDS) {
    test(`still writes the human kind '${kind}'`, async () => {
      const db = fakeDb({ account_activity: [] });
      await logActivity(db, { accountId: ACCT, kind, note: "n" });
      assert.equal(db.calls.filter((c) => c.table === "account_activity").length, 1);
    });
  }
});

describe("the lead actions send kinds the CHECK permits", () => {
  const actions = src("app/leads/actions.ts");

  test("no 'stage' or 'assign' kind is sent any more", () => {
    assert.doesNotMatch(actions, /kind:\s*"stage"/);
    assert.doesNotMatch(actions, /kind:\s*"assign"/);
  });

  test("a stage move logs status_change and a reassignment logs note", () => {
    assert.match(actions, /kind:\s*"status_change"/);
    assert.match(actions, /kind:\s*"note"/);
  });

  test("a failed log after a committed change says the change landed", () => {
    // The ordering fix: the account has already moved by the time the log runs,
    // so the failure text has to say so instead of surfacing a driver string.
    assert.match(actions, /could not be logged/);
    assert.match(actions, /logAfterChange/);
  });

  test("the CHECK was not widened to accommodate the old values", () => {
    const migration = src("supabase/migrations/0009_automation_schema.sql");
    assert.doesNotMatch(migration, /'stage'/);
    assert.doesNotMatch(migration, /'assign'/);
  });
});

/* ============================================ 2. the nudge that never fired == */

describe("the task-close nudge reaches the assignee, not just self-closers", () => {
  const task = (over = {}) => ({
    id: TASK,
    title: "Call Coventry back",
    account_id: ACCT,
    assigned_to: ADMIN.profileId,
    status: "done",
    ...over,
  });

  test("a member closing SOMEONE ELSE's task still posts the nudge", async () => {
    const serviceDb = fakeDb({ inbox_items: [] });
    const posted = await nudgeTaskClose({
      serviceDb,
      caller: MEMBER,
      task: task(),
      previousStatus: "doing",
    });
    assert.equal(posted, true, "the nudge was refused for the most common case");
    const rows = serviceDb.calls.filter((c) => c.table === "inbox_items");
    assert.equal(rows.length, 1);
  });

  test("the recipient is the ASSIGNEE — never the closer, never anyone else", async () => {
    const inbox = [];
    const serviceDb = fakeDb({ inbox_items: inbox });
    await nudgeTaskClose({ serviceDb, caller: MEMBER, task: task(), previousStatus: "todo" });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].profile_id, ADMIN.profileId);
    assert.equal(inbox[0].kind, TASK_CLOSE_NUDGE_KIND);
    assert.notEqual(inbox[0].profile_id, MEMBER.profileId);
  });

  test("an unassigned task still posts nothing — there is nobody to ask", async () => {
    const inbox = [];
    const serviceDb = fakeDb({ inbox_items: inbox });
    const posted = await nudgeTaskClose({
      serviceDb,
      caller: MEMBER,
      task: task({ assigned_to: null }),
      previousStatus: "todo",
    });
    assert.equal(posted, false);
    assert.equal(inbox.length, 0);
  });

  test("a re-save of an already-done task still posts nothing", async () => {
    const inbox = [];
    const serviceDb = fakeDb({ inbox_items: inbox });
    assert.equal(
      await nudgeTaskClose({ serviceDb, caller: ADMIN, task: task(), previousStatus: "done" }),
      false,
    );
    assert.equal(inbox.length, 0);
  });
});

/* ================================== 3. one close, one nudge, under a race ==== */

describe("closing a task is a conditional write, not read-then-update", () => {
  const rows = () => [
    { id: TASK, title: "Call Coventry back", account_id: ACCT, assigned_to: ADMIN.profileId, status: "doing" },
  ];

  test("the first close gets the row back", async () => {
    const tasks = rows();
    const got = await updateTaskStatusIfNot(fakeDb({ tasks }), TASK, "done", "done");
    assert.ok(got, "the open task did not come back from the update");
    assert.equal(tasks[0].status, "done");
  });

  test("the second close gets nothing back, so it cannot nudge again", async () => {
    const tasks = rows();
    tasks[0].status = "done";
    const got = await updateTaskStatusIfNot(fakeDb({ tasks }), TASK, "done", "done");
    assert.equal(got, null, "an already-closed task matched the update — both closes would nudge");
  });

  test("the filter is in the statement, not in a prior read", async () => {
    const db = fakeDb({ tasks: rows() });
    await updateTaskStatusIfNot(db, TASK, "done", "done");
    const ops = db.calls.find((c) => c.table === "tasks").ops.map((o) => o[0]);
    assert.ok(ops.includes("neq"), `expected a neq filter on the update; got ${ops.join(",")}`);
  });

  test("the board's close path uses it", () => {
    assert.match(src("app/tasks/actions.ts"), /updateTaskStatusIfNot\(/);
  });
});

/* ========================== 4. a capacity answer is not a reading failure ==== */

describe("log_activity distinguishes a busy runner from unreadable words", () => {
  const ctx = (runParse) => ({
    caller: MEMBER,
    db: fakeDb({ account_activity: [] }),
    runParse,
  });
  const parse = { accountId: ACCT, text: "called Mike", timeZone: "America/New_York" };

  test("busy comes back as `busy`", async () => {
    const res = await log_activity.run(
      ctx(async () => ({ ok: false, error: "the agent is busy — 2 runs already in flight", busy: true })),
      parse,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "busy");
  });

  test("a timeout comes back as `timeout`", async () => {
    const res = await log_activity.run(
      ctx(async () => ({ ok: false, error: "agent timed out after 45000ms", timedOut: true })),
      parse,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "timeout");
  });

  test("a genuine reading failure is still parse_failure", async () => {
    const res = await log_activity.run(
      ctx(async () => ({ ok: false, error: "agent returned no result text" })),
      parse,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "parse_failure");
  });

  test("the capture box words the busy case separately", () => {
    const ui = src("app/activity-capture.tsx");
    assert.match(ui, /code === "busy"/);
    assert.match(ui, /busy right now/i);
  });

  test("the double-submit latch is a ref, not the render's `busy`", () => {
    const ui = src("app/activity-capture.tsx");
    assert.match(ui, /useRef\(false\)/);
    assert.match(ui, /inFlight\.current/);
  });
});

/* =========================== 5. the parse run carries no tools at all ======== */

describe("the free-text parse is a text job with no tools", () => {
  test("NO_TOOLS puts an empty --tools on the command line", () => {
    const args = buildArgs({ tools: NO_TOOLS });
    assert.equal(args[args.indexOf("--tools") + 1], "", "the parse run still had tools");
  });

  test("an ordinary run keeps the default tool set", () => {
    const args = buildArgs({});
    assert.match(args[args.indexOf("--tools") + 1], /Read,Edit,Write,Glob,Grep,Skill/);
  });

  test("the capture endpoint passes NO_TOOLS", () => {
    assert.match(src("app/activity/actions.ts"), /tools:\s*NO_TOOLS/);
  });
});

/* ============================== 6. the rest of the submitted payload ========= */

describe("commitActivity caps what a browser can send", () => {
  const actions = src("app/activity/actions.ts");

  test("outcome is capped, like the note", () => {
    assert.match(actions, /MAX_OUTCOME_CHARS/);
    assert.match(actions, /outcome:.*slice\(0, MAX_OUTCOME_CHARS\)/);
  });

  test("a date beyond now is refused", () => {
    assert.match(actions, /Date\.parse\(occurredAt\) > Date\.now\(\)/);
    assert.match(actions, /in the future/);
  });
});

/* ======================== 7. the verb says what it actually requires ========= */

test("log_activity's description carries the either/or `required` cannot", () => {
  const d = log_activity.description;
  assert.match(d, /REQUIRED/);
  assert.match(d, /accountId.*clientId/s);
  assert.match(d, /kind.*text/s);
  // The handler demands them; JSON Schema `required` here cannot express an
  // either/or, which is exactly why the rule has to live in the description.
  const schema = log_activity.schema.input_schema ?? log_activity.schema.parameters;
  assert.deepEqual(schema.required, []);
  assert.match(schema.description ?? log_activity.schema.description, /REQUIRED/);
});
