/**
 * notification-routing.test.mjs — item 7: which events email, which do not,
 * and what happens when there is nowhere to send.
 *
 * The four `done when:` criteria are the four describe blocks at the top, in
 * order. Everything after them is the guardrails.
 *
 * THE POINT OF THE FILE is that the routing rule is SETTLED and must not drift:
 * three kinds email (a failed run, a task assigned, a lead wanting a meeting)
 * and three deliberately do not (a briefing, a successful run, an agent
 * proposal), while EVERY kind writes an inbox item. Both halves are asserted
 * for all six, so adding a seventh kind that quietly emails, or dropping one
 * that should, fails here.
 *
 * No provider is configured and none can be: lib/mailer.ts has one adapter and
 * it is a no-op. So "records the undelivered email" is not a fallback path in
 * these tests, it is the only path — which is exactly the state the item ships
 * in. No network, no claude CLI, no production database.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./helpers/fake-db.mjs";
import { markServiceClient } from "../lib/service-client-mark.ts";
import {
  deliverNotification,
  notifyJobRun,
  routeEvent,
  resolveAdmin,
  resolveProfile,
  maySend,
  emailsFor,
  adminEmail,
  EMAIL_EVENTS,
  INBOX_ONLY_EVENTS,
} from "../lib/notify.ts";
import { getMailer, nullMailer } from "../lib/mailer.ts";
import { notifyTaskAssigned } from "../lib/agent/task-nudge.ts";
import { DEFAULT_ADMIN_EMAIL } from "../lib/env.ts";

const NATE = "cccccccc-0000-4000-8000-000000000001";
const BRANDON = "cccccccc-0000-4000-8000-000000000002";
const ACCT = "cccccccc-0000-4000-8000-0000000000a1";

const NATE_EMAIL = DEFAULT_ADMIN_EMAIL;
const BRANDON_EMAIL = "brandon@bcn-services.com";

const profiles = () => [
  { id: NATE, email: NATE_EMAIL, display_name: "Nate", active: true, job_function: null },
  { id: BRANDON, email: BRANDON_EMAIL, display_name: "Brandon", active: true, job_function: null },
];

/** A service-role client with the directory in it, stamped as the real one is. */
const service = (extra = {}) =>
  markServiceClient(fakeDb({ profiles: profiles(), inbox_items: [], email_outbox: [], ...extra }));

const caller = { profileId: BRANDON, email: BRANDON_EMAIL, role: "member" };
const adminCaller = { profileId: NATE, email: NATE_EMAIL, role: "admin" };

/** Read a fake table's rows by replaying an unfiltered select through it. */
async function all(db, table) {
  const res = await db.from(table).select("*");
  return res.data ?? [];
}

const event = (over = {}) => ({
  kind: "agent_proposal",
  inboxProfileId: BRANDON,
  title: "something happened",
  body: "the body",
  ...over,
});

/* ================================================== done when #1 ========== */

