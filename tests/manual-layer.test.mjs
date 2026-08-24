/**
 * manual-layer.test.mjs — lib/manual.ts and lib/insights.ts against fakes.
 *
 * The database's own rules are proven against real Postgres in
 * project-manual-migration.test.mjs. This file proves the layer above: bad
 * input never reaches a query, clearing an override is a DELETE rather than an
 * empty string, and the merge and the date maths land on their boundaries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERRIDE_FIELDS, HIDEABLE_FIELDS, MAX_NOTE_LENGTH,
  isOverrideField, isHideableField, isProjectId,
  setOverride, setDueDate, setFieldHidden,
  listNotes, addNote, assignNote, deleteNote,
  loadManualLayer, applyManualLayer,
} from "../lib/manual.ts";
import {
  dayWindow, activityByDay, funnelCounts, buildKpis, centsToWholeDollars, WINDOW_DAYS,
} from "../lib/insights.ts";
/**
 * Matched by NAME, not by instance. lib/manual.ts imports `./accounts` while
 * this file imports `../lib/accounts.ts`; the loader treats those as two
 * modules, so the two InvalidInputError classes are not the same object. The
 * name is the stable contract.
 */
const isInvalidInput = (e) => e.name === "InvalidInputError";

/** Same fake shape accounts-data-layer.test.mjs uses, plus delete/upsert/is. */
function fakeDb(responses = {}) {
  const calls = [];
  const builder = (table) => {
    const rec = { table, ops: [] };
    calls.push(rec);
    const b = {
      then: undefined,
      select: (cols) => (rec.ops.push(["select", cols]), b),
      insert: (row) => (rec.ops.push(["insert", row]), b),
      upsert: (row, opts) => (rec.ops.push(["upsert", row, opts]), b),
      update: (row) => (rec.ops.push(["update", row]), b),
      delete: () => (rec.ops.push(["delete"]), b),
      eq: (col, val) => (rec.ops.push(["eq", col, val]), b),
      is: (col, val) => (rec.ops.push(["is", col, val]), b),
      order: (col, o) => (rec.ops.push(["order", col, o]), settle()),
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

const op = (db, i, name) => db.calls[i].ops.find((o) => o[0] === name);

// ---------------------------------------------------------------------------
// Vocabulary — must match the CHECK constraints in 0003 exactly.
// ---------------------------------------------------------------------------

test("the overridable field list matches the database CHECK", () => {
  assert.deepEqual([...OVERRIDE_FIELDS],
    ["name", "summary", "status", "priority", "next_step", "repo", "github"]);
  assert.ok(isOverrideField("summary"));
  assert.ok(!isOverrideField("deal_value"), "a field the DB rejects must be rejected here too");
  assert.deepEqual([...HIDEABLE_FIELDS], ["due_date", "priority"]);
  assert.ok(isHideableField("due_date"));
  assert.ok(!isHideableField("status"));
});

test("a project id is a directory name, and a path escape is not one", () => {
  assert.ok(isProjectId("hitter-embedding"));
  assert.ok(isProjectId("bcns.internal_v2"));
  assert.ok(!isProjectId(""));
  assert.ok(!isProjectId("../etc/passwd"), "a traversal must never reach a query");
  assert.ok(!isProjectId("a/b"));
  assert.ok(!isProjectId(".hidden"), "must start alphanumeric");
  assert.ok(!isProjectId("x".repeat(129)));
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

test("setOverride upserts on the composite key", async () => {
  const db = fakeDb();
  await setOverride(db, { projectId: "p1", field: "summary", value: " tidy ", actor: "a@b.c" });
  const [, row, opts] = op(db, 0, "upsert");
  assert.equal(db.calls[0].table, "project_overrides");
  assert.equal(row.value, "tidy", "the value is trimmed before it is stored");
  assert.equal(row.updated_by, "a@b.c");
  assert.deepEqual(opts, { onConflict: "project_id,field" });
});

test("an empty override value CLEARS the row rather than storing an empty string", async () => {
  // A form always submits a string, so "" is what typing nothing sends. Storing
  // it would render as "no value" while still shadowing the README.
  const db = fakeDb();
  await setOverride(db, { projectId: "p1", field: "summary", value: "   " });
  assert.ok(op(db, 0, "delete"), "a blank value must issue a DELETE");
  assert.ok(!op(db, 0, "upsert"), "and must not write a row");
});

test("setOverride refuses a field the database would reject", async () => {
  const db = fakeDb();
  await assert.rejects(
    () => setOverride(db, { projectId: "p1", field: "deal_value", value: "9" }),
    isInvalidInput);
  assert.equal(db.calls.length, 0, "no query may be built for a bad field");
});

test("clearing a due date keeps the row, so the hide flags survive", async () => {
  const db = fakeDb();
  await setDueDate(db, { projectId: "p1", date: "" });
  const [, row] = op(db, 0, "upsert");
  assert.equal(row.due_date, null);
  assert.ok(!op(db, 0, "delete"), "deleting the row would silently unhide hidden fields");
});

test("a malformed due date is refused before a query is built", async () => {
  const db = fakeDb();
  await assert.rejects(() => setDueDate(db, { projectId: "p1", date: "01/09/2026" }), isInvalidInput);
  assert.equal(db.calls.length, 0);
});

test("setFieldHidden writes the column matching the field", async () => {
  const db = fakeDb();
  await setFieldHidden(db, { projectId: "p1", field: "priority", hidden: true });
  assert.equal(op(db, 0, "upsert")[1].hide_priority, true);
  const db2 = fakeDb();
  await setFieldHidden(db2, { projectId: "p1", field: "due_date", hidden: false });
  assert.equal(op(db2, 0, "upsert")[1].hide_due_date, false);
});

test("a note starts unsorted and is never auto-filed", async () => {
  const db = fakeDb();
  await addNote(db, { body: "  ring back Tuesday  ", author: "a@b.c" });
  const [, row] = op(db, 0, "insert");
  assert.equal(row.body, "ring back Tuesday");
  assert.equal(row.project_id, null, "a note with no project named stays unsorted");
  assert.equal(row.author_email, "a@b.c");
});

test("a note is rejected when empty or over the cap", async () => {
  const db = fakeDb();
  await assert.rejects(() => addNote(db, { body: "   " }), isInvalidInput);
  await assert.rejects(
    () => addNote(db, { body: "x".repeat(MAX_NOTE_LENGTH + 1) }), isInvalidInput);
  assert.equal(db.calls.length, 0);
});

test("listNotes distinguishes 'the unsorted pile' from 'no filter'", async () => {
  const unsorted = fakeDb();
  await listNotes(unsorted, { projectId: null });
  assert.deepEqual(op(unsorted, 0, "is"), ["is", "project_id", null]);

  const all = fakeDb();
  await listNotes(all, {});
  assert.ok(!op(all, 0, "is"), "omitting the filter must not filter to unsorted");
  assert.ok(!op(all, 0, "eq"));
});

test("assignNote can move a note back to unsorted", async () => {
  const db = fakeDb();
  await assignNote(db, { id: "n1", projectId: null });
  assert.equal(op(db, 0, "update")[1].project_id, null);
});

test("deleteNote needs an id", async () => {
  const db = fakeDb();
  await assert.rejects(() => deleteNote(db, ""), isInvalidInput);
  assert.equal(db.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Read + merge
// ---------------------------------------------------------------------------

test("loadManualLayer keys overrides by project and field", async () => {
  const db = fakeDb({
    project_overrides: {
      data: [
        { project_id: "p1", field: "name", value: "Renamed" },
        { project_id: "p1", field: "priority", value: "high" },
        { project_id: "p2", field: "summary", value: "Other" },
      ],
      error: null,
    },
    project_settings: {
      data: [{ project_id: "p1", due_date: "2026-09-01", hide_due_date: false, hide_priority: true }],
      error: null,
    },
  });
  const layer = await loadManualLayer(db);
  assert.deepEqual(layer.overrides.p1, { name: "Renamed", priority: "high" });
  assert.deepEqual(layer.overrides.p2, { summary: "Other" });
  assert.equal(layer.settings.p1.hide_priority, true);
});

const project = (over = {}) => ({
  id: "p1", name: "Hitter", summary: null, repo: null, github: null,
  status: "active", priority: "low", next_step: null, ...over,
});

test("an override shadows the README value and is reported as manual", () => {
  const [merged] = applyManualLayer(
    [project()],
    { overrides: { p1: { name: "Hitter Embedding", priority: "high" } }, settings: {} },
    "2026-08-19");
  assert.equal(merged.name, "Hitter Embedding");
  assert.equal(merged.priority, "high");
  assert.deepEqual(merged.overridden, ["name", "priority"]);
  assert.equal(merged.status, "active", "an unoverridden field is untouched");
});

test("overdue is strict: due today is NOT overdue, yesterday is", () => {
  const layer = (d) => ({ overrides: {}, settings: { p1: { project_id: "p1", due_date: d, hide_due_date: false, hide_priority: false } } });
  assert.equal(applyManualLayer([project()], layer("2026-08-19"), "2026-08-19")[0].overdue, false);
  assert.equal(applyManualLayer([project()], layer("2026-08-18"), "2026-08-19")[0].overdue, true);
  assert.equal(applyManualLayer([project()], layer(null), "2026-08-19")[0].overdue, false);
  // No settings row at all must not be an error, and must not be overdue.
  const bare = applyManualLayer([project()], { overrides: {}, settings: {} }, "2026-08-19")[0];
  assert.equal(bare.overdue, false);
  assert.deepEqual(bare.hidden_fields, { due_date: false, priority: false });
});

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

test("dayWindow is the last N days, oldest first, inclusive of today", () => {
  const days = dayWindow("2026-03-02", 4);
  assert.deepEqual(days, ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  assert.equal(dayWindow("2026-08-19").length, WINDOW_DAYS);
  assert.throws(() => dayWindow("19/08/2026"), /not a YYYY-MM-DD date/);
});

test("activity outside the window is dropped, not folded into the first day", () => {
  const series = activityByDay([
    { occurred_at: "2026-03-02T10:00:00Z" },
    { occurred_at: "2026-03-02T18:00:00Z" },
    { occurred_at: "2026-02-27T09:00:00Z" },
    // Older than the window: clamping this into day one would draw a spike
    // that never happened.
    { occurred_at: "2025-01-01T09:00:00Z" },
  ], "2026-03-02", 4);
  assert.deepEqual(series, [
    { day: "2026-02-27", count: 1 },
    { day: "2026-02-28", count: 0 },
    { day: "2026-03-01", count: 0 },
    { day: "2026-03-02", count: 2 },
  ]);
});

test("funnelCounts reports every stage, including the empty ones", () => {
  const counts = funnelCounts(
    [{ status: "won" }, { status: "won" }, { status: "new" }, { status: "bogus" }],
    ["new", "won", "lost"]);
  assert.deepEqual(counts, [
    { stage: "new", count: 1 }, { stage: "won", count: 2 }, { stage: "lost", count: 0 },
  ]);
});

test("MRR counts active clients only", () => {
  const kpis = buildKpis({
    accounts: [],
    clients: [
      { status: "active", monthly_rate_cents: 15000 },
      { status: "onboarding", monthly_rate_cents: 20000 },
      { status: "paused", monthly_rate_cents: 30000 },
    ],
    activity: [], today: "2026-08-19", overdueProjects: 0, activeProjects: 0,
  });
  const clientsKpi = kpis.find((k) => k.label === "Active clients");
  assert.equal(clientsKpi.value, "1", "onboarding and paused are not paying");
  assert.equal(clientsKpi.detail, "$150 per month");
});

test("a pipeline with no deal values says so instead of showing $0", () => {
  const kpis = buildKpis({
    accounts: [{ status: "reached", deal_value_cents: null, created_at: "2026-08-01" }],
    clients: [], activity: [], today: "2026-08-19", overdueProjects: 0, activeProjects: 0,
  });
  const pipeline = kpis.find((k) => k.label === "Open pipeline");
  assert.equal(pipeline.value, "1");
  assert.match(pipeline.detail, /no deal values recorded/);
});

test("money never becomes a float on the way to the screen", () => {
  assert.equal(centsToWholeDollars(150000), "$1,500");
  assert.equal(centsToWholeDollars(0), "$0");
});
