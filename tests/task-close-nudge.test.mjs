/**
 * task-close-nudge.test.mjs — closing a task asks the assignee to say what happened.
 *
 * Driven through the REAL entry point (`tasks_write.run`), never through
 * nudgeTaskClose alone: the claim is that moving a task to a completed status
 * posts the item, and a test that called the poster directly would prove only
 * that the poster works.
 *
 * `inbox_items` has no INSERT policy (0009), so the write goes through
 * inbox_post with the SERVICE-role client — which is why `serviceDb` here is a
 * separate fake from `db`, exactly as production separates them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { tasks_write } from "../lib/agent/verbs/index.ts";
import {
  COMPLETED_TASK_STATUSES,
  TASK_ASSIGNED_KIND,
  TASK_CLOSE_NUDGE_KIND,
  isCompletedStatus,
} from "../lib/agent/task-nudge.ts";
import { fakeDb } from "./helpers/fake-db.mjs";

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

const ACCT = "11111111-1111-4111-8111-111111111111";
const TASK_MEMBERS = "44444444-4444-4444-8444-444444444444";
const TASK_OTHER = "55555555-5555-4555-8555-555555555555";
const TASK_UNASSIGNED = "66666666-6666-4666-8666-666666666666";
const TASK_ALREADY_DONE = "77777777-7777-4777-8777-777777777777";

/**
 * Four tasks, so nothing below can match the right row by accident. Every
 * assertion picks its row by an explicit id or title.
 */
