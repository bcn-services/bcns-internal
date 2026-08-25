/**
 * inbox-hardening.test.mjs — the review findings on item 6, each pinned by a
 * test that FAILS against the code as it shipped.
 *
 * The theme is item 7: the inbox is the first feature to cache a read taken
 * through the SERVICE-role client, and item 7 is the next thing that would copy
 * that pattern. So most of what is asserted here is not "the badge shows the
 * right number" (tests/inbox.test.mjs and tests/inbox-qa.test.mjs already do
 * that) but "the shape that made it safe cannot be got wrong by the next
 * caller": the id must be a verified viewer, the query is not caller-supplied,
 * and the RLS-bound readers refuse the escalated client outright.
 *
 * No network, no claude CLI, no production database.
 */
// MUST be first: it sets globalThis.AsyncLocalStorage before next/cache loads.
import { installFakeIncrementalCache, uninstallFakeIncrementalCache } from "./helpers/next-cache-harness.mjs";
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startClusterWithMigrations, toolsPresent } from "./helpers/pg-cluster.mjs";
import { fakeDb } from "./helpers/fake-db.mjs";
import { listInbox, countUnread, countUnreadForOwner, setRead } from "../lib/inbox.ts";
import { cachedUnreadCount } from "../lib/inbox-badge.ts";
import { markServiceClient, isServiceClient } from "../lib/service-client-mark.ts";
import { listClientsByIds } from "../lib/accounts.ts";
import { handleSkillRun } from "../lib/agent/skill-run.ts";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Source with comments stripped — every assertion below is about behavior, not prose. */
const code = (rel) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const A = "eeeeeeee-0000-4000-8000-000000000001";
const B = "eeeeeeee-0000-4000-8000-000000000002";

const row = (over = {}) => ({
  id: over.id ?? "eeeeeeee-0000-4000-8000-00000000aa01",
  profile_id: B, kind: "k", title: "t", body: null, source_job: null,
  account_id: null, client_id: null, read_at: null, created_at: "2026-08-01T00:00:00Z",
  ...over,
});

/* ============================ 1. the cached service read cannot be misused = */

describe("the badge takes a VERIFIED VIEWER, not an id and a closure", () => {
  after(() => uninstallFakeIncrementalCache());

  test("a bare profile-id string is not a viewer: nothing is read and no badge is shown", async () => {
    installFakeIncrementalCache();
    const db = fakeDb({ inbox_items: [row({ profile_id: A })] });
    let built = 0;
    // The old signature took (profileId, load). A string has no `userId`, so
    // under the new one it can reach nothing at all — the invariant is in the
    // type, and unrepresentable rather than merely discouraged.
    const answer = await cachedUnreadCount(A, () => {
      built += 1;
      return db;
    });
    assert.equal(answer, null, "a raw id still produced a count");
    assert.equal(built, 0, "a raw id still reached the service client");
    assert.equal(db.calls.length, 0, "a raw id still issued a query");
  });

  test("a signed-out viewer reads nothing and shows no badge", async () => {
    installFakeIncrementalCache();
    let built = 0;
    const answer = await cachedUnreadCount({ userId: null }, () => (built += 1, null));
    assert.equal(answer, null);
    assert.equal(built, 0);
  });

  test("the query is built inside the badge, and it is scoped to the viewer", async () => {
    installFakeIncrementalCache();
    const db = fakeDb({ inbox_items: [row({ profile_id: A }), row({ id: "eeeeeeee-0000-4000-8000-00000000aa02" })] });
    assert.equal(await cachedUnreadCount({ userId: A }, () => db), 1);
    const call = db.calls.at(-1);
    assert.equal(call.table, "inbox_items");
    assert.deepEqual(call.ops.find(([n]) => n === "eq"), ["eq", "profile_id", A]);
    assert.deepEqual(call.ops.find(([n]) => n === "is"), ["is", "read_at", null]);
    // The caller supplies a CLIENT FACTORY and nothing else: there is no
    // parameter through which a cached, RLS-bypassing query could be handed in.
    assert.doesNotMatch(code("lib/inbox-badge.ts"), /load\s*:\s*\(\)\s*=>\s*Promise/);
  });

  test("no incremental cache means no badge; a broken QUERY is not swallowed", async () => {
    uninstallFakeIncrementalCache();
    assert.equal(await cachedUnreadCount({ userId: A }, () => fakeDb({ inbox_items: [] })), null);

    installFakeIncrementalCache();
    // A permanently failing badge query used to read as "no mail" forever
    // behind a console.warn. It must surface.
    await assert.rejects(
      () => cachedUnreadCount({ userId: A }, () => fakeDb({}, { throwOn: "inbox_items" })),
      /exploding on inbox_items/,
    );
  });
});

/* ================== 2. the RLS-bound readers refuse the escalated client === */

