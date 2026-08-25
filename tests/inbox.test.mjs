/**
 * inbox.test.mjs — item 6: the inbox surface, its privacy, and its reply path.
 *
 * TWO HALVES, on purpose.
 *
 *   Half 1 runs against REAL POSTGRES through tests/helpers/pg-cluster.mjs with
 *   forged JWT claims. Every privacy claim in this item is a claim about RLS,
 *   and RLS is a Postgres behaviour: a fake client that filtered by profile id
 *   would pass while the database let an admin read everyone's mail. Nothing in
 *   lib/inbox.ts is imported there — the queries are written out by hand, so
 *   what is proven is the POLICY, not the convenience filter in the data layer.
 *
 *   Half 2 drives the TypeScript with the in-memory fake: the count matches a
 *   seeded fixture of read and unread rows, a reply writes exactly one
 *   `account_activity` row linked to the item's account, and the badge is not a
 *   query per page.
 *
 * The claude CLI is never executed: the parse runner is injected, as in items 4
 * and 5.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";
import { fakeDb } from "./helpers/fake-db.mjs";
import { listInbox, countUnread, setRead, itemHref, replyTarget } from "../lib/inbox.ts";
import { notifyTaskAssigned, TASK_ASSIGNED_KIND } from "../lib/agent/task-nudge.ts";
import { log_activity } from "../lib/agent/verbs/log_activity.ts";

const MIGRATIONS = [
  "0001_core_schema.sql", "0002_rls_policies.sql", "0003_project_manual.sql",
  "0004_profiles.sql", "0005_tasks.sql", "0006_seed_clients.sql",
  "0007_own_tasks_only.sql", "0008_agent_tokens.sql", "0009_automation_schema.sql",
  "0010_activity_audit_trail.sql",
];

/* A = the admin, B = the member. The admin is deliberately the ATTACKER in the
   read tests: this table is the one place admin is not exempt. */
const A = "eeeeeeee-0000-4000-8000-000000000001";
const B = "eeeeeeee-0000-4000-8000-000000000002";
const ACCOUNT = "eeeeeeee-0000-4000-8000-0000000000a1";
const B_ITEM = "eeeeeeee-0000-4000-8000-0000000000b1";

// `sub` is what auth.uid() reads; the shared CLAIMS fixtures carry none.
const claimsA = { sub: A, app_metadata: { role: "admin" }, email: "a@bcn-services.com" };
const claimsB = { sub: B, app_metadata: { role: "member" }, email: "b@bcn-services.com" };

