/**
 * accounts-data-layer.test.mjs — lib/accounts.ts against a fake Supabase client.
 *
 * The database's own rules (RLS, CHECK constraints, foreign keys) are proven
 * separately against a real Postgres in rls-policies.test.mjs and
 * core-schema-migration.test.mjs. This file proves the layer ABOVE that: bad
 * input is rejected before a query is ever built, money converts exactly, and
 * each function issues the query shape it claims to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES, TERMINAL_STAGES, isUuid, isStage, isValidSlug, slugify,
  dollarsToCents, centsToDollars, InvalidInputError,
  listAccounts, getAccount, setAccountStatus, logActivity,
  listClients, getClientBySlug, convertAccountToClient, assignAccount,
} from "../lib/accounts.ts";

const ID = "11111111-1111-4111-8111-111111111111";

/**
 * Fake client. Records every call, returns whatever the test queued.
 * Each builder method returns `this`, and the terminal methods resolve.
 */
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
      is: (col, val) => (rec.ops.push(["is", col, val]), b),
      order: (col, o) => (rec.ops.push(["order", col, o]), settle()),
      single: () => (rec.ops.push(["single"]), settle()),
      maybeSingle: () => (rec.ops.push(["maybeSingle"]), settle()),
    };
    const settle = () => {
      const key = `${table}.${rec.ops.map((o) => o[0]).join(".")}`;
      const r = responses[key] ?? responses[table] ?? { data: [], error: null };
      return Promise.resolve(r);
    };
    // A bare insert with no .select() is awaited directly.
    b.then = (res, rej) => settle().then(res, rej);
    return b;
  };
  return { from: builder, calls };
}

test("stage vocabulary matches the database CHECK constraint", () => {
  assert.deepEqual([...STAGES], [
    "new", "attempted", "reached", "consult_scheduled",
    "consult_done", "won", "lost", "dead",
  ]);
  assert.deepEqual([...TERMINAL_STAGES], ["won", "lost", "dead"]);
  assert.ok(isStage("won"));
  assert.ok(!isStage("WON"));
  assert.ok(!isStage("closed"));
});

test("money converts through strings, never floats", () => {
  // The float trap: 24.99 * 100 === 2498.9999999999995 → truncates to 2498.
  assert.equal(dollarsToCents("24.99"), 2499);
  assert.equal(dollarsToCents(24.99), 2499);
  assert.equal(dollarsToCents("2400.50"), 240050);
  assert.equal(dollarsToCents("$1,200"), 120000);
  assert.equal(dollarsToCents("0"), 0);
  assert.equal(dollarsToCents("0.5"), 50);
  assert.equal(dollarsToCents("-12.34"), -1234);
  assert.equal(centsToDollars(2499), "24.99");
  assert.equal(centsToDollars(-1234), "-12.34");
  // Round-trips exactly across a range that would drift under float math.
  for (const d of ["0.01", "0.07", "8.11", "24.99", "999999.99"]) {
    assert.equal(centsToDollars(dollarsToCents(d)), d);
  }
});

test("money rejects anything that is not an amount", () => {
  for (const bad of ["", "abc", "1.234", "1.2.3", "1e3", "--1", "$"]) {
    assert.throws(() => dollarsToCents(bad), InvalidInputError, String(bad));
  }
});

test("slug rule matches the database CHECK constraint", () => {
  assert.ok(isValidSlug("coventry"));
  assert.ok(isValidSlug("l2-detailz"));
  for (const bad of ["Coventry", "cov_entry", "-cov", "cov-", "cov--entry", "", "a".repeat(64)]) {
    assert.ok(!isValidSlug(bad), bad);
  }
});

test("slugify derives a legal slug or admits it cannot", () => {
  assert.equal(slugify("Coventry Landscaping"), "coventry-landscaping");
  assert.equal(slugify("L2 Detailz, LLC."), "l2-detailz-llc");
  assert.equal(slugify("  --Bob's  Shop--  "), "bob-s-shop");
  assert.equal(slugify("!!!"), null);
  assert.equal(slugify(""), null);
  assert.ok(isValidSlug(slugify("A".repeat(200))));
});

test("bad ids are rejected before any query is built", async () => {
  const db = fakeDb();
  await assert.rejects(() => getAccount(db, "nope"), InvalidInputError);
  await assert.rejects(() => setAccountStatus(db, "nope", "won"), InvalidInputError);
  await assert.rejects(() => setAccountStatus(db, ID, "closed"), InvalidInputError);
  await assert.rejects(() => logActivity(db, { accountId: "nope", kind: "call" }), InvalidInputError);
  await assert.rejects(() => logActivity(db, { accountId: ID, kind: "  " }), InvalidInputError);
  await assert.rejects(() => getClientBySlug(db, "Bad Slug"), InvalidInputError);
  await assert.rejects(() => listAccounts(db, { status: "nope" }), InvalidInputError);
  assert.equal(db.calls.length, 0, "no query should reach the database");
});

test("listAccounts filters by stage and sorts newest first", async () => {
  const db = fakeDb({ accounts: { data: [], error: null } });
  await listAccounts(db, { status: "won" });
  const [call] = db.calls;
  assert.equal(call.table, "accounts");
  assert.deepEqual(call.ops.find((o) => o[0] === "eq"), ["eq", "status", "won"]);
  assert.deepEqual(call.ops.at(-1), ["order", "created_at", { ascending: false }]);
});

