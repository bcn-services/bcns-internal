/**
 * agent-verbs.test.mjs — the authorization and shape guarantees of lib/agent/verbs/.
 *
 * Everything here drives the REAL entry point (`verb.run` / `callVerb`), never a
 * helper reimplementing the rule. A test that asserted money stripping by
 * calling `stripMoney` directly would prove the redactor works and nothing about
 * whether any verb actually routes through it.
 *
 * The network/subprocess verbs are exercised in agent-verbs-io.test.mjs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  VERBS, VERB_NAMES, callVerb, toolSchemas, verbsFor,
  leads_query, leads_stats, clients_query, tasks_write, log_activity,
  profiles_query, inbox_post, activity_query, leads_write, tasks_query, stripMoney, clients_write,
} from "../lib/agent/verbs/index.ts";
import { fakeDb } from "./helpers/fake-db.mjs";

/* ------------------------------------------------------------ identities -- */

const ADMIN = {
  profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "nate@bcn-services.com",
  role: "admin",
};
const MEMBER = {
  profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  email: "brandon@bcn-services.com",
  role: "member",
};
const MEMBER2 = {
  profileId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  email: "casey@bcn-services.com",
  role: "member",
};

const ACCT = "11111111-1111-4111-8111-111111111111";
const ACCT2 = "22222222-2222-4222-8222-222222222222";
const TASK = "44444444-4444-4444-8444-444444444444";

/**
 * The seeded fixture every data test reads. Deliberately more than one row of
 * each kind, and every assertion below matches by id or by an explicit value —
 * never by array position, which silently matches the wrong row the moment a
 * fixture grows.
 */
function fixture() {
  return {
    accounts: [
      { id: ACCT, business_name: "Coventry Contracting", status: "won", assigned_to: MEMBER.profileId,
        deal_value_cents: 150000, outreach_mode: "ai", account_id: null, created_at: "2026-01-02" },
      { id: ACCT2, business_name: "Untouched Diner", status: "new", assigned_to: null,
        deal_value_cents: null, outreach_mode: "ai", created_at: "2026-01-01" },
    ],
    clients: [
      { id: "33333333-3333-4333-8333-333333333333", account_id: ACCT, slug: "coventry",
        status: "active", monthly_rate_cents: 15000, domain: "coventrycontracting.com",
        created_at: "2026-01-01", updated_at: "2026-01-01" },
    ],
    profiles: [
      { id: ADMIN.profileId, email: ADMIN.email, display_name: "Nate", active: true,
        job_function: "ops", last_briefed_at: null },
      { id: MEMBER.profileId, email: MEMBER.email, display_name: "Brandon", active: true,
        job_function: "sales", last_briefed_at: null },
      { id: MEMBER2.profileId, email: MEMBER2.email, display_name: "Casey", active: true,
        job_function: "developer", last_briefed_at: null },
    ],
    tasks: [
      // Brandon: 2 open (todo + doing) and 2 closed, which must NOT be counted.
      { id: "t1", title: "Call Coventry", assigned_to: MEMBER.profileId, status: "todo", account_id: ACCT, due_date: "2026-02-01", created_at: "2026-01-01" },
      { id: "t2", title: "Send quote", assigned_to: MEMBER.profileId, status: "doing", account_id: ACCT, due_date: null, created_at: "2026-01-02" },
      { id: "t3", title: "Old thing", assigned_to: MEMBER.profileId, status: "done", account_id: null, due_date: null, created_at: "2026-01-03" },
      { id: "t4", title: "Dropped", assigned_to: MEMBER.profileId, status: "cancelled", account_id: null, due_date: null, created_at: "2026-01-04" },
      // Nate: exactly 1 open.
      { id: "t5", title: "Invoice run", assigned_to: ADMIN.profileId, status: "todo", account_id: null, due_date: "2026-03-01", created_at: "2026-01-05" },
      // Unassigned open work must land on nobody's count.
      { id: "t6", title: "Nobody's", assigned_to: null, status: "todo", account_id: null, due_date: null, created_at: "2026-01-06" },
      { id: TASK, title: "Updatable", assigned_to: null, status: "todo", account_id: null, due_date: null, created_at: "2026-01-07" },
    ],
    account_activity: [
      { id: "a1", account_id: ACCT, kind: "call", note: "first", actor_email: MEMBER.email, created_at: "2026-01-01" },
      { id: "a2", account_id: ACCT, kind: "agent_run", note: "looked", actor_email: null, created_at: "2026-01-03" },
      { id: "a3", account_id: ACCT2, kind: "note", note: "other account", actor_email: null, created_at: "2026-01-02" },
    ],
    inbox_items: [],
  };
}