describe("1. a FAILED job_runs row: one email to Nate, one inbox item", () => {
  test("notifyJobRun on a failed row emails Nate exactly once and posts one notice", async () => {
    const db = service();
    const out = await notifyJobRun({ serviceDb: db, caller: adminCaller }, {
      job: "health-sweep",
      status: "error",
      actor: "cron",
      log: "two sites did not answer",
    });

    const inbox = await all(db, "inbox_items");
    const outbox = await all(db, "email_outbox");
    assert.equal(inbox.length, 1, "a failed run must leave exactly one inbox item");
    assert.equal(outbox.length, 1, "a failed run must render exactly one email");
    assert.equal(outbox[0].to_email, NATE_EMAIL, "the failure email is addressed to Nate");
    assert.equal(outbox[0].to_profile_id, NATE, "and to Nate's PROFILE, resolved by lookup");
    assert.equal(outbox[0].kind, "job_run_failed");
    assert.equal(inbox[0].kind, "job_run_failed");
    assert.equal(out.email.to, NATE_EMAIL);
    assert.match(out.email.body, /two sites did not answer/);
  });

  test("Nate is resolved by profile lookup, not written into the routing", async () => {
    const db = service();
    const who = await resolveAdmin(db);
    assert.equal(who.profileId, NATE, "the admin recipient comes from the profiles table");
    assert.equal(who.role, "admin");
    // Change which address is the admin and a different profile answers — proof
    // the id is a lookup result and not a constant.
    process.env.NOTIFY_ADMIN_EMAIL = BRANDON_EMAIL;
    try {
      assert.equal((await resolveAdmin(db)).profileId, BRANDON);
    } finally {
      delete process.env.NOTIFY_ADMIN_EMAIL;
    }
    assert.equal(adminEmail(), NATE_EMAIL, "the default admin address is the one named constant");
  });

  test("an unresolvable directory still produces the email, addressed to the constant", async () => {
    const db = markServiceClient(fakeDb({ inbox_items: [], email_outbox: [] }));
    await notifyJobRun({ serviceDb: db, caller: adminCaller }, { job: "j", status: "error" }, BRANDON);
    const outbox = await all(db, "email_outbox");
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to_email, NATE_EMAIL);
    assert.equal(outbox[0].to_profile_id, null, "no profile row means no profile id, not a guess");
  });
});

/* ================================================== done when #2 ========== */

describe("2. a SUCCESSFUL job_runs row: an inbox item and zero emails", () => {
  test("notifyJobRun on an ok row posts a notice and renders no email at all", async () => {
    const db = service();
    const out = await notifyJobRun({ serviceDb: db, caller: adminCaller }, {
      job: "health-sweep",
      status: "ok",
      actor: "cron",
    });
    assert.equal((await all(db, "inbox_items")).length, 1, "success still goes to the inbox");
    assert.equal((await all(db, "email_outbox")).length, 0, "success must email nobody");
    assert.equal(out.email, null);
  });

  test("an `attention` run emails the admin but does not call itself a failure", async () => {
    const db = service();
    await notifyJobRun({ serviceDb: db, caller: adminCaller }, {
      job: "site_health",
      status: "attention",
      log: "coventrycontracting.com is down",
    });
    const inbox = await all(db, "inbox_items");
    const outbox = await all(db, "email_outbox");
    assert.equal(outbox.length, 1, "findings still reach the admin by email");
    assert.equal(outbox[0].kind, "job_run_attention");
    assert.equal(inbox[0].kind, "job_run_attention");
    assert.match(inbox[0].title, /needs attention/);
    assert.doesNotMatch(inbox[0].title, /failed/);
  });

  test("a run that is neither ok, attention, nor failed notifies nobody", async () => {
    for (const status of ["running", "cancelled"]) {
      const db = service();
      assert.equal(
        await notifyJobRun({ serviceDb: db, caller: adminCaller }, { job: "j", status }),
        null,
        `${status} is not an outcome`,
      );
      assert.equal((await all(db, "inbox_items")).length, 0);
      assert.equal((await all(db, "email_outbox")).length, 0);
    }
  });
});

/* ================================================== done when #3 ========== */

