/**
 * tasks-data-layer.test.mjs — lib/tasks.ts and lib/profiles.ts against a fake
 * Supabase client.
 *
 * The database's own rules (RLS, CHECK constraints, foreign keys) are proven
 * separately against a real Postgres. This file proves the layer ABOVE that:
 * bad input is rejected before a query is ever built, each function issues the
 * query shape it claims to, and — the one that only bites against a real
 * database — the embedded select disambiguates the two `profiles` foreign keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATUSES, OPEN_STATUSES, isTaskStatus,
  listTasks, createTask, updateTaskStatus, assignTask,
} from "../lib/tasks.ts";
import { listProfiles, getProfile } from "../lib/profiles.ts";

/**
 * tsx loads "./accounts" (from lib/) and "../lib/accounts.ts" (from here) as two
 * separate module records, so the InvalidInputError classes are not the same
 * object. Match on the name, exactly as tests/manual-layer.test.mjs does.
 */
const isInvalidInput = (e) => e.name === "InvalidInputError";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

/** Fake client. Records every call, returns whatever the test queued. */
function fakeDb(responses = {}) {
  const calls = [];
  const builder = (table) => {
    const rec = { table, ops: [] };
    calls.push(rec);
    const b = {
      then: undefined,
      select: (cols) => (rec.ops.push(["select", cols]), b),
      insert: (row) => (rec.ops.push(["insert", row]), b),
      update: (row) => (rec.ops.push(["update", row]), b),
      eq: (col, val) => (rec.ops.push(["eq", col, val]), b),
      in: (col, vals) => (rec.ops.push(["in", col, vals]), b),
      // Chainable, unlike the accounts fake: listTasks orders on two columns.
      order: (col, o) => (rec.ops.push(["order", col, o]), b),
      single: () => (rec.ops.push(["single"]), settle()),
      maybeSingle: () => (rec.ops.push(["maybeSingle"]), settle()),
    };
    const settle = () => {
      const key = `${table}.${rec.ops.map((o) => o[0]).join(".")}`;
      const r = responses[key] ?? responses[table] ?? { data: [], error: null };
      return Promise.resolve(r);
    };
    b.then = (res, rej) => settle().then(res, rej);
    return b;
  };
  return { from: builder, calls };
}

const opOf = (call, name) => call.ops.find((o) => o[0] === name);

test("status vocabulary matches the database CHECK constraint", () => {
  assert.deepEqual([...TASK_STATUSES], ["todo", "doing", "done", "cancelled"]);
  assert.deepEqual([...OPEN_STATUSES], ["todo", "doing"]);
  assert.ok(isTaskStatus("doing"));
  assert.ok(!isTaskStatus("Doing"));
  assert.ok(!isTaskStatus("blocked"));
});

