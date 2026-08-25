/**
 * inbox-qa.test.mjs — INDEPENDENT QA for item 6 (the inbox).
 *
 * Written against the shipped code without reference to the builder's account
 * of it. Three things the builder's own tests could not prove:
 *
 *  1. THE BADGE CACHE KEY. lib/inbox-badge.ts reads the count through the
 *     SERVICE client, which bypasses RLS — so the only thing between one
 *     person's badge and another's inbox is the unstable_cache key. The
 *     builder's badge tests are regex greps over the source, which cannot see a
 *     key collision. Here a fake incremental cache is installed on
 *     globalThis.__incrementalCache (the exact hook next/dist unstable-cache
 *     falls back to outside a render), so the REAL Next code path runs and the
 *     keys it computes are observable. Delete `profileId` from the keyParts and
 *     "two profiles never share a cache entry" fails.
 *
 *  2. MARK-READ AS AN EXISTENCE ORACLE. A denied row and a row that was never
 *     there must be indistinguishable, or the response is a membership probe
 *     for a table that is private even from an admin. Proven on real Postgres
 *     under forged claims, with a superuser re-read for what actually changed.
 *
 *  3. THE REPLY RUNS AS THE SESSION, NOT AS THE JOBS. log_activity is handed
 *     BOTH a cookie-bound db and a service db by app/activity/actions.ts. If
 *     the write ever moved to the service client it would dodge 0010's
 *     append-only policy and its actor_email trigger while every mocked test
 *     stayed green. Two distinct fakes prove which one the row went through,
 *     and real Postgres proves the trigger overrules a forged actor_email.
 *
 * No network, no claude CLI: the parse runner is injected.
 */
// MUST be first: it sets globalThis.AsyncLocalStorage before next/cache loads.
import { installFakeIncrementalCache, uninstallFakeIncrementalCache } from "./helpers/next-cache-harness.mjs";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startClusterWithMigrations, toolsPresent, CLAIMS } from "./helpers/pg-cluster.mjs";
import { fakeDb } from "./helpers/fake-db.mjs";
import { countUnread, setRead, itemHref } from "../lib/inbox.ts";
import { cachedUnreadCount, unreadTag, BADGE_TTL_SECONDS } from "../lib/inbox-badge.ts";
import { log_activity } from "../lib/agent/verbs/log_activity.ts";

const MIGRATIONS = [
  "0001_core_schema.sql", "0002_rls_policies.sql", "0003_project_manual.sql",
  "0004_profiles.sql", "0005_tasks.sql", "0006_seed_clients.sql",
  "0007_own_tasks_only.sql", "0008_agent_tokens.sql", "0009_automation_schema.sql",
  "0010_activity_audit_trail.sql",
];

const A = "dddddddd-0000-4000-8000-000000000001"; // admin
const B = "dddddddd-0000-4000-8000-000000000002"; // member
const ACCOUNT = "dddddddd-0000-4000-8000-0000000000a1";
const B_ITEM = "dddddddd-0000-4000-8000-0000000000b1";
const A_ITEM = "dddddddd-0000-4000-8000-0000000000a2";
const GHOST = "dddddddd-0000-4000-8000-00000000dead"; // an id that never existed

const claimsA = { sub: A, app_metadata: { role: "admin" }, email: "a@bcn-services.com" };
const claimsB = { sub: B, app_metadata: { role: "member" }, email: "b@bcn-services.com" };

/* ============================================================== 1. badge == */