test("a missing row reads as null, not an error", async () => {
  const db = fakeDb({ "accounts.select.eq.maybeSingle": { data: null, error: null } });
  assert.equal(await getAccount(db, ID), null);
});

test("a database error surfaces instead of being swallowed", async () => {
  const db = fakeDb({ accounts: { data: null, error: { message: "permission denied" } } });
  await assert.rejects(() => listAccounts(db), /listAccounts: permission denied/);
});

test("logActivity records kind, note and actor", async () => {
  const db = fakeDb({ account_activity: { data: null, error: null } });
  await logActivity(db, { accountId: ID, kind: "call", note: "left voicemail" });
  const ins = db.calls[0].ops.find((o) => o[0] === "insert")[1];
  assert.equal(ins.account_id, ID);
  assert.equal(ins.kind, "call");
  assert.equal(ins.note, "left voicemail");
  // The KEY is what matters here: the table column is `actor_email`, and
  // PostgREST 400s an insert naming a column that does not exist.
  assert.ok("actor_email" in ins, "must write actor_email, the real column name in 0001");
  assert.equal(ins.actor_email, null, "actor is optional and stored as null, not undefined");
});

test("convert marks the account won, sets a close date, and creates the client", async () => {
  const account = { id: ID, business_name: "Coventry Landscaping", close_date: null };
  const db = fakeDb({
    "accounts.select.eq.maybeSingle": { data: account, error: null },
    "accounts.update.eq": { data: null, error: null },
    "clients.insert.select.single": { data: { id: "c", slug: "coventry-landscaping" }, error: null },
  });
  const client = await convertAccountToClient(db, { accountId: ID, dealValueDollars: "2400.50" });
  assert.equal(client.slug, "coventry-landscaping");

  const patch = db.calls[1].ops.find((o) => o[0] === "update")[1];
  assert.equal(patch.status, "won");
  assert.equal(patch.deal_value_cents, 240050, "dollars must be stored as integer cents");
  assert.match(patch.close_date, /^\d{4}-\d{2}-\d{2}$/);

  const row = db.calls[2].ops.find((o) => o[0] === "insert")[1];
  assert.deepEqual(row, { account_id: ID, slug: "coventry-landscaping", status: "active" });
});

test("convert never overwrites an existing close date", async () => {
  const db = fakeDb({
    "accounts.select.eq.maybeSingle": {
      data: { id: ID, business_name: "Coventry", close_date: "2026-01-05" }, error: null },
    "accounts.update.eq": { data: null, error: null },
    "clients.insert.select.single": { data: { id: "c", slug: "coventry" }, error: null },
  });
  await convertAccountToClient(db, { accountId: ID });
  const patch = db.calls[1].ops.find((o) => o[0] === "update")[1];
  assert.ok(!("close_date" in patch));
  assert.ok(!("deal_value_cents" in patch), "money is only written when supplied");
});

test("convert refuses a name that yields no legal slug, before writing anything", async () => {
  const db = fakeDb({ "accounts.select.eq.maybeSingle": {
    data: { id: ID, business_name: "!!!", close_date: null }, error: null } });
  await assert.rejects(() => convertAccountToClient(db, { accountId: ID }), InvalidInputError);
  assert.equal(db.calls.length, 1, "the account read only — no update, no insert");
});

test("convert refuses an account that does not exist", async () => {
  const db = fakeDb({ "accounts.select.eq.maybeSingle": { data: null, error: null } });
  await assert.rejects(() => convertAccountToClient(db, { accountId: ID }), InvalidInputError);
});

test("listClients sorts by slug", async () => {
  const db = fakeDb({ clients: { data: [], error: null } });
  await listClients(db);
  assert.deepEqual(db.calls[0].ops.at(-1), ["order", "slug", { ascending: true }]);
});

/**
 * Assignment. The filter distinguishes three states, not two: no filter at all,
 * "owned by this person", and "owned by nobody". `null` is a real value here,
 * so any check written as a truthiness test collapses the third into the first
 * and quietly returns every lead when the page asked for the unassigned ones.
 */
test("listAccounts filters unassigned with IS NULL, not equality", async () => {
  const db = fakeDb({ accounts: { data: [], error: null } });
  await listAccounts(db, { assignedTo: null });
  assert.deepEqual(db.calls[0].ops[1], ["is", "assigned_to", null]);
});

test("listAccounts with no assignee filter adds no ownership clause", async () => {
  const db = fakeDb({ accounts: { data: [], error: null } });
  await listAccounts(db);
  assert.ok(!db.calls[0].ops.some((o) => o[1] === "assigned_to"));
});

test("listAccounts rejects a non-uuid assignee before querying", async () => {
  const db = fakeDb();
  await assert.rejects(() => listAccounts(db, { assignedTo: "nate" }), InvalidInputError);
  assert.equal(db.calls.length, 0, "a bad filter must never reach the database");
});

test("assignAccount writes NULL to unassign", async () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const db = fakeDb({ "accounts.update.eq.select.single": { data: { id: ID }, error: null } });
  await assignAccount(db, ID, null);
  assert.deepEqual(db.calls[0].ops[0], ["update", { assigned_to: null }]);
});

test("assignAccount rejects a non-uuid assignee", async () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(() => assignAccount(fakeDb(), ID, "brandon"), InvalidInputError);
});