/** Minimal valid input per verb, so a role-gate test never trips on validation. */
const SAMPLE_INPUT = {
  leads_query: {},
  leads_write: { id: ACCT, status: "reached" },
  leads_stats: {},
  clients_query: {},
  clients_write: { slug: "coventry", status: "active" },
  tasks_query: {},
  tasks_write: { title: "x" },
  activity_query: { accountId: ACCT },
  log_activity: { accountId: ACCT, kind: "call", note: "hi" },
  profiles_query: {},
  inbox_post: { profileId: ADMIN.profileId, kind: "x", title: "y" },
  read_site: { url: "https://example.com" },
  os_publish: { message: "m" },
  search_places: { query: "plumbers" },
};

/* -------------------------------------------------------------- registry -- */

describe("verb registry", () => {
  test("holds all fourteen verbs, keyed by their own name", () => {
    assert.equal(VERB_NAMES.length, 14);
    for (const [key, verb] of Object.entries(VERBS)) {
      assert.equal(verb.name, key, `${key} is registered under a different name`);
    }
    for (const expected of [
      "leads_query", "leads_write", "leads_stats", "clients_query", "clients_write",
      "tasks_query", "tasks_write", "activity_query", "log_activity", "profiles_query",
      "inbox_post", "read_site", "os_publish", "search_places",
    ]) {
      assert.ok(VERB_NAMES.includes(expected), `missing verb: ${expected}`);
    }
  });

  test("every verb exports a model-ready JSON schema in the same shape", () => {
    for (const verb of Object.values(VERBS)) {
      const s = verb.schema;
      assert.equal(s.name, verb.name);
      assert.ok(s.description.length > 20, `${verb.name} has a stub description`);
      assert.equal(s.input_schema.type, "object");
      assert.equal(s.input_schema.additionalProperties, false);
      assert.ok(Array.isArray(s.input_schema.required));
      for (const req of s.input_schema.required) {
        assert.ok(
          Object.hasOwn(s.input_schema.properties, req),
          `${verb.name}: required field ${req} has no property definition`,
        );
      }
      for (const [name, prop] of Object.entries(s.input_schema.properties)) {
        assert.ok(prop.type, `${verb.name}.${name} has no type`);
        assert.ok(prop.description, `${verb.name}.${name} has no description`);
      }
    }
  });

  test("toolSchemas is scoped by role — a member is never shown an admin verb", () => {
    const memberNames = toolSchemas("member").map((s) => s.name);
    const adminNames = toolSchemas("admin").map((s) => s.name);
    assert.equal(adminNames.length, 14);
    for (const adminOnly of ["clients_write", "os_publish", "search_places"]) {
      assert.ok(!memberNames.includes(adminOnly), `${adminOnly} leaked into the member tool list`);
      assert.ok(adminNames.includes(adminOnly));
    }
    assert.equal(verbsFor("member").length, memberNames.length);
  });

  test("an unknown verb name is a typed error, not a throw", async () => {
    const r = await callVerb("rm_rf", { caller: ADMIN });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
    assert.match(r.error.message, /no such verb/);
  });

  test("an inherited Object.prototype key is not a verb", async () => {
    // `VERBS["toString"]` is truthy and is not a verb: calling `.run` on it
    // throws a raw TypeError straight out of callVerb, past every typed error.
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      const r = await callVerb(name, { caller: ADMIN });
      assert.equal(r.ok, false, `${name} was dispatched`);
      assert.equal(r.error.code, "invalid_input", `${name}: ${JSON.stringify(r.error)}`);
      assert.match(r.error.message, /no such verb/);
    }
  });
});