describe("which client you hand in is checked, not documented", () => {
  const svc = () => markServiceClient(fakeDb({ inbox_items: [row({ profile_id: A }), row()] }));

  test("countUnread, listInbox and setRead all refuse a service-role client", async () => {
    await assert.rejects(() => countUnread(svc(), B), /service-role/);
    await assert.rejects(() => listInbox(svc(), B), /service-role/);
    await assert.rejects(() => setRead(svc(), row().id, true), /service-role/);
  });

  test("the badge's own function accepts it, and that .eq IS its guard", async () => {
    const db = svc();
    assert.equal(await countUnreadForOwner(db, B), 1, "the escalated count is not profile-scoped");
    assert.equal(await countUnreadForOwner(db, A), 1);
    assert.deepEqual(db.calls.at(-1).ops.find(([n]) => n === "eq"), ["eq", "profile_id", A]);
  });

  test("the cookie-bound client is untouched by the check", async () => {
    const db = fakeDb({ inbox_items: [row(), row({ id: "eeeeeeee-0000-4000-8000-00000000aa03" })] });
    assert.equal(isServiceClient(db), false);
    assert.equal(await countUnread(db, B), 2);
  });

  test("the note on countUnread says RLS; the note on the escalated one says the filter", () => {
    const text = src("lib/inbox.ts");
    const escalated = text.slice(text.indexOf("countUnreadForOwner"));
    assert.match(escalated, /IS THE GUARD/i, "the escalated count still calls its filter an index hint");
  });
});

/* ================================ 3. the index the badge's count needs ==== */

const MIGRATIONS = [
  "0001_core_schema.sql", "0002_rls_policies.sql", "0003_project_manual.sql",
  "0004_profiles.sql", "0005_tasks.sql", "0006_seed_clients.sql",
  "0007_own_tasks_only.sql", "0008_agent_tokens.sql", "0009_automation_schema.sql",
  "0010_activity_audit_trail.sql", "0011_inbox_unread_index.sql",
];

describe("0011 — unread is a partial index, not a heap recheck", { skip: !toolsPresent && "no local Postgres" }, () => {
  test("the index exists, is partial on read_at is null, and 0009's is still there", () => {
    const pg = startClusterWithMigrations(MIGRATIONS);
    try {
      const def = pg.run(
        `select indexdef from pg_indexes where schemaname='public' and indexname='inbox_items_unread_idx'`,
      );
      assert.match(def, /\(profile_id\)/, `not keyed on profile_id: ${def}`);
      assert.match(def, /where \(read_at IS NULL\)/i, `not partial on read_at: ${def}`);
      assert.equal(
        pg.run(`select count(*) from pg_indexes where indexname='inbox_items_profile_idx'`),
        "1",
        "0009's index was replaced rather than added to",
      );
    } finally {
      pg.stop();
    }
  });

  test("the planner actually chooses it for the badge's count", () => {
    const pg = startClusterWithMigrations(MIGRATIONS);
    try {
      pg.run(`insert into auth.users (id, email) values ('${A}', 'a@bcn-services.com')`);
      pg.run(`insert into profiles (id, email, display_name) values ('${A}', 'a@bcn-services.com', 'A')`);
      pg.run(`insert into inbox_items (profile_id, kind, title, read_at)
              select '${A}', 'k', 't', now() from generate_series(1, 2000)`);
      pg.run(`insert into inbox_items (profile_id, kind, title) values ('${A}', 'k', 'unread')`);
      pg.run("analyze inbox_items");
      const plan = pg.run(
        `explain (costs off) select count(*) from inbox_items where profile_id = '${A}' and read_at is null`,
      );
      assert.match(plan, /inbox_items_unread_idx/, `the badge's count does not use the index:\n${plan}`);
    } finally {
      pg.stop();
    }
  });

  test("the down migration drops it and leaves the table readable", () => {
    const pg = startClusterWithMigrations(MIGRATIONS);
    try {
      const down = pg.tryRunFile("0011_inbox_unread_index.down.sql");
      assert.ok(down.ok, down.error);
      assert.equal(
        pg.run(`select count(*) from pg_indexes where indexname='inbox_items_unread_idx'`),
        "0",
      );
      assert.equal(pg.run(`select count(*) from inbox_items where read_at is null`), "0");
    } finally {
      pg.stop();
    }
  });
});

/* ==================================== 4/5. the page is paged, not capped == */