describe("3. a task assigned to ANY profile emails that assignee", () => {
  const task = (over = {}) => ({
    id: "cccccccc-0000-4000-8000-0000000000t1",
    account_id: ACCT,
    title: "Call Coventry back",
    details: null,
    assigned_to: BRANDON,
    status: "todo",
    due_date: "2026-09-01",
    created_by: NATE,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    ...over,
  });

  test("assigning to a MEMBER emails the member, not the admin", async () => {
    const db = service();
    assert.equal(
      await notifyTaskAssigned({ serviceDb: db, caller: adminCaller, task: task(), previousAssignee: null }),
      true,
    );
    const inbox = await all(db, "inbox_items");
    const outbox = await all(db, "email_outbox");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].profile_id, BRANDON);
    assert.equal(outbox.length, 1, "every employee gets the assignment email");
    assert.equal(outbox[0].to_email, BRANDON_EMAIL, "addressed to the ASSIGNEE");
    assert.equal(outbox[0].to_profile_id, BRANDON);
    assert.match(outbox[0].subject, /Call Coventry back/);
  });

  test("assigning to the admin emails the admin — same rule, different person", async () => {
    const db = service();
    await notifyTaskAssigned({
      serviceDb: db,
      caller,
      task: task({ assigned_to: NATE }),
      previousAssignee: null,
    });
    const outbox = await all(db, "email_outbox");
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to_email, NATE_EMAIL);
  });

  test("the quiet cases stay quiet — no inbox item AND no email", async () => {
    for (const [why, args] of [
      ["unassigned", { task: task({ assigned_to: null }), previousAssignee: null }],
      ["same assignee", { task: task(), previousAssignee: BRANDON }],
      ["assigned to yourself", { task: task(), previousAssignee: null, caller }],
    ]) {
      const db = service();
      await notifyTaskAssigned({ serviceDb: db, caller: adminCaller, previousAssignee: null, ...args });
      assert.equal((await all(db, "inbox_items")).length, 0, `${why} posted a notice`);
      assert.equal((await all(db, "email_outbox")).length, 0, `${why} sent mail`);
    }
  });

  test("a directory that cannot name the assignee still posts the inbox item", async () => {
    const db = markServiceClient(fakeDb({ inbox_items: [], email_outbox: [] }));
    assert.equal(
      await notifyTaskAssigned({ serviceDb: db, caller: adminCaller, task: task(), previousAssignee: null }),
      true,
      "the inbox half must survive an unreadable directory",
    );
    assert.equal((await all(db, "inbox_items")).length, 1);
    assert.equal((await all(db, "email_outbox")).length, 0, "no address means no payload to record");
  });
});

/* ================================================== done when #4 ========== */

describe("4. with no provider: the inbox item is written and the email recorded", () => {
  test("there is no provider — getMailer() is the no-op, and it refuses", async () => {
    assert.equal(getMailer(), nullMailer, "no mail provider may be configured in this run");
    const res = await nullMailer.send({ to: NATE_EMAIL, subject: "s", body: "b" });
    assert.equal(res.ok, false);
    assert.equal(res.configured, false, "'nowhere to send' is not 'the provider said no'");
  });

  test("every emailing kind still writes its inbox item and records the payload", async () => {
    for (const kind of EMAIL_EVENTS) {
      const db = service();
      const out = await deliverNotification(
        { serviceDb: db, caller: adminCaller },
        event({ kind, inboxProfileId: NATE }),
        await resolveProfile(db, NATE),
      );
      assert.equal((await all(db, "inbox_items")).length, 1, `${kind} lost its inbox item`);
      const outbox = await all(db, "email_outbox");
      assert.equal(outbox.length, 1, `${kind} lost its email payload`);
      assert.equal(outbox[0].status, "pending", `${kind} must be recorded as still owed`);
      assert.equal(outbox[0].sent_at, null);
      assert.match(outbox[0].error, /no mail provider is configured/);
      assert.ok(outbox[0].body.length > 0, "the rendered body must be stored, not re-derived later");
      assert.equal(out.delivered, false, "nothing may claim delivery with no provider");
      assert.ok(out.outboxId, "the payload must be recorded somewhere durable");
    }
  });

  test("a provider that REFUSES is recorded as failed, not as still-owed", async () => {
    const db = service();
    const angry = { name: "angry", async send() { return { ok: false, error: "550 rejected", configured: true }; } };
    await deliverNotification(
      { serviceDb: db, caller: adminCaller, mailer: angry },
      event({ kind: "job_run_failed", inboxProfileId: NATE }),
    );
    const outbox = await all(db, "email_outbox");
    assert.equal(outbox[0].status, "failed");
    assert.match(outbox[0].error, /550/);
  });

  test("an adapter that THROWS loses neither the inbox item nor the record", async () => {
    const db = service();
    const bomb = { name: "bomb", async send() { throw new Error("socket hang up"); } };
    const out = await deliverNotification(
      { serviceDb: db, caller: adminCaller, mailer: bomb },
      event({ kind: "job_run_failed", inboxProfileId: NATE }),
    );
    assert.equal(out.delivered, false);
    assert.equal((await all(db, "inbox_items")).length, 1);
    assert.equal((await all(db, "email_outbox"))[0].status, "failed");
  });

  test("with NO service client at all it degrades and does not throw", async () => {
    const out = await deliverNotification({ caller: adminCaller }, event({ kind: "task_assigned" }), {
      profileId: NATE, email: NATE_EMAIL, displayName: "Nate", role: "admin",
    });
    assert.equal(out.inboxItemId, null);
    assert.equal(out.outboxId, null);
    assert.ok(out.email, "the payload is still rendered so the log line can carry it");
  });

  test("an inbox insert that fails does not cancel the email record", async () => {
    const db = markServiceClient(
      fakeDb({ profiles: profiles(), inbox_items: [], email_outbox: [] },
             { failOn: { inbox_items: "denied by RLS" } }),
    );
    const out = await deliverNotification(
      { serviceDb: db, caller: adminCaller },
      event({ kind: "job_run_failed", inboxProfileId: NATE }),
    );
    assert.equal(out.inboxItemId, null);
    assert.ok(out.outboxId, "the two halves are independent — neither may take the other down");
  });
});