describe("item 6 QA — the badge cache is per-profile", () => {
  after(() => uninstallFakeIncrementalCache());

  // The badge no longer takes a caller-supplied loader — an id plus an
  // arbitrary closure over an RLS-bypassing client was a shape item 7 would
  // have copied. It takes the getViewer() result and a client FACTORY, and
  // builds the query itself. So these fixtures are rows, not numbers.
  const unreadRows = (profileId, n, from = 1) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${profileId.slice(0, 8)}-0000-4000-8000-${String(from + i).padStart(12, "0")}`,
      profile_id: profileId, kind: "k", title: "t", body: null, source_job: null,
      account_id: null, client_id: null, read_at: null, created_at: "2026-08-01T00:00:00Z",
    }));

  test("two profiles never share a cache entry", async () => {
    const cache = installFakeIncrementalCache();
    const db = fakeDb({ inbox_items: [...unreadRows(A, 7), ...unreadRows(B, 99)] });

    assert.equal(await cachedUnreadCount({ userId: A }, () => db), 7);
    assert.equal(await cachedUnreadCount({ userId: B }, () => db), 99, "B was served A's count");

    // Not merely "the numbers differ": the KEYS must differ, or the only reason
    // B got 99 is that the two reads happened to run different code.
    const [keyA, keyB] = cache.keysSeen;
    assert.notEqual(keyA, keyB, "two profiles computed the same cache key");
    assert.ok(keyA.includes(A), "the viewer's profile id is not in the cache key");
    assert.ok(keyB.includes(B), "the viewer's profile id is not in the cache key");
  });

  test("an IDENTICAL loader for two profiles still lands on separate entries", async () => {
    // The teeth, and now unavoidable rather than contrived: `cb.toString()` is
    // part of Next's key, and since the loader is built INSIDE inbox-badge.ts
    // its source text is byte-identical for every viewer. keyParts is the only
    // thing left that can separate them.
    const cache = installFakeIncrementalCache();
    const db = fakeDb({ inbox_items: [...unreadRows(A, 4), ...unreadRows(B, 41)] });

    assert.equal(await cachedUnreadCount({ userId: A }, () => db), 4);
    assert.equal(await cachedUnreadCount({ userId: B }, () => db), 41, "B was served A's cached count");
    assert.equal(cache.store.size, 2, "two profiles shared one cache entry");
  });

  test("signing out and back in as someone else in the SAME process reads fresh", async () => {
    installFakeIncrementalCache();
    const db = fakeDb({ inbox_items: [...unreadRows(A, 4), ...unreadRows(B, 41)] });

    await cachedUnreadCount({ userId: A }, () => db);      // session 1
    await cachedUnreadCount({ userId: B }, () => db);      // session 2, same process
    assert.equal(await cachedUnreadCount({ userId: A }, () => db), 4, "A's badge changed under B");
    assert.equal(await cachedUnreadCount({ userId: B }, () => db), 41, "B's badge changed under A");
  });

  test("a warm entry issues NO query — that is what 'not one per page render' means", async () => {
    installFakeIncrementalCache();
    const db = fakeDb({ inbox_items: unreadRows(A, 3) });
    // Five page renders: the root layout runs on every navigation.
    for (let i = 0; i < 5; i += 1) assert.equal(await cachedUnreadCount({ userId: A }, () => db), 3);
    assert.equal(db.calls.length, 1, `the badge issued ${db.calls.length} queries across 5 page renders`);
  });

  test("a row written after the count was cached is not seen until the tag is revalidated", async () => {
    // The documented cost of the cache, pinned so a later change cannot make it
    // worse quietly. `BADGE_TTL_SECONDS` bounds the staleness; the mutation the
    // owner makes themselves goes through revalidateTag(unreadTag(id)).
    const cache = installFakeIncrementalCache();
    const tables = { inbox_items: unreadRows(A, 1) };
    const db = fakeDb(tables);
    assert.equal(await cachedUnreadCount({ userId: A }, () => db), 1);
    tables.inbox_items.push(...unreadRows(A, 1, 50)); // a job posts a notice
    assert.equal(await cachedUnreadCount({ userId: A }, () => db), 1, "the cache is not actually caching");
    cache.store.clear(); // what revalidateTag(unreadTag(A)) amounts to here
    assert.equal(await cachedUnreadCount({ userId: A }, () => db), 2);
    assert.ok(BADGE_TTL_SECONDS > 0 && BADGE_TTL_SECONDS <= 300, "unbounded badge staleness");
  });

  test("the revalidation tag is per-profile too", () => {
    assert.notEqual(unreadTag(A), unreadTag(B), "one person's mark-read would clear another's badge");
    assert.ok(unreadTag(A).includes(A));
  });

  test("no incremental cache renders NO badge rather than a fake zero", async () => {
    uninstallFakeIncrementalCache(); // no store at all
    const db = fakeDb({ inbox_items: unreadRows(A, 9) });
    // null, not 0: "we could not read it" and "you have no mail" are different
    // facts, and only one of them should blank the badge silently.
    assert.equal(await cachedUnreadCount({ userId: A }, () => db), null);
  });
});


/* ================================================== 2. RLS, forged claims == */

describe("item 6 QA — mark-read is not a write path or an oracle", { skip: !toolsPresent && "no local Postgres" }, () => {
  let pg;
  before(() => {
    pg = startClusterWithMigrations(MIGRATIONS);
    pg.run(`insert into auth.users (id, email) values
      ('${A}','a@bcn-services.com'), ('${B}','b@bcn-services.com')`);
    pg.run(`insert into profiles (id, email, display_name) values
      ('${A}','a@bcn-services.com','Ann'), ('${B}','b@bcn-services.com','Bo')`);
    pg.run(`insert into accounts (id, business_name, city, status)
      values ('${ACCOUNT}','QA Inbox Co','Rye','new')`);
    pg.run(`insert into inbox_items (id, profile_id, kind, title, read_at, account_id) values
      ('${B_ITEM}','${B}','task_assigned','B unread', null, '${ACCOUNT}'),
      ('${A_ITEM}','${A}','lead_cold','A unread',     null, null)`);
  });
  after(() => pg?.stop());

  const readAt = (id) => pg.run(`select coalesce(read_at::text,'NULL') from inbox_items where id='${id}'`);

  test("marking a row that is not yours is INDISTINGUISHABLE from marking one that never existed", () => {
    // The oracle test. If a denied row answered differently from a missing one,
    // an admin could enumerate whether a colleague holds a given item id.
    const mark = (id) =>
      pg.runClaims(claimsA, `update inbox_items set read_at=now() where id='${id}';
                             select count(*) from inbox_items where id='${id}' and read_at is not null`);
    const denied = mark(B_ITEM);
    const missing = mark(GHOST);
    assert.equal(denied.ok, true, denied.error);
    assert.equal(missing.ok, true, missing.error);
    assert.equal(denied.out, missing.out, "a denied row answers differently from a missing one");
    // And the superuser, who is not lied to, confirms nothing moved.
    assert.equal(readAt(B_ITEM), "NULL", "an admin marked another profile's row read");
  });

  test("an admin's UPDATE ... RETURNING leaks no row either", () => {
    const r = pg.runClaims(claimsA, `update inbox_items set read_at=now() where id='${B_ITEM}' returning title`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "", "RETURNING handed back another profile's row");
    assert.equal(readAt(B_ITEM), "NULL");
  });

  test("a member cannot hand its OWN row to the admin's inbox", () => {
    // The builder tested admin→member. The other direction is the one that
    // matters more: a member planting mail on the boss.
    const r = pg.runClaims(claimsB, `update inbox_items set profile_id='${A}' where id='${B_ITEM}'`);
    assert.equal(r.ok, false, "a member planted a row in the admin's inbox");
    assert.match(r.error, /row-level security/i);
    assert.equal(pg.run(`select profile_id from inbox_items where id='${B_ITEM}'`), B);
  });

  test("an admin cannot hand a row it cannot see to itself", () => {
    const r = pg.runClaims(claimsA, `update inbox_items set profile_id='${A}' where id='${B_ITEM}';
                                     select count(*) from inbox_items where profile_id='${A}'`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "1", "an admin adopted someone else's item");
    assert.equal(pg.run(`select profile_id from inbox_items where id='${B_ITEM}'`), B);
  });

  test("a tampered claim (role in user_metadata) and a role-less claim both see nothing", () => {
    for (const [label, claims] of [["fake", CLAIMS.fake], ["noRole", CLAIMS.noRole]]) {
      const r = pg.runClaims(claims, `select count(*) from inbox_items`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.out, "0", `${label} claims read the inbox`);
    }
  });

  test("a claim with no `sub` at all reads nothing — auth.uid() null must not match", () => {
    const r = pg.runClaims({ app_metadata: { role: "admin" } }, `select count(*) from inbox_items`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "0");
  });

  test("nobody authenticated may DELETE, so mail cannot be destroyed to hide it", () => {
    const r = pg.runClaims(claimsB, `delete from inbox_items where id='${B_ITEM}';
                                     select count(*) from inbox_items`);
    assert.equal(r.ok, true, r.error);
    assert.equal(pg.run(`select count(*) from inbox_items where id='${B_ITEM}'`), "1");
  });

  test("BOTH policies are owner-scoped — neither may quietly regress to true", () => {
    // Measured: opening the SELECT policy alone still leaves the UPDATE's USING
    // refusing the write, and opening the UPDATE policy alone still leaves the
    // SELECT policy hiding the row from the WHERE clause. Each masks the other,
    // so NO behavioural test can catch one of them regressing on its own. The
    // physical policy definitions are therefore asserted directly — that is the
    // only place a single-sided regression is visible.
    const rows = pg.run(
      `select policyname || '|' || cmd || '|' || coalesce(qual,'-') || '|' || coalesce(with_check,'-')
         from pg_policies where tablename='inbox_items' order by policyname`,
    ).split("\n").filter(Boolean);
    assert.equal(rows.length, 2, `inbox_items has policies it should not: ${rows.join(" ;; ")}`);
    const [upd, sel] = [rows.find((r) => r.includes("|UPDATE|")), rows.find((r) => r.includes("|SELECT|"))];
    assert.ok(sel, "the owner SELECT policy is gone");
    assert.ok(upd, "the owner UPDATE policy is gone");
    for (const [label, row] of [["select", sel], ["update", upd]]) {
      const [, , qual, check] = row.split("|");
      assert.match(qual, /profile_id = auth\.uid\(\)/, `${label} USING is no longer owner-scoped`);
      if (label === "update") {
        assert.match(check, /profile_id = auth\.uid\(\)/, "the UPDATE WITH CHECK is gone — items could be handed away");
      }
    }
    // No INSERT and no DELETE policy at all: mail is posted by the jobs and is
    // never destroyed by the person it is about.
    assert.equal(rows.filter((r) => /\|(INSERT|DELETE|ALL)\|/.test(r)).length, 0);
  });

  test("the harness is not lying: service_role DOES see everything", () => {
    // Without this, every assertion above would also pass against a table that
    // is simply empty or ungranted, and the suite would prove nothing.
    const r = pg.runClaims({}, `select count(*) from inbox_items`, "service_role");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "2", "the fixture never landed — the privacy tests are vacuous");
  });

  test("the owner, and only the owner, may mark their own row", () => {
    // runClaims wraps the statements in a transaction that is rolled back when
    // psql disconnects, so the effect has to be read back in the SAME call.
    const r = pg.runClaims(
      claimsB,
      `update inbox_items set read_at=now() where id='${B_ITEM}';
       select read_at is not null from inbox_items where id='${B_ITEM}'`,
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "t", "the owner could not mark their own item read");
  });

  /* ------------------------------------------------- 3. the reply, live -- */

  test("a reply's actor_email is the REPLYING session, not the payload", () => {
    // 0010's trigger stamps authorship from the JWT. A reply that let the item's
    // recipient or the original poster be named would forge an audit row.
    const r = pg.runClaims(
      claimsB,
      `insert into account_activity (account_id, kind, note, actor_email)
       values ('${ACCOUNT}','call','reply from the inbox','a@bcn-services.com');
       select actor_email || '|' || count(*)::text from account_activity
        where note='reply from the inbox' group by actor_email`,
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "b@bcn-services.com|1", "a reply forged another person's authorship");
  });

  test("a reply cannot be edited or unsent afterwards — the trail is append-only", () => {
    const r = pg.runClaims(
      claimsB,
      `insert into account_activity (account_id, kind, note) values ('${ACCOUNT}','call','the reply');
       update account_activity set note='never happened' where note='the reply';
       delete from account_activity where note='the reply';
       select note from account_activity where actor_email='b@bcn-services.com'`,
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(r.out, "the reply", "the audit trail was rewritten by the session that wrote it");
  });

  test("a reply may not claim an agent kind", () => {
    const r = pg.runClaims(
      claimsB,
      `insert into account_activity (account_id, kind, note) values ('${ACCOUNT}','agent_run','pretending')`,
    );
    assert.equal(r.ok, false, "a person wrote an agent-authored row");
  });
});

/* =================================================== 3. the reply, mocked == */

describe("item 6 QA — a reply writes one row, through the SESSION's client", () => {
  const caller = { profileId: B, email: "b@bcn-services.com", role: "member" };

  test("the row goes through ctx.db, never ctx.serviceDb", async () => {
    // Two distinct fakes. If the write ever moved to the service client it
    // would bypass 0010's append-only policy AND its actor_email trigger, and
    // a single-fake test could not tell.
    const db = fakeDb({ account_activity: [] });
    const serviceDb = fakeDb({ account_activity: [] });
    const res = await log_activity.run(
      { caller, db, serviceDb },
      { accountId: ACCOUNT, kind: "call", note: "rang back", occurredAt: "2026-08-04T14:00:00Z" },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    const inserts = (f) =>
      f.calls.filter((c) => c.table === "account_activity" && c.ops.some(([n]) => n === "insert"));
    assert.equal(inserts(db).length, 1, "a reply must write exactly one row");
    assert.equal(inserts(serviceDb).length, 0, "the reply escalated to the service client");
    const [, row] = inserts(db)[0].ops.find(([n]) => n === "insert");
    assert.equal(row.account_id, ACCOUNT);
    assert.equal(row.actor_email, caller.email);
  });

  test("the parse step writes nothing, on this surface too", async () => {
    const db = fakeDb({ account_activity: [] });
    const serviceDb = fakeDb({ account_activity: [] });
    const res = await log_activity.run(
      {
        caller, db, serviceDb,
        runParse: async () => ({ ok: true, reply: JSON.stringify({ kind: "call", note: "rang back" }) }),
      },
      { accountId: ACCOUNT, text: "rang them back about the quote" },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.written, false);
    for (const f of [db, serviceDb]) {
      assert.equal(
        f.calls.filter((c) => c.table === "account_activity" && c.ops.some(([n]) => n === "insert")).length,
        0,
        "a reply committed before anybody saw it",
      );
    }
  });
});

/* ==================================================== 4. the count fixture == */

describe("item 6 QA — the unread count against seeded fixtures", () => {
  const row = (over) => ({
    id: "cccccccc-0000-4000-8000-00000000000" + (over.n ?? 1),
    profile_id: B, kind: "k", title: "t", body: null, source_job: null,
    account_id: null, client_id: null, read_at: null, created_at: "2026-08-01T00:00:00Z",
    ...over,
  });

  test("zero rows counts zero", async () => {
    assert.equal(await countUnread(fakeDb({ inbox_items: [] }), B), 0);
  });

  test("all read counts zero", async () => {
    const db = fakeDb({
      inbox_items: [row({ n: 1, read_at: "2026-08-02T00:00:00Z" }), row({ n: 2, read_at: "2026-08-02T00:00:00Z" })],
    });
    assert.equal(await countUnread(db, B), 0);
  });

  test("somebody else's unread row is not counted", async () => {
    const db = fakeDb({ inbox_items: [row({ n: 1 }), row({ n: 2, profile_id: A }), row({ n: 3, profile_id: A })] });
    assert.equal(await countUnread(db, B), 1, "the badge counted another person's mail");
    assert.equal(await countUnread(db, A), 2);
  });

  test("a mixed fixture counts only the unread", async () => {
    const db = fakeDb({
      inbox_items: [
        row({ n: 1 }), row({ n: 2 }), row({ n: 3 }),
        row({ n: 4, read_at: "2026-08-02T00:00:00Z" }),
        row({ n: 5, read_at: "2026-08-02T00:00:00Z" }),
        row({ n: 6, profile_id: A }),
      ],
    });
    assert.equal(await countUnread(db, B), 3);
  });

  test("a non-uuid profile id is refused rather than counted", async () => {
    await assert.rejects(() => countUnread(fakeDb({ inbox_items: [] }), "not-a-uuid"));
    await assert.rejects(() => setRead(fakeDb({ inbox_items: [] }), "not-a-uuid", true));
  });
});

/* ================================================== 5. links degrade, not throw */

describe("item 6 QA — a missing link target degrades", () => {
  const item = (over) => ({ account_id: null, client_id: null, ...over });

  test("a client whose slug cannot be resolved falls back to the list", () => {
    assert.equal(itemHref(item({ client_id: "gone" }), () => undefined), "/clients");
  });

  test("an item referencing nothing has no link, and does not throw", () => {
    assert.equal(itemHref(item({})), null);
    assert.equal(itemHref(item({ source_job: "prospector" })), null);
  });

  test("an account link forces the owner filter, or the row would not be on the page", () => {
    // A member's bare /leads defaults to their own leads; a notice about a
    // colleague's lead would land on a page that does not contain it.
    const href = itemHref(item({ account_id: ACCOUNT }));
    assert.ok(href.includes("assigned=anyone"), href);
    assert.ok(href.endsWith(`#account-${ACCOUNT}`), href);
  });
});
