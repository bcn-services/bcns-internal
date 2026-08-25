/**
 * task-nudge.ts — "you closed it; say what happened."
 *
 * A task going to `done` is the one moment someone definitely knows what
 * happened and is about to forget it. This posts one inbox item to the
 * assignee asking them to log it, which is the cheapest possible prompt: it
 * waits in their own mail rather than interrupting the close.
 *
 * IT GOES THROUGH inbox_post, not through its own insert. `inbox_items` has no
 * INSERT policy (0009, deliberately — a user-writable inbox lets anyone plant a
 * notice in a colleague's feed), so the write needs the service-role client,
 * and inbox_post is already the one place that escalation is allowed and
 * bounded. A second insert path here would be a second set of rules.
 *
 * BEST EFFORT, ALWAYS. The task move already succeeded by the time this runs.
 * A missing service client, a database hiccup — none of them may turn a
 * completed task into an error the person has to re-do.
 *
 * EXACTLY ONE ROW. The callers read the prior status before the update and
 * pass it in; re-saving an already-done task is a no-op here rather than a
 * second nudge. That check is why `previousStatus` is a parameter and not
 * something this file goes and fetches.
 */

import type { Task, TaskStatus } from "../tasks";
import { deliverNotification, resolveProfile } from "../notify";
import { inbox_post } from "./verbs/inbox_post";
import type { Caller, DbClient } from "./verbs/types";

/**
 * The statuses that mean the work is over and there is something to tell.
 * `cancelled` is NOT one: nothing happened, which is the whole point of it.
 */
export const COMPLETED_TASK_STATUSES: readonly TaskStatus[] = ["done"];

export const isCompletedStatus = (s: unknown): boolean =>
  typeof s === "string" && (COMPLETED_TASK_STATUSES as readonly string[]).includes(s);

/** The machine label on the inbox row. Stable — a job may retire its backlog by it. */
export const TASK_CLOSE_NUDGE_KIND = "task_close_nudge";

/**
 * Post the nudge if this move was a close. Returns whether a row was written,
 * which is what the tests assert on; it never throws.
 */
export async function nudgeTaskClose(args: {
  serviceDb?: DbClient;
  caller: Caller;
  task: Task;
  /** The status the task held BEFORE this update, or null if unknown. */
  previousStatus: TaskStatus | null;
}): Promise<boolean> {
  const { serviceDb, caller, task, previousStatus } = args;

  if (!isCompletedStatus(task.status)) return false;
  // Already closed: this save changed something else, and the person was asked
  // the first time.
  if (isCompletedStatus(previousStatus)) return false;
  // Nobody to ask. An unassigned task closing is bookkeeping, not work someone did.
  if (!task.assigned_to) return false;
  if (!serviceDb) return false;

  // POSTED AS THE ASSIGNEE, THROUGH THE SERVICE CLIENT.
  //
  // inbox_post's own rule is "a member may only post to their own inbox", and
  // the closer is very often NOT the assignee — which made this nudge fail
  // `forbidden` and vanish into a console.warn for the most common case in the
  // app. The recipient here is `task.assigned_to` and can be nothing else (the
  // literal below is the same expression), so posting under that identity
  // widens nothing: there is no argument a caller can pass that reaches a third
  // person's inbox. `caller` stays a parameter because it is who CLOSED the
  // task, which is not who is being asked.
  const recipient = task.assigned_to;
  const res = await inbox_post.run(
    { caller: { ...caller, profileId: recipient }, db: serviceDb },
    {
      profileId: recipient,
      kind: TASK_CLOSE_NUDGE_KIND,
      title: `Log what happened: ${task.title}`,
      body:
        `You marked "${task.title}" done. Add one line of activity to the account so the ` +
        `history has it — the capture box on the lead or client page takes plain English.`,
      sourceJob: TASK_CLOSE_NUDGE_KIND,
      accountId: task.account_id,
    },
  );
  if (!res.ok) {
    // Logged, never raised. See the header: the close already happened.
    console.warn("[task-nudge] could not post:", res.error.code, res.error.message);
    return false;
  }
  return true;
}

/** The machine label on an assignment notice. Stable, like the nudge kind. */
export const TASK_ASSIGNED_KIND = "task_assigned";

/**
 * Tell someone a task is now theirs.
 *
 * SECOND inbox_post CALL SITE, same shape as the close nudge and for the same
 * reason: the app already knows this happened, and the person it happened TO is
 * usually not the person who did it. Best effort — the assignment already
 * landed, and a failed notice may not undo it.
 *
 * THREE THINGS MAKE IT QUIET RATHER THAN NOISY, and all three are the caller's
 * previous-assignee read talking:
 *   - unassigning tells nobody;
 *   - re-saving the same assignee is not a second notice;
 *   - assigning something to YOURSELF is not news, so it posts nothing.
 */
export async function notifyTaskAssigned(args: {
  serviceDb?: DbClient;
  caller: Caller;
  task: Task;
  /** Who held it BEFORE this update, or null if unassigned/unknown. */
  previousAssignee: string | null;
}): Promise<boolean> {
  const { serviceDb, caller, task, previousAssignee } = args;
  const recipient = task.assigned_to;

  if (!recipient) return false;
  if (recipient === previousAssignee) return false;
  if (recipient === caller.profileId) return false;
  if (!serviceDb) return false;

  // THROUGH lib/notify.ts, NOT STRAIGHT TO inbox_post. "Task assigned" is one
  // of the three events that also send an email (to the assignee — every
  // employee gets this one, not just the admin), and the rule lives in exactly
  // one table there. This stays the single call site: the routing layer decides
  // both halves off this one event, and the inbox item it writes goes through
  // inbox_post under the RECIPIENT's identity just as it did before.
  const out = await deliverNotification(
    { serviceDb, caller },
    {
      kind: TASK_ASSIGNED_KIND,
      inboxProfileId: recipient,
      title: `Assigned to you: ${task.title}`,
      body:
        `${caller.email} put "${task.title}" on your plate` +
        `${task.due_date ? `, due ${task.due_date}` : ""}.`,
      sourceJob: TASK_ASSIGNED_KIND,
      accountId: task.account_id,
      facts: { task: task.title, due: task.due_date, assignedBy: caller.email },
    },
    // The email's addressee. Read through the service client because the
    // directory is what turns a profile id into an address; a directory that
    // cannot answer costs the email, never the inbox item.
    await resolveProfile(serviceDb, recipient),
  );
  return out.inboxItemId !== null;
}

/**
 * The task as it stood BEFORE an update, for the two idempotency checks above.
 * Returns null when it cannot be read — which makes a notice fire rather than
 * not, because a missed prompt is worse than a duplicate one.
 */
export async function previousTaskRow(
  db: DbClient,
  id: string,
): Promise<{ status: TaskStatus | null; assigned_to: string | null } | null> {
  try {
    const res = await db.from("tasks").select("status, assigned_to").eq("id", id).maybeSingle();
    const row = res.data as { status?: unknown; assigned_to?: unknown } | null;
    if (!row) return null;
    return {
      status: typeof row.status === "string" ? (row.status as TaskStatus) : null,
      assigned_to: typeof row.assigned_to === "string" ? row.assigned_to : null,
    };
  } catch (err) {
    console.warn("[task-nudge] could not read the prior task:", err);
    return null;
  }
}

/** The prior status alone — what the close path checks. */
export async function previousTaskStatus(db: DbClient, id: string): Promise<TaskStatus | null> {
  return (await previousTaskRow(db, id))?.status ?? null;
}
