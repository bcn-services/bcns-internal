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
 * A missing service client, a member closing somebody else's task (inbox_post
 * refuses that, correctly), a database hiccup — none of them may turn a
 * completed task into an error the person has to re-do.
 *
 * EXACTLY ONE ROW. The callers read the prior status before the update and
 * pass it in; re-saving an already-done task is a no-op here rather than a
 * second nudge. That check is why `previousStatus` is a parameter and not
 * something this file goes and fetches.
 */

import type { Task, TaskStatus } from "../tasks";
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

  const res = await inbox_post.run(
    { caller, db: serviceDb },
    {
      profileId: task.assigned_to,
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

/**
 * The prior status of a task, for the idempotency check above. Returns null
 * when it cannot be read — which makes the nudge fire rather than not, because
 * a missed prompt is worse than a duplicate one.
 */
export async function previousTaskStatus(db: DbClient, id: string): Promise<TaskStatus | null> {
  try {
    const res = await db.from("tasks").select("status").eq("id", id).maybeSingle();
    const row = res.data as { status?: unknown } | null;
    return typeof row?.status === "string" ? (row.status as TaskStatus) : null;
  } catch (err) {
    console.warn("[task-nudge] could not read prior status:", err);
    return null;
  }
}