/* ============================================ the settled rule, all six === */

describe("the rule table — three email, three do not, all six reach the inbox", () => {
  test("EMAIL_EVENTS and INBOX_ONLY_EVENTS are exactly the settled lists", () => {
    // job_run_attention joined the table in item 12. Same audience as
    // job_run_failed on purpose — a client's site being down is the admin's
    // problem whether or not the job that noticed it was healthy.
    assert.deepEqual(
      [...EMAIL_EVENTS].sort(),
      ["job_run_attention", "job_run_failed", "lead_reply_meeting", "task_assigned"],
    );
    assert.deepEqual([...INBOX_ONLY_EVENTS].sort(), ["agent_proposal", "daily_briefing", "job_run_ok"]);
    for (const k of EMAIL_EVENTS) assert.equal(emailsFor(k), true, `${k} must email`);
    for (const k of INBOX_ONLY_EVENTS) assert.equal(emailsFor(k), false, `${k} must NOT email`);
  });

  test("every kind writes an inbox item; only the three write an email", async () => {
    for (const kind of [...EMAIL_EVENTS, ...INBOX_ONLY_EVENTS]) {
      const db = service();
      await deliverNotification(
        { serviceDb: db, caller: adminCaller },
        event({ kind, inboxProfileId: BRANDON }),
        await resolveProfile(db, BRANDON),
      );
      assert.equal((await all(db, "inbox_items")).length, 1, `${kind} did not reach the inbox`);
      assert.equal(
        (await all(db, "email_outbox")).length,
        emailsFor(kind) ? 1 : 0,
        `${kind} got the wrong number of emails`,
      );
    }
  });

  test("routeEvent is pure: same event, same answer, no client involved", () => {
    const nate = { profileId: NATE, email: NATE_EMAIL, displayName: "Nate", role: "admin" };
    const brandon = { profileId: BRANDON, email: BRANDON_EMAIL, displayName: "Brandon", role: "member" };

    // A failed run and a lead wanting a meeting go to the ADMIN even though the
    // inbox item belongs to someone else. That split is the whole reason
    // routeEvent returns both.
    for (const kind of ["job_run_failed", "lead_reply_meeting"]) {
      const r = routeEvent(event({ kind }), { admin: nate, subject: brandon });
      assert.equal(r.email.to, NATE_EMAIL, `${kind} must email the admin`);
      assert.equal(r.inbox.profileId, BRANDON, `${kind} must still notify the subject`);
    }
    const assigned = routeEvent(event({ kind: "task_assigned" }), { admin: nate, subject: brandon });
    assert.equal(assigned.email.to, BRANDON_EMAIL, "an assignment emails the assignee");

    // No addressee at all is inbox-only, never a throw and never a fallback to
    // whoever happens to be around.
    assert.equal(
      routeEvent(event({ kind: "task_assigned" }), { admin: nate, subject: null }).email,
      null,
    );
  });
});