function fixture() {
  const base = {
    account_id: ACCT,
    details: null,
    due_date: null,
    created_by: ADMIN.profileId,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
  return {
    tasks: [
      { ...base, id: TASK_OTHER, title: "Chase the Diner invoice", assigned_to: ADMIN.profileId, status: "todo" },
      { ...base, id: TASK_MEMBERS, title: "Call Coventry back", assigned_to: MEMBER.profileId, status: "doing" },
      { ...base, id: TASK_UNASSIGNED, title: "Tidy the funnel", assigned_to: null, status: "todo" },
      { ...base, id: TASK_ALREADY_DONE, title: "Send the deck", assigned_to: MEMBER.profileId, status: "done" },
    ],
    inbox_items: [
      { id: "seeded", profile_id: ADMIN.profileId, kind: "other", title: "pre-existing", created_at: "2026-01-01" },
    ],
    profiles: [
      { id: ADMIN.profileId, display_name: "Nate", email: ADMIN.email, active: true },
      { id: MEMBER.profileId, display_name: "Brandon", email: MEMBER.email, active: true },
    ],
    accounts: [{ id: ACCT, business_name: "Coventry Contracting" }],
  };
}

const nudges = (tables) => tables.inbox_items.filter((i) => i.kind === TASK_CLOSE_NUDGE_KIND);

describe("which statuses count as a close", () => {
  test("'done' closes; 'cancelled' does not — nothing happened to report", () => {
    assert.deepEqual([...COMPLETED_TASK_STATUSES], ["done"]);
    assert.equal(isCompletedStatus("done"), true);
    assert.equal(isCompletedStatus("cancelled"), false);
    assert.equal(isCompletedStatus("todo"), false);
    assert.equal(isCompletedStatus("doing"), false);
    assert.equal(isCompletedStatus(undefined), false);
  });
});

describe("moving a task to completed", () => {
  test("creates EXACTLY ONE inbox row, addressed to its assigned_to profile", async () => {
    const tables = fixture();
    const before = tables.inbox_items.length;
    const r = await tasks_write.run(
      { caller: MEMBER, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { id: TASK_MEMBERS, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));

    assert.equal(tables.inbox_items.length, before + 1, "not exactly one row was added");
    const posted = nudges(tables);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].profile_id, MEMBER.profileId, "addressed to the wrong person");
    assert.equal(posted[0].account_id, ACCT);
    assert.equal(posted[0].source_job, TASK_CLOSE_NUDGE_KIND);
    // Named by the task it is about, so a full inbox is still readable.
    assert.match(posted[0].title, /Call Coventry back/);
    assert.match(posted[0].body, /activity/i);
    // ...and the task itself really did move.
    assert.equal(tables.tasks.find((t) => t.id === TASK_MEMBERS).status, "done");
  });

  test("an admin closing someone else's task nudges THAT person, not themselves", async () => {
    const tables = fixture();
    const r = await tasks_write.run(
      { caller: ADMIN, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { id: TASK_MEMBERS, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const posted = nudges(tables);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].profile_id, MEMBER.profileId);
    assert.notEqual(posted[0].profile_id, ADMIN.profileId);
  });

  test("re-saving an already-done task posts nothing — one close, one nudge", async () => {
    const tables = fixture();
    const before = tables.inbox_items.length;
    const r = await tasks_write.run(
      { caller: MEMBER, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { id: TASK_ALREADY_DONE, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.inbox_items.length, before, "a second nudge was posted");
    assert.equal(nudges(tables).length, 0);
  });

  test("closing the same task twice in a row yields one nudge in total", async () => {
    const tables = fixture();
    for (let i = 0; i < 2; i++) {
      const r = await tasks_write.run(
        { caller: MEMBER, db: fakeDb(tables), serviceDb: fakeDb(tables) },
        { id: TASK_MEMBERS, status: "done" },
      );
      assert.equal(r.ok, true, JSON.stringify(r.error));
    }
    assert.equal(nudges(tables).length, 1);
  });

  test("an unassigned task closes with no nudge — there is nobody to ask", async () => {
    const tables = fixture();
    const before = tables.inbox_items.length;
    const r = await tasks_write.run(
      { caller: ADMIN, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { id: TASK_UNASSIGNED, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.inbox_items.length, before);
  });
});

describe("moves that are not a close", () => {
  for (const status of ["todo", "doing", "cancelled"]) {
    test(`moving to ${status} posts nothing`, async () => {
      const tables = fixture();
      const before = tables.inbox_items.length;
      const db = fakeDb(tables);
      const r = await tasks_write.run(
        { caller: MEMBER, db, serviceDb: fakeDb(tables) },
        { id: TASK_MEMBERS, status },
      );
      assert.equal(r.ok, true, JSON.stringify(r.error));
      assert.equal(tables.inbox_items.length, before);
      assert.equal(tables.tasks.find((t) => t.id === TASK_MEMBERS).status, status);
      // A status move that is not a close and touches no assignee needs neither
      // idempotency fact, so it costs no extra read.
      assert.equal(
        db.calls.filter((c) => c.ops.some((o) => o[0] === "maybeSingle")).length,
        0,
        "a plain status move read the prior row for nothing",
      );
    });
  }

  test("re-saving the SAME assignee posts nothing — the dropdown is not a doorbell", async () => {
    // The old version of this test reassigned to the CALLER, so the
    // self-assign guard short-circuited before any notice and the double-notice
    // path was never exercised. Here the assignee is unchanged and the caller is
    // someone else, which is exactly the case a prior-assignee read is for.
    const tables = fixture();
    const before = tables.inbox_items.length;
    const r = await tasks_write.run(
      { caller: ADMIN, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { id: TASK_MEMBERS, assignedTo: MEMBER.profileId },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.inbox_items.length, before, "the same assignee was notified twice");
  });

  test("a real reassignment still posts exactly one notice, to the new holder", async () => {
    const tables = fixture();
    const before = tables.inbox_items.length;
    const r = await tasks_write.run(
      { caller: MEMBER, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { id: TASK_MEMBERS, assignedTo: ADMIN.profileId },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const posted = tables.inbox_items.slice(before);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].kind, TASK_ASSIGNED_KIND);
    assert.equal(posted[0].profile_id, ADMIN.profileId);
  });

  test("creating a task that is already done does not nudge — nothing was closed", async () => {
    const tables = fixture();
    const nudges = () => tables.inbox_items.filter((i) => i.kind === TASK_CLOSE_NUDGE_KIND).length;
    const before = nudges();
    const beforeAll = tables.inbox_items.length;
    const r = await tasks_write.run(
      { caller: ADMIN, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { title: "Backfilled record", assignedTo: MEMBER.profileId, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(nudges(), before, "a create posted a close nudge");
    // Item 6 DOES post here, and it is a different notice: the task landed on
    // somebody's plate. Asserted rather than merely tolerated, so the two
    // notices can never be confused for one another.
    assert.deepEqual(
      tables.inbox_items.filter((i) => i.kind === TASK_ASSIGNED_KIND).map((i) => i.profile_id),
      [MEMBER.profileId],
    );
    // QA: narrowing the count to close-nudges alone would have let a THIRD kind
    // of stray notice through unnoticed. The original strict claim is restored
    // on top of the specific one: exactly one new row, and it is that notice.
    assert.equal(tables.inbox_items.length, beforeAll + 1, "a create posted a notice nobody asked for");
  });
});

describe("the nudge never costs you the close", () => {
  test("no service client: the task still moves, and no row is written", async () => {
    const tables = fixture();
    const r = await tasks_write.run(
      { caller: MEMBER, db: fakeDb(tables) },
      { id: TASK_MEMBERS, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.tasks.find((t) => t.id === TASK_MEMBERS).status, "done");
    assert.equal(tables.inbox_items.length, 1);
  });

  test("a member closing SOMEONE ELSE's task nudges the ASSIGNEE, and the move stands", async () => {
    // The nudge is posted under the assignee's identity through the service
    // client, so inbox_post's "only your own inbox" rule is satisfied without
    // being widened: the recipient is task.assigned_to and can be nothing else.
    const tables = fixture();
    const r = await tasks_write.run(
      { caller: MEMBER, db: fakeDb(tables), serviceDb: fakeDb(tables) },
      { id: TASK_OTHER, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.tasks.find((t) => t.id === TASK_OTHER).status, "done");
    const posted = nudges(tables);
    assert.equal(posted.length, 1, "the most common close in the app still posts nothing");
    assert.equal(posted[0].profile_id, ADMIN.profileId);
    assert.notEqual(posted[0].profile_id, MEMBER.profileId);
  });

  test("an inbox insert that errors still leaves the task closed", async () => {
    const tables = fixture();
    const r = await tasks_write.run(
      {
        caller: MEMBER,
        db: fakeDb(tables),
        serviceDb: fakeDb(tables, { failOn: { inbox_items: "connection reset" } }),
      },
      { id: TASK_MEMBERS, status: "done" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.tasks.find((t) => t.id === TASK_MEMBERS).status, "done");
    assert.equal(nudges(tables).length, 0);
  });
});