/* ---------------------------------------------------------- the role gate -- */

describe("authorization: every verb, every caller", () => {
  test("a caller whose role lacks permission gets a typed forbidden, not a throw", async () => {
    for (const verb of Object.values(VERBS)) {
      for (const caller of [ADMIN, MEMBER]) {
        if (verb.roles.includes(caller.role)) continue;
        const ctx = { caller, db: fakeDb(fixture()), osDir: "/nonexistent-on-purpose" };
        const r = await verb.run(ctx, SAMPLE_INPUT[verb.name]);
        assert.equal(r.ok, false, `${verb.name} allowed a ${caller.role}`);
        assert.equal(r.error.code, "forbidden", `${verb.name} used the wrong code`);
        assert.match(r.error.message, new RegExp(verb.name));
      }
    }
  });

  test("at least one verb is actually admin-only, so the loop above proves something", () => {
    const adminOnly = Object.values(VERBS).filter((v) => !v.roles.includes("member"));
    assert.deepEqual(
      adminOnly.map((v) => v.name).sort(),
      ["clients_write", "os_publish", "search_places"],
    );
  });

  test("NO verb defaults to admin: a missing caller is refused outright", async () => {
    for (const verb of Object.values(VERBS)) {
      const r = await verb.run({ db: fakeDb(fixture()) }, SAMPLE_INPUT[verb.name]);
      assert.equal(r.ok, false, `${verb.name} ran without a caller`);
      assert.equal(r.error.code, "invalid_input", `${verb.name}: ${JSON.stringify(r.error)}`);
    }
  });

  test("a role outside admin|member is refused, not treated as a member", async () => {
    for (const role of ["service_role", "anon", "ADMIN", "", null, undefined]) {
      const r = await leads_query.run(
        { caller: { ...ADMIN, role }, db: fakeDb(fixture()) },
        {},
      );
      assert.equal(r.ok, false, `role ${String(role)} was accepted`);
      assert.equal(r.error.code, "invalid_input");
    }
  });

  test("a malformed caller identity is refused before any query is issued", async () => {
    const db = fakeDb(fixture());
    for (const caller of [
      { ...ADMIN, profileId: "not-a-uuid" },
      { ...ADMIN, email: "   " },
      { ...ADMIN, email: undefined },
    ]) {
      const r = await leads_query.run({ caller, db }, {});
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "invalid_input");
    }
    assert.equal(db.calls.length, 0, "a rejected caller still reached the database");
  });
});

/* ------------------------------------------------------------------ money -- */

describe("money stripping", () => {
  test("clients_query as a member returns rows with monthly_rate_cents ABSENT", async () => {
    const r = await clients_query.run({ caller: MEMBER, db: fakeDb(fixture()) }, {});
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const row = r.data.find((c) => c.slug === "coventry");
    assert.ok(row, "the coventry client did not come back");
    assert.equal(Object.hasOwn(row, "monthly_rate_cents"), false,
      "monthly_rate_cents was present for a member");
    // Absent, not nulled: null already means "rate never recorded".
    assert.equal(row.monthly_rate_cents, undefined);
    assert.equal(row.slug, "coventry");
    assert.equal(row.business_name, "Coventry Contracting");
  });

  test("clients_query as an admin returns monthly_rate_cents PRESENT, with its value", async () => {
    const r = await clients_query.run({ caller: ADMIN, db: fakeDb(fixture()) }, {});
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const row = r.data.find((c) => c.slug === "coventry");
    assert.equal(Object.hasOwn(row, "monthly_rate_cents"), true);
    assert.equal(row.monthly_rate_cents, 15000);
  });

  test("leads_query strips deal_value_cents for a member and keeps it for an admin", async () => {
    const asMember = await leads_query.run({ caller: MEMBER, db: fakeDb(fixture()) }, {});
    const won = asMember.data.find((a) => a.id === ACCT);
    assert.equal(Object.hasOwn(won, "deal_value_cents"), false);

    const asAdmin = await leads_query.run({ caller: ADMIN, db: fakeDb(fixture()) }, {});
    assert.equal(asAdmin.data.find((a) => a.id === ACCT).deal_value_cents, 150000);
  });

  test("stripping reaches a money field nested inside an object", () => {
    // The verbs' current selects embed only business_name, so no live verb can
    // produce a nested money field today. This asserts the REDACTOR is
    // recursive so that the day one does, it is already covered — the routing
    // guarantee (that verbs go through it at all) is the three tests above.
    const nested = stripMoney(
      { slug: "x", account: { business_name: "Coventry", deal_value_cents: 150000 },
        rows: [{ monthly_rate_cents: 1 }] },
      "member",
    );
    assert.equal(Object.hasOwn(nested.account, "deal_value_cents"), false);
    assert.equal(nested.account.business_name, "Coventry");
    assert.equal(Object.hasOwn(nested.rows[0], "monthly_rate_cents"), false);
    assert.deepEqual(stripMoney({ deal_value_cents: 7 }, "admin"), { deal_value_cents: 7 });
  });

  test("tasks_query returns its embeds intact for a member", async () => {
    const r = await tasks_query.run(
      { caller: MEMBER, db: fakeDb(fixture()) }, { accountId: ACCT, openOnly: true });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const row = r.data.find((t) => t.id === "t1");
    assert.equal(row.account.business_name, "Coventry Contracting");
    assert.equal(row.assignee.display_name, "Brandon");
    assert.deepEqual(r.data.map((t) => t.id).sort(), ["t1", "t2"]);
  });
});