/* ============================================ guardrail: no money, no send = */

describe("guardrail — an email to a non-admin carries no money figure", () => {
  const facts = { business: "Coventry", deal_value_cents: 150000, monthly_rate_cents: 15000 };

  test("a member's payload contains neither figure, in the body or anywhere", async () => {
    const db = service();
    await deliverNotification(
      { serviceDb: db, caller: adminCaller },
      event({ kind: "task_assigned", inboxProfileId: BRANDON, facts }),
      await resolveProfile(db, BRANDON),
    );
    const [row] = await all(db, "email_outbox");
    assert.equal(row.to_email, BRANDON_EMAIL);
    assert.doesNotMatch(row.body, /150000|deal_value_cents/, "a member was sent a deal value");
    assert.doesNotMatch(row.body, /15000|monthly_rate_cents/, "a member was sent a monthly rate");
    assert.match(row.body, /Coventry/, "stripping money must not strip everything else");
  });

  test("the admin's payload keeps them — the rule is about the RECIPIENT", async () => {
    const db = service();
    await deliverNotification(
      { serviceDb: db, caller },
      event({ kind: "job_run_failed", inboxProfileId: BRANDON, facts }),
    );
    const [row] = await all(db, "email_outbox");
    assert.equal(row.to_email, NATE_EMAIL);
    assert.match(row.body, /150000/, "the admin may see money");
  });
});

describe("guardrail — nothing may be handed to an adapter but the test address", () => {
  test("the default allowlist is the one permitted address", () => {
    assert.equal(maySend(NATE_EMAIL), true);
    assert.equal(maySend("someone@a-real-company.com"), false);
    assert.equal(maySend("SOMEONE@A-REAL-COMPANY.COM"), false);
  });

  test("an address off the list never reaches send(), but is still recorded", async () => {
    const db = service();
    const calls = [];
    const spy = { name: "spy", async send(p) { calls.push(p); return { ok: true }; } };
    await deliverNotification(
      { serviceDb: db, caller: adminCaller, mailer: spy },
      event({ kind: "task_assigned", inboxProfileId: BRANDON }),
      await resolveProfile(db, BRANDON),
    );
    assert.equal(calls.length, 0, "a non-allowlisted address was handed to an adapter");
    const [row] = await all(db, "email_outbox");
    assert.equal(row.status, "pending");
    assert.match(row.error, /NOTIFY_ALLOWED_RECIPIENTS/);
  });

  test("the allowed address DOES reach the adapter, so the guard is not a stub", async () => {
    const db = service();
    const calls = [];
    const spy = { name: "spy", async send(p) { calls.push(p); return { ok: true, id: "m1" }; } };
    const out = await deliverNotification(
      { serviceDb: db, caller },
      event({ kind: "job_run_failed", inboxProfileId: BRANDON }),
    );
    assert.equal(out.delivered, false, "the default adapter still sends nothing");

    const out2 = await deliverNotification(
      { serviceDb: db, caller, mailer: spy },
      event({ kind: "job_run_failed", inboxProfileId: BRANDON }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, NATE_EMAIL);
    assert.equal(out2.delivered, true);
    const sent = (await all(db, "email_outbox")).find((r) => r.status === "sent");
    assert.ok(sent.sent_at, "a sent row records when");
  });
});