test("the embedded select disambiguates the two profiles foreign keys", async () => {
  const db = fakeDb({ tasks: { data: [], error: null } });
  await listTasks(db);
  const cols = opOf(db.calls[0], "select")[1];
  // `tasks` has FKs assigned_to AND created_by into `profiles`; a bare
  // `profiles(...)` embed is ambiguous and PostgREST 300s at runtime.
  assert.ok(
    cols.includes("assignee:profiles!tasks_assigned_to_fkey(display_name)"),
    `profile embed must name the FK constraint, got: ${cols}`,
  );
  assert.ok(
    !/(^|[^!])\bprofiles\(/.test(cols),
    `no unqualified profiles embed allowed, got: ${cols}`,
  );
  // Exactly one FK from tasks to accounts, so no hint is needed there.
  assert.ok(cols.includes("account:accounts(business_name)"), cols);
});

test("listTasks orders by due date nulls last, then created_at", async () => {
  const db = fakeDb({ tasks: { data: [], error: null } });
  await listTasks(db);
  const orders = db.calls[0].ops.filter((o) => o[0] === "order");
  assert.deepEqual(orders, [
    ["order", "due_date", { ascending: true, nullsFirst: false }],
    ["order", "created_at", { ascending: true }],
  ]);
});

test("listTasks combines assignee, account, status and openOnly filters", async () => {
  const db = fakeDb({ tasks: { data: [], error: null } });
  await listTasks(db, { assignedTo: ID, accountId: ID2, status: "todo" });
  const [byAssignee] = db.calls;
  assert.equal(byAssignee.table, "tasks");
  assert.deepEqual(
    byAssignee.ops.filter((o) => o[0] === "eq"),
    [["eq", "assigned_to", ID], ["eq", "account_id", ID2], ["eq", "status", "todo"]],
  );

  const db2 = fakeDb({ tasks: { data: [], error: null } });
  await listTasks(db2, { openOnly: true });
  assert.deepEqual(opOf(db2.calls[0], "in"), ["in", "status", ["todo", "doing"]]);

  // openOnly false must not narrow the read at all.
  const db3 = fakeDb({ tasks: { data: [], error: null } });
  await listTasks(db3, { openOnly: false });
  assert.equal(opOf(db3.calls[0], "in"), undefined);
});

test("bad input is rejected before any query is built", async () => {
  const db = fakeDb();
  await assert.rejects(() => listTasks(db, { assignedTo: "nope" }), isInvalidInput);
  await assert.rejects(() => listTasks(db, { accountId: "nope" }), isInvalidInput);
  await assert.rejects(() => listTasks(db, { status: "blocked" }), isInvalidInput);
  await assert.rejects(() => createTask(db, { title: "" }), isInvalidInput);
  await assert.rejects(() => createTask(db, { title: "   \t\n " }), isInvalidInput);
  await assert.rejects(() => createTask(db, { title: "x", status: "blocked" }), isInvalidInput);
  await assert.rejects(() => createTask(db, { title: "x", accountId: "nope" }), isInvalidInput);
  await assert.rejects(() => createTask(db, { title: "x", assignedTo: "nope" }), isInvalidInput);
  await assert.rejects(() => createTask(db, { title: "x", createdBy: "nope" }), isInvalidInput);
  await assert.rejects(() => updateTaskStatus(db, "nope", "done"), isInvalidInput);
  await assert.rejects(() => updateTaskStatus(db, ID, "blocked"), isInvalidInput);
  await assert.rejects(() => assignTask(db, "nope", null), isInvalidInput);
  await assert.rejects(() => assignTask(db, ID, "nope"), isInvalidInput);
  await assert.rejects(() => getProfile(db, "nope"), isInvalidInput);
  assert.equal(db.calls.length, 0, "no query should reach the database");
});

test("createTask trims the title, defaults status, and nulls the optionals", async () => {
  const db = fakeDb({ "tasks.insert.select.single": { data: { id: ID }, error: null } });
  await createTask(db, { title: "  Write the pitch  " });
  const row = opOf(db.calls[0], "insert")[1];
  assert.deepEqual(row, {
    title: "Write the pitch",
    details: null,
    account_id: null,
    assigned_to: null,
    status: "todo",
    due_date: null,
    created_by: null,
  });
});

test("createTask writes every supplied field", async () => {
  const db = fakeDb({ "tasks.insert.select.single": { data: { id: ID }, error: null } });
  await createTask(db, {
    title: "Send quote",
    details: "after the consult",
    accountId: ID,
    assignedTo: ID2,
    status: "doing",
    dueDate: "2026-09-01",
    createdBy: ID,
  });
  const row = opOf(db.calls[0], "insert")[1];
  assert.equal(row.account_id, ID);
  assert.equal(row.assigned_to, ID2);
  assert.equal(row.status, "doing");
  assert.equal(row.due_date, "2026-09-01");
  assert.equal(row.created_by, ID);
});

test("updateTaskStatus patches only the status", async () => {
  const db = fakeDb({ "tasks.update.eq.select.single": { data: { id: ID }, error: null } });
  await updateTaskStatus(db, ID, "done");
  assert.deepEqual(opOf(db.calls[0], "update"), ["update", { status: "done" }]);
  assert.deepEqual(opOf(db.calls[0], "eq"), ["eq", "id", ID]);
});

test("assignTask assigns and unassigns", async () => {
  const db = fakeDb({ "tasks.update.eq.select.single": { data: { id: ID }, error: null } });
  await assignTask(db, ID, ID2);
  assert.deepEqual(opOf(db.calls[0], "update"), ["update", { assigned_to: ID2 }]);

  const db2 = fakeDb({ "tasks.update.eq.select.single": { data: { id: ID }, error: null } });
  await assignTask(db2, ID, null);
  assert.deepEqual(opOf(db2.calls[0], "update"), ["update", { assigned_to: null }]);
});

test("a database error surfaces instead of being swallowed", async () => {
  const db = fakeDb({ tasks: { data: null, error: { message: "permission denied" } } });
  await assert.rejects(() => listTasks(db), /listTasks: permission denied/);
});

test("listProfiles sorts by display name and can hide inactive staff", async () => {
  const db = fakeDb({ profiles: { data: [], error: null } });
  await listProfiles(db);
  assert.equal(opOf(db.calls[0], "eq"), undefined, "unfiltered by default");
  assert.deepEqual(db.calls[0].ops.at(-1), ["order", "display_name", { ascending: true }]);

  const db2 = fakeDb({ profiles: { data: [], error: null } });
  await listProfiles(db2, { activeOnly: true });
  assert.deepEqual(opOf(db2.calls[0], "eq"), ["eq", "active", true]);
});

test("a missing profile reads as null, not an error", async () => {
  const db = fakeDb({ "profiles.select.eq.maybeSingle": { data: null, error: null } });
  assert.equal(await getProfile(db, ID), null);
});