describe("item 6 — inbox privacy is RLS", { skip: !toolsPresent && "no local Postgres" }, () => {
  let pg;
  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    pg.run(`insert into auth.users (id, email) values
      ('${A}','a@bcn-services.com'), ('${B}','b@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values
      ('${A}','a@bcn-services.com','Ann'), ('${B}','b@bcn-services.com','Bo')`);
    pg.run(`insert into accounts (id, business_name, city, status)
      values ('${ACCOUNT}','Inbox Test Co','Rye','new')`);
    // B's mail: three read, two unread. A's: one unread, so a leak shows up as
    // a wrong COUNT and not merely as a wrong row.
    pg.run(`insert into inbox_items (id, profile_id, kind, title, read_at, account_id) values
      ('${B_ITEM}','${B}','task_assigned','B unread one', null,      '${ACCOUNT}'),
      (gen_random_uuid(),'${B}','task_assigned','B unread two', null, null),
      (gen_random_uuid(),'${B}','lead_cold','B read one',  now(), null),
      (gen_random_uuid(),'${B}','lead_cold','B read two',  now(), null),
      (gen_random_uuid(),'${B}','lead_cold','B read three',now(), null),
      (gen_random_uuid(),'${A}','lead_cold','A unread',    null,  null)`);
  });
  after(() => pg?.stop());

  test("profile A cannot READ profile B's items, admin or not", () => {
    const r = pg.runClaims(claimsA, `select count(*) from inbox_items where profile_id='${B}'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "0", "an admin read another person's inbox");
  });

  test("an unfiltered select as A returns only A's own row", () => {
    // The data layer's `.eq('profile_id', me)` is NOT in this query. If the
    // policy were the wrong shape, this is where six rows would appear.
    const r = pg.runClaims(claimsA, `select count(*) from inbox_items`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "1");
  });

  test("profile A cannot UPDATE profile B's items", () => {
    // The guardrail: marking read must not be a write path into another
    // profile's rows. USING denies the row, so zero are updated.
    const r = pg.runClaims(
      claimsA,
      `update inbox_items set read_at=now() where id='${B_ITEM}';
       select count(*) from inbox_items where id='${B_ITEM}' and read_at is not null`,
    );
    assert.equal(r.ok, true, r.error);
    // The UPDATE saw no row, and the follow-up SELECT is also blind to it, so
    // this line alone proves little — the superuser read below is the honest
    // one. Measured against a mutant with the SELECT policy opened to `true`,
    // the UPDATE's own USING clause still refuses the write, so both halves of
    // the pair are load-bearing rather than one masking the other.
    assert.equal(r.out, "0");
    assert.equal(
      pg.run(`select read_at is null from inbox_items where id='${B_ITEM}'`),
      "t",
      "another profile's row was actually modified",
    );
  });

  // Which clause answers first is Postgres' business — measured, the new row
  // is refused even with the WITH CHECK loosened, because the owner-scoped
  // SELECT policy constrains the updated row as well. What is asserted is the
  // outcome: an owner cannot plant a row in a colleague's inbox.
  test("A cannot hand its own item to B", () => {
    const r = pg.runClaims(claimsA, `update inbox_items set profile_id='${B}' where profile_id='${A}'`);
    assert.equal(r.ok, false, "an owner was able to plant a row in someone else's inbox");
    assert.match(r.error, /row-level security/i);
  });

  test("nobody authenticated may INSERT, so an inbox cannot be planted", () => {
    for (const claims of [claimsA, claimsB]) {
      const r = pg.runClaims(
        claims,
        `insert into inbox_items (profile_id, kind, title) values ('${claims.sub}','x','planted')`,
      );
      assert.equal(r.ok, false, "inbox_items accepted an insert from a browser session");
      assert.match(r.error, /row-level security/i);
    }
  });

  test("the unread count matches the seeded fixture", () => {
    const r = pg.runClaims(claimsB, `select count(*) from inbox_items where read_at is null`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "2", "the badge would show the wrong number");
    assert.equal(pg.runClaims(claimsA, `select count(*) from inbox_items where read_at is null`).out, "1");
  });

  test("the owner may mark their own item read", () => {
    const r = pg.runClaims(
      claimsB,
      `update inbox_items set read_at=now() where id='${B_ITEM}';
       select count(*) from inbox_items where read_at is null`,
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "1");
  });
});

/* ------------------------------------------------------------------ layer -- */

const ITEM = (over = {}) => ({
  id: "11111111-0000-4000-8000-000000000001",
  profile_id: B,
  kind: "task_close_nudge",
  title: "Log what happened",
  body: null,
  source_job: "task_close_nudge",
  account_id: ACCOUNT,
  client_id: null,
  read_at: null,
  created_at: "2026-08-01T00:00:00Z",
  ...over,
});

describe("item 6 — the data layer", () => {
  const seeded = () => ({
    inbox_items: [
      ITEM({ id: "11111111-0000-4000-8000-000000000001", created_at: "2026-08-01T00:00:00Z" }),
      ITEM({ id: "11111111-0000-4000-8000-000000000002", created_at: "2026-08-03T00:00:00Z" }),
      ITEM({ id: "11111111-0000-4000-8000-000000000003", created_at: "2026-08-02T00:00:00Z", read_at: "2026-08-02T01:00:00Z" }),
      // Somebody else's, which RLS would never have returned. Present so a
      // missing filter shows up as a wrong count rather than as nothing.
      ITEM({ id: "11111111-0000-4000-8000-000000000004", profile_id: A }),
    ],
  });

  test("lists newest first", async () => {
    const db = fakeDb(seeded());
    const rows = await listInbox(db, B);
    assert.deepEqual(rows.map((r) => r.created_at), [
      "2026-08-03T00:00:00Z", "2026-08-02T00:00:00Z", "2026-08-01T00:00:00Z",
    ]);
  });

  test("the unread count matches a fixture of read and unread rows", async () => {
    const db = fakeDb(seeded());
    assert.equal(await countUnread(db, B), 2);
  });

  test("the count transfers no rows", async () => {
    // head:true — the badge runs on every page render, cached or not, and a
    // count that dragged the rows back would be a silent regression.
    const db = fakeDb(seeded());
    await countUnread(db, B);
    const op = db.calls.at(-1).ops.find(([name]) => name === "select");
    assert.equal(op[2]?.head, true);
    assert.equal(op[2]?.count, "exact");
  });

  test("marking read sends no profile id — there is no field to forge", async () => {
    const db = fakeDb(seeded());
    assert.equal(await setRead(db, "11111111-0000-4000-8000-000000000001", true), true);
    const rec = db.calls.at(-1);
    const [, patch] = rec.ops.find(([name]) => name === "update");
    assert.deepEqual(Object.keys(patch), ["read_at"]);
    assert.deepEqual(
      rec.ops.filter(([name]) => name === "eq").map(([, col]) => col),
      ["id"],
    );
  });

  test("a row RLS does not return is a miss, not an error", async () => {
    // Under real RLS the UPDATE simply matches nothing. Same answer as
    // "already read", which is the point: no membership oracle.
    const db = fakeDb({ inbox_items: [] });
    assert.equal(await setRead(db, "11111111-0000-4000-8000-000000000009", true), false);
  });

  test("links point at what the item references", () => {
    assert.equal(itemHref(ITEM()), `/leads?assigned=anyone#account-${ACCOUNT}`);
    assert.equal(itemHref(ITEM({ account_id: null, client_id: "c1" }), () => "coventry"), "/clients/coventry");
    assert.equal(itemHref(ITEM({ account_id: null, client_id: "c1" })), "/clients");
    assert.equal(itemHref(ITEM({ account_id: null, client_id: null })), null);
  });

  test("a reply targets the item's account, or its client, or nothing", () => {
    assert.deepEqual(replyTarget(ITEM()), { accountId: ACCOUNT });
    assert.deepEqual(replyTarget(ITEM({ account_id: null, client_id: "c1" })), { clientId: "c1" });
    assert.equal(replyTarget(ITEM({ account_id: null, client_id: null })), null);
  });
});