/* ------------------------------------------------------------- secrets -- */

describe("secrets never ride out on an error", () => {
  test("a database error quoting the service-role key is redacted", async () => {
    const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb-secret-value-abcdef123456";
    try {
      const db = fakeDb(fixture(), {
        failOn: { accounts: "connect failed for apikey=sb-secret-value-abcdef123456" },
      });
      const r = await leads_stats.run({ caller: ADMIN, db }, {});
      assert.equal(r.ok, false);
      assert.ok(!r.error.message.includes("sb-secret-value-abcdef123456"), r.error.message);
      assert.match(r.error.message, /redacted/);
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
    }
  });
});

/* ------------------------------------------------------- profiles_query -- */

describe("profiles_query open-task load", () => {
  test("each profile carries its count of OPEN assigned tasks", async () => {
    const r = await profiles_query.run({ caller: ADMIN, db: fakeDb(fixture()) }, {});
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const by = new Map(r.data.map((p) => [p.id, p]));
    assert.equal(by.size, 3);
    // Matched by id, never by position.
    assert.equal(by.get(MEMBER.profileId).openTasks, 2, "todo+doing for Brandon");
    assert.equal(by.get(ADMIN.profileId).openTasks, 1);
    assert.equal(by.get(MEMBER2.profileId).openTasks, 0, "a profile with no tasks must report 0");
  });

  test("done and cancelled tasks are excluded — the fixture has both", async () => {
    const tables = fixture();
    const brandonTotal = tables.tasks.filter((t) => t.assigned_to === MEMBER.profileId).length;
    assert.equal(brandonTotal, 4, "fixture no longer distinguishes open from closed");
    const r = await profiles_query.run({ caller: ADMIN, db: fakeDb(tables) }, {});
    assert.equal(r.data.find((p) => p.id === MEMBER.profileId).openTasks, 2);
  });

  test("an unassigned open task is counted against nobody", async () => {
    const r = await profiles_query.run({ caller: ADMIN, db: fakeDb(fixture()) }, {});
    const total = r.data.reduce((n, p) => n + p.openTasks, 0);
    assert.equal(total, 3, "the unassigned todo leaked into someone's load");
  });

  test("job_function and last_briefed_at from 0009 come back", async () => {
    const r = await profiles_query.run({ caller: MEMBER, db: fakeDb(fixture()) }, {});
    const casey = r.data.find((p) => p.email === MEMBER2.email);
    assert.equal(casey.job_function, "developer");
    assert.equal(casey.last_briefed_at, null);
  });

  test("a bad profile id is rejected before the query", async () => {
    const db = fakeDb(fixture());
    const r = await profiles_query.run({ caller: ADMIN, db }, { id: "nope" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
    assert.equal(db.calls.length, 0);
  });
});

/* ---------------------------------------------------------- log_activity -- */

describe("log_activity", () => {
  // The free-text path is implemented in lib/agent/activity-parse.ts and
  // exercised in tests/activity-parse.test.mjs, where the runner can be stubbed.
  // What stays asserted HERE is the property that survived the change: with no
  // parser reachable, the verb still writes nothing rather than guessing.
  test("free text with no parser injected is not_configured AND writes no row", async () => {
    const tables = fixture();
    const before = tables.account_activity.length;
    const r = await log_activity.run(
      { caller: MEMBER, db: fakeDb(tables) },
      { accountId: ACCT, text: "called Mike at Coventry Tuesday, wants a quote by Friday" },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_configured");
    // The negative side effect, checked on the real store the verb writes to.
    assert.equal(tables.account_activity.length, before, "the parse path wrote a row anyway");
  });

  test("an explicit human kind writes exactly one row, stamped with the CALLER's email", async () => {
    const tables = fixture();
    const before = tables.account_activity.length;
    const r = await log_activity.run(
      { caller: MEMBER, db: fakeDb(tables) },
      { accountId: ACCT, kind: "call", note: "spoke to Mike" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.account_activity.length, before + 1);
    const written = tables.account_activity.find((a) => a.note === "spoke to Mike");
    assert.equal(written.kind, "call");
    assert.equal(written.account_id, ACCT);
    assert.equal(written.actor_email, MEMBER.email, "actor_email was not the authenticated caller");
  });

  test("the three agent kinds are refused for EVERY caller, admin included", async () => {
    for (const caller of [MEMBER, ADMIN]) {
      for (const kind of ["ai_email_sent", "ai_email_reply", "agent_run"]) {
        const tables = fixture();
        const before = tables.account_activity.length;
        const r = await log_activity.run({ caller, db: fakeDb(tables) }, { accountId: ACCT, kind });
        assert.equal(r.ok, false, `${caller.role} wrote ${kind}`);
        assert.equal(r.error.code, "forbidden");
        assert.equal(tables.account_activity.length, before, `${kind} was written anyway`);
      }
    }
  });

  test("neither kind nor text is invalid_input, and still writes nothing", async () => {
    const tables = fixture();
    const r = await log_activity.run({ caller: MEMBER, db: fakeDb(tables) }, { accountId: ACCT });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
    assert.equal(tables.account_activity.length, 3);
  });
});

/* ------------------------------------------------------- the rest, briefly -- */

describe("input validation and derived behaviour", () => {
  test("activity_query returns only the named account's timeline, newest first", async () => {
    const r = await activity_query.run({ caller: MEMBER, db: fakeDb(fixture()) }, { accountId: ACCT });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(r.data.map((a) => a.id), ["a2", "a1"]);
    assert.ok(!r.data.some((a) => a.account_id === ACCT2));
  });

  test("leads_stats counts by stage and reports the open figure", async () => {
    const r = await leads_stats.run({ caller: MEMBER, db: fakeDb(fixture()) }, {});
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.total, 2);
    assert.equal(r.data.byStage.won, 1);
    assert.equal(r.data.byStage.new, 1);
    assert.equal(r.data.open, 1, "won is terminal and must not count as open");
    assert.equal(r.data.unassigned, 1);
  });

  test("clients_write refuses a negative or absurd monthly rate", async () => {
    for (const rate of ["-500", -1, "-0.01", "1000000", 99_999_999]) {
      const tables = fixture();
      const db = fakeDb(tables);
      const r = await clients_write.run({ caller: ADMIN, db }, { slug: "coventry", monthlyRateDollars: rate });
      assert.equal(r.ok, false, `${rate} was accepted`);
      assert.equal(r.error.code, "invalid_input", `${rate}: ${JSON.stringify(r.error)}`);
      assert.equal(
        tables.clients[0].monthly_rate_cents, 15000,
        `${rate} was written to the client row`,
      );
    }
  });

  test("clients_write still accepts a normal rate", async () => {
    const tables = fixture();
    const r = await clients_write.run(
      { caller: ADMIN, db: fakeDb(tables) },
      { slug: "coventry", monthlyRateDollars: "149.99" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.clients[0].monthly_rate_cents, 14999);
  });

  test("leads_stats pages past PostgREST's row cap instead of reporting it as the total", async () => {
    const tables = fixture();
    tables.accounts = Array.from({ length: 1500 }, (_, i) => ({
      id: `acct-${String(i).padStart(5, "0")}`,
      business_name: `Lead ${i}`,
      status: i % 3 === 0 ? "won" : "new",
      assigned_to: i % 2 === 0 ? MEMBER.profileId : null,
      created_at: "2026-01-01",
    }));
    const db = fakeDb(tables, { maxRows: 1000 });
    const r = await leads_stats.run({ caller: ADMIN, db }, {});
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.total, 1500, "the count stopped at the server's row cap");
    assert.equal(r.data.byStage.won, 500);
    assert.equal(r.data.byStage.new, 1000);
    assert.equal(r.data.open, 1000, "won is terminal");
    assert.equal(r.data.unassigned, 750);
    assert.equal(r.data.truncated, false, "1500 rows is inside the ceiling");
    // Paged, not one unbounded select.
    const ranges = db.calls.flatMap((c) => c.ops.filter((o) => o[0] === "range"));
    assert.ok(ranges.length >= 2, "leads_stats issued no range query");
  });

  test("leads_query caps at the DATABASE, not with a slice after the fetch", async () => {
    const tables = fixture();
    tables.accounts = Array.from({ length: 40 }, (_, i) => ({
      id: `acct-${i}`, business_name: `Lead ${i}`, status: "new", assigned_to: null,
      deal_value_cents: null, created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    const db = fakeDb(tables);
    const r = await leads_query.run({ caller: ADMIN, db }, { limit: 5 });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.length, 5);
    const limits = db.calls.flatMap((c) => c.ops.filter((o) => o[0] === "limit"));
    assert.deepEqual(limits, [["limit", 5]], "the cap never reached the query");

    // The default is pushed down too, not just an explicit one.
    const db2 = fakeDb(tables);
    await leads_query.run({ caller: ADMIN, db: db2 }, {});
    assert.deepEqual(
      db2.calls.flatMap((c) => c.ops.filter((o) => o[0] === "limit")),
      [["limit", 50]],
    );
  });

  test("leads_write applies status, owner and outreach mode in ONE update", async () => {
    const tables = fixture();
    const db = fakeDb(tables);
    const r = await leads_write.run(
      { caller: ADMIN, db },
      { id: ACCT, status: "lost", assignedTo: MEMBER2.profileId, outreachMode: "paused" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const updates = db.calls.flatMap((c) => c.ops.filter((o) => o[0] === "update"));
    assert.equal(updates.length, 1, "three fields cost three un-transacted round trips");
    assert.deepEqual(updates[0][1], {
      status: "lost", assigned_to: MEMBER2.profileId, outreach_mode: "paused",
    });
    const row = tables.accounts.find((a) => a.id === ACCT);
    assert.equal(row.status, "lost");
    assert.equal(row.assigned_to, MEMBER2.profileId);
    assert.equal(row.outreach_mode, "paused");
  });

  test("leads_write leaves NOTHING applied when the single update fails", async () => {
    const tables = fixture();
    const before = { ...tables.accounts.find((a) => a.id === ACCT) };
    const db = fakeDb(tables, { failOn: { accounts: "update rejected" } });
    const r = await leads_write.run(
      { caller: ADMIN, db },
      { id: ACCT, status: "lost", assignedTo: MEMBER2.profileId },
    );
    assert.equal(r.ok, false);
    assert.deepEqual(tables.accounts.find((a) => a.id === ACCT), before, "a partial write survived");
  });

  test("tasks_write applies status and assignee in ONE update and returns the final row", async () => {
    const tables = fixture();
    const db = fakeDb(tables);
    const r = await tasks_write.run(
      { caller: ADMIN, db },
      { id: TASK, status: "doing", assignedTo: MEMBER.profileId },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const updates = db.calls.flatMap((c) => c.ops.filter((o) => o[0] === "update"));
    assert.equal(updates.length, 1, "status and assignee were written separately");
    assert.deepEqual(updates[0][1], { status: "doing", assigned_to: MEMBER.profileId });
    // The returned row carries BOTH changes, not just the last write's.
    assert.equal(r.data.status, "doing");
    assert.equal(r.data.assigned_to, MEMBER.profileId);
  });

  test("leads_write with nothing to change is invalid_input", async () => {
    const r = await leads_write.run({ caller: MEMBER, db: fakeDb(fixture()) }, { id: ACCT });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
  });

  test("leads_write sets outreach_mode and rejects an unknown one", async () => {
    const tables = fixture();
    const good = await leads_write.run(
      { caller: MEMBER, db: fakeDb(tables) }, { id: ACCT, outreachMode: "paused" });
    assert.equal(good.ok, true, JSON.stringify(good.error));
    assert.equal(tables.accounts.find((a) => a.id === ACCT).outreach_mode, "paused");

    const bad = await leads_write.run(
      { caller: MEMBER, db: fakeDb(fixture()) }, { id: ACCT, outreachMode: "off" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "invalid_input");
  });

  test("tasks_write stamps created_by with the caller and ignores any supplied author", async () => {
    const tables = fixture();
    const r = await tasks_write.run(
      { caller: MEMBER, db: fakeDb(tables) },
      { title: "New work", createdBy: ADMIN.profileId, created_by: ADMIN.profileId },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const row = tables.tasks.find((t) => t.title === "New work");
    assert.equal(row.created_by, MEMBER.profileId, "a task author could be forged");
  });

  test("tasks_write needs a title to create or an id to update", async () => {
    const r = await tasks_write.run({ caller: MEMBER, db: fakeDb(fixture()) }, {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
  });

  test("tasks_write updates status through the real entry point", async () => {
    const tables = fixture();
    const r = await tasks_write.run(
      { caller: MEMBER, db: fakeDb(tables) }, { id: TASK, status: "done" });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.tasks.find((t) => t.id === TASK).status, "done");
  });

  test("inbox_post: a member may post to themselves but not to a colleague", async () => {
    const mine = fixture();
    const self = await inbox_post.run(
      { caller: MEMBER, db: fakeDb(mine) },
      { profileId: MEMBER.profileId, kind: "reminder", title: "log that call" },
    );
    assert.equal(self.ok, true, JSON.stringify(self.error));
    assert.equal(mine.inbox_items.length, 1);
    assert.equal(mine.inbox_items[0].profile_id, MEMBER.profileId);

    const theirs = fixture();
    const other = await inbox_post.run(
      { caller: MEMBER, db: fakeDb(theirs) },
      { profileId: ADMIN.profileId, kind: "reminder", title: "planted" },
    );
    assert.equal(other.ok, false);
    assert.equal(other.error.code, "forbidden");
    assert.equal(theirs.inbox_items.length, 0, "a member planted a notice in another inbox");
  });

  test("inbox_post: an admin may post to anyone", async () => {
    const tables = fixture();
    const r = await inbox_post.run(
      { caller: ADMIN, db: fakeDb(tables) },
      { profileId: MEMBER.profileId, kind: "brief", title: "morning brief", sourceJob: "briefing" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.inbox_items[0].source_job, "briefing");
  });

  test("a missing database client is not_configured, never a crash", async () => {
    for (const verb of [leads_query, clients_query, profiles_query, log_activity, inbox_post]) {
      const r = await verb.run({ caller: ADMIN }, SAMPLE_INPUT[verb.name]);
      assert.equal(r.ok, false, verb.name);
      assert.equal(r.error.code, "not_configured", `${verb.name}: ${JSON.stringify(r.error)}`);
    }
  });

  test("a throw escaping the data layer becomes a typed error", async () => {
    const r = await leads_query.run(
      { caller: ADMIN, db: fakeDb(fixture(), { throwOn: "accounts" }) },
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "internal");
    // The CODE is what the caller acts on. The driver's own text is not
    // forwarded — it can quote a constraint value or a row back at the model.
    assert.ok(!r.error.message.includes("exploding"), r.error.message);
    assert.match(r.error.message, /leads_query failed \(internal\)/);
  });
});