describe("the inbox is reachable past the first page", () => {
  const many = (n) =>
    Array.from({ length: n }, (_, i) => row({
      id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`,
      // Descending in i, so row 0 is newest and the 101st ever received is last.
      created_at: `2026-08-${String(1 + Math.floor((n - i) / 40)).padStart(2, "0")}T00:00:${String((n - i) % 60).padStart(2, "0")}Z`,
    }));

  test("a `before` cursor walks past the 100th notice", async () => {
    const tables = { inbox_items: many(140) };
    const first = await listInbox(fakeDb(tables), B, { limit: 100 });
    assert.equal(first.length, 100);
    const older = await listInbox(fakeDb(tables), B, { limit: 100, before: first[99].created_at });
    assert.ok(older.length > 0, "the 101st notice is unreachable — there is no DELETE policy either");
    assert.ok(
      older.every((r) => r.created_at < first[99].created_at),
      "the second page repeats rows from the first",
    );
    const ids = new Set([...first, ...older].map((r) => r.id));
    assert.equal(ids.size, first.length + older.length, "the two pages overlap");
  });

  test("the order is (created_at desc, id desc) so the cursor is stable across ties", async () => {
    const db = fakeDb({ inbox_items: [] });
    await listInbox(db, B, { limit: 10 });
    const orders = db.calls.at(-1).ops.filter(([n]) => n === "order");
    assert.deepEqual(orders.map(([, col]) => col), ["created_at", "id"], "a tie has no tiebreak");
    for (const [, , o] of orders) assert.equal(o.ascending, false);
  });

  test("the page offers the cursor, and takes its unread number from a COUNT", () => {
    const page = code("app/inbox/page.tsx");
    assert.match(page, /before/, "no cursor is passed to listInbox");
    assert.match(page, /countUnread\(/, "the header count is still filtered from the capped page");
    assert.doesNotMatch(
      page,
      /const unread = items\.filter/,
      "page unread is derived from the truncated array and will disagree with the nav badge",
    );
    assert.match(page, /\/inbox\?before=/, "there is no way to ask for older notices");
  });

  test("the page resolves slugs by id rather than reading every client", async () => {
    const page = code("app/inbox/page.tsx");
    assert.doesNotMatch(page, /listClients\(/, "the whole client table is still read for one slug");
    const db = fakeDb({ clients: [{ id: "c1", slug: "coventry" }, { id: "c2", slug: "diner" }] });
    assert.deepEqual((await listClientsByIds(db, ["c2"])).map((c) => c.slug), ["diner"]);
    assert.deepEqual(db.calls.at(-1).ops.find(([n]) => n === "in"), ["in", "id", ["c2"]]);
    // No ids on the page means no query at all.
    assert.deepEqual(await listClientsByIds(db, []), []);
    assert.equal(db.calls.length, 1);
  });
});

/* ============================== 6/11. a notice never fails the thing it follows */

describe("a notice cannot undo a write that already committed", () => {
  test("notifyAssigned owns its failures and runs after the revalidate", () => {
    const text = code("app/tasks/actions.ts");
    const body = text.slice(text.indexOf("async function notifyAssigned"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);
    assert.match(fn, /try \{/, "getViewer()/getServiceClient() throwing still fails the caller's action");
    assert.match(fn, /catch/);
    for (const impl of ["addTaskImpl", "setAssigneeImpl"]) {
      const b = text.slice(text.indexOf(`async function ${impl}`));
      const one = b.slice(0, b.indexOf("\n}\n"));
      assert.ok(
        one.indexOf("revalidatePath") < one.indexOf("notifyAssigned("),
        `${impl} notifies before revalidating; a throw there turns a saved task into {ok:false}`,
      );
    }
  });

  test("a failed mark-read still revalidates, so the button does not silently lie", () => {
    const text = code("app/inbox/actions.ts");
    const c = text.slice(text.indexOf("catch"), text.lastIndexOf("revalidateTag"));
    assert.doesNotMatch(c, /\breturn\b/, "a swallowed setRead failure skips the revalidate");
  });
});

/* ======================================== 7. busy is backpressure, not failure */

describe("a busy runner posts no permanent inbox row", () => {
  const ACCT = "11111111-1111-4111-8111-111111111111";
  const deps = (run) => {
    const svc = fakeDb({ job_runs: [], inbox_items: [] });
    return {
      svc,
      deps: {
        viewer: {
          role: "member",
          userId: B,
          email: "brandon@bcn-services.com",
          db: fakeDb({ accounts: [{ id: ACCT, business_name: "Coventry Roofing" }] }),
        },
        serviceDb: svc,
        run,
      },
    };
  };
  const post = () =>
    new Request("http://localhost/api/skills/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill: "pitch" }),
    });

  test("503 busy writes nothing to the inbox — every client retry would add one", async () => {
    const { deps: d, svc } = deps(async () => ({ ok: false, busy: true, error: "the agent is busy" }));
    const res = await handleSkillRun(post(), d);
    assert.equal(res.status, 503);
    assert.equal(svc.calls.filter((c) => c.table === "inbox_items").length, 0, "backpressure posted a notice");
  });

  test("a real failure still tells the person", async () => {
    const { deps: d, svc } = deps(async () => ({ ok: false, error: "the model refused" }));
    const res = await handleSkillRun(post(), d);
    assert.equal(res.status, 502);
    assert.equal(svc.calls.filter((c) => c.table === "inbox_items").length, 1);
  });
});