/* ------------------------------------------------------------------ reply -- */

describe("item 6 — replying goes through log_activity", () => {
  const caller = { profileId: B, email: "b@bcn-services.com", role: "member" };

  test("a confirmed reply writes exactly ONE account_activity row on the item's account", async () => {
    const db = fakeDb({ account_activity: [] });
    const target = replyTarget(ITEM());
    const res = await log_activity.run(
      { caller, db },
      { ...target, kind: "call", note: "rang them back", occurredAt: "2026-08-04T14:00:00Z" },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    const inserts = db.calls.filter(
      (c) => c.table === "account_activity" && c.ops.some(([n]) => n === "insert"),
    );
    assert.equal(inserts.length, 1, "a reply must write exactly one row");
    const [, row] = inserts[0].ops.find(([n]) => n === "insert");
    assert.equal(row.account_id, ACCOUNT);
    // Authorship is the session's, never the item's or the text's.
    assert.equal(row.actor_email, caller.email);
  });

  test("replying is the SAME two-step: the parse path writes nothing", async () => {
    // The item-4 guardrail applies to this surface too — an inbox reply is not
    // an exemption from "the person sees the parsed row first". The runner is
    // injected; the claude CLI is never executed.
    const db = fakeDb({ account_activity: [] });
    const res = await log_activity.run(
      {
        caller,
        db,
        runParse: async () => ({
          ok: true,
          reply: JSON.stringify({ kind: "call", note: "rang them back", occurred_at: "2026-08-04" }),
        }),
      },
      { ...replyTarget(ITEM()), text: "rang them back about the quote" },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.written, false);
    assert.equal(
      db.calls.filter((c) => c.table === "account_activity" && c.ops.some(([n]) => n === "insert")).length,
      0,
      "a reply committed before anybody saw it",
    );
  });
});

/* --------------------------------------------------------------- posting -- */

describe("item 6 — inbox_post call sites", () => {
  const closer = { profileId: A, email: "a@bcn-services.com", role: "admin" };
  const task = (over = {}) => ({
    id: "22222222-0000-4000-8000-000000000001",
    account_id: ACCOUNT,
    title: "Call the roofer",
    details: null,
    assigned_to: B,
    status: "todo",
    due_date: "2026-09-01",
    created_by: A,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  });

  const posted = (db) =>
    db.calls.filter((c) => c.table === "inbox_items" && c.ops.some(([n]) => n === "insert"));

  test("assigning a task posts exactly one notice, to the assignee", async () => {
    const serviceDb = fakeDb({ inbox_items: [] });
    assert.equal(
      await notifyTaskAssigned({ serviceDb, caller: closer, task: task(), previousAssignee: null }),
      true,
    );
    const rows = posted(serviceDb);
    assert.equal(rows.length, 1);
    const [, row] = rows[0].ops.find(([n]) => n === "insert");
    assert.equal(row.profile_id, B);
    assert.equal(row.kind, TASK_ASSIGNED_KIND);
    assert.equal(row.account_id, ACCOUNT);
  });

  test("re-saving the same assignee posts nothing", async () => {
    const serviceDb = fakeDb({ inbox_items: [] });
    assert.equal(
      await notifyTaskAssigned({ serviceDb, caller: closer, task: task(), previousAssignee: B }),
      false,
    );
    assert.equal(posted(serviceDb).length, 0);
  });

  test("unassigning, and assigning to yourself, post nothing", async () => {
    const serviceDb = fakeDb({ inbox_items: [] });
    await notifyTaskAssigned({
      serviceDb, caller: closer, task: task({ assigned_to: null }), previousAssignee: B,
    });
    await notifyTaskAssigned({
      serviceDb, caller: closer, task: task({ assigned_to: A }), previousAssignee: null,
    });
    assert.equal(posted(serviceDb).length, 0);
  });

  test("a notice never fails the save it follows", async () => {
    // No service client at all — the assignment already landed.
    assert.equal(
      await notifyTaskAssigned({ caller: closer, task: task(), previousAssignee: null }),
      false,
    );
  });
});

/* ----------------------------------------------------------------- badge -- */

describe("item 6 — the badge is not a query per page", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

  test("only the root layout reads the count, and it is cached", () => {
    const layout = read("../app/layout.tsx");
    assert.match(layout, /cachedUnreadCount/);
    assert.match(layout, /unread=\{unread\}/);
    // lib/inbox-badge.ts is the only thing standing between this and one query
    // per navigation to every route in the app.
    assert.match(read("../lib/inbox-badge.ts"), /unstable_cache/);
  });

  test("no page other than the inbox itself reads the inbox", () => {
    for (const p of ["../app/nav.tsx", "../app/tasks/page.tsx", "../app/leads/page.tsx", "../app/clients/page.tsx"]) {
      assert.doesNotMatch(read(p), /countUnread|listInbox/, `${p} queries the inbox on render`);
    }
  });
});
