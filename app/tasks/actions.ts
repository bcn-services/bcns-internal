/**
 * tasks/actions.ts — the mutating entry points for the task board.
 *
 * Same trust boundary as app/leads/actions.ts: every action re-reads the viewer
 * from the session cookie and never trusts a role or an identity carried in a
 * form field. RLS is the final word — this layer only validates shape and
 * translates a denial into something a person can read.
 *
 * `created_by` is set from the viewer's own profile row rather than a hidden
 * input, because a hidden input is attacker-controlled and would let anyone
 * forge authorship of a task.
 */
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/supabase-server";
import { InvalidInputError } from "@/lib/accounts";
import {
  createTask, updateTaskStatus, updateTaskStatusIfNot, assignTask, isTaskStatus,
} from "@/lib/tasks";
import { listProfiles } from "@/lib/profiles";
import { getServiceClient } from "@/lib/supabase-admin";
import {
  isCompletedStatus, notifyTaskAssigned, nudgeTaskClose, previousTaskRow, previousTaskStatus,
} from "@/lib/agent/task-nudge";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Turn a result into what a form action must be: void, or a redirect. */
function finish(result: ActionResult, backTo: string): void {
  if (!result.ok) redirect(`${backTo}?error=${encodeURIComponent(result.error)}`);
}

async function requireDb() {
  const { role, email, client } = await getViewer();
  if (!client) throw new InvalidInputError("Supabase is not configured.");
  if (role === null) throw new InvalidInputError("Your account is not provisioned.");
  return { role, email, db: client };
}

function toResult(e: unknown): ActionResult {
  const msg = e instanceof Error ? e.message : String(e);
  if (/permission denied|violates row-level security/i.test(msg)) {
    return { ok: false, error: "You do not have permission to do that." };
  }
  return { ok: false, error: msg };
}

/**
 * getViewer() exposes the session email but not the auth user id, and
 * `profiles.id` IS that id — so the directory read is the bridge between the
 * two. Returns null rather than throwing: an unprovisioned profile should cost
 * you authorship of a task, not the ability to file one. Deliberately NOT
 * exported — every export of a "use server" module becomes a callable endpoint.
 */
async function viewerProfileId(
  db: Parameters<typeof listProfiles>[0],
  email: string | null,
): Promise<string | null> {
  if (!email) return null;
  const wanted = email.toLowerCase();
  const match = (await listProfiles(db)).find((p) => p.email.toLowerCase() === wanted);
  return match?.id ?? null;
}

/** An empty <select> or <input> submits "", which the data layer must see as null. */
const orNull = (v: FormDataEntryValue | null): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

async function addTaskImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db, email, role } = await requireDb();
    const task = await createTask(db, {
      title: String(formData.get("title") ?? ""),
      details: orNull(formData.get("details")),
      accountId: orNull(formData.get("accountId")),
      assignedTo: orNull(formData.get("assignedTo")),
      dueDate: orNull(formData.get("dueDate")),
      createdBy: await viewerProfileId(db, email),
    });
    revalidatePath("/tasks");
    // AFTER the revalidate, and it cannot throw — see notifyAssigned.
    await notifyAssigned(role, email, task, null);
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Moving a task. The one interesting case is a CLOSE: it also asks the
 * assignee to log what happened, through the same lib/agent/task-nudge.ts the
 * tasks_write verb uses, so the board and the agent cannot drift on when a
 * nudge fires or what it says.
 */
async function setStatusImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db, role, email } = await requireDb();
    const status = String(formData.get("status") ?? "");
    if (!isTaskStatus(status)) return { ok: false, error: `Unknown status: ${status}` };
    const taskId = String(formData.get("taskId") ?? "");

    // THE CLOSE IS THE CONDITIONAL WRITE. Reading the status first and then
    // updating leaves a gap two concurrent closes both walk through, and both
    // would nudge. `neq('status','done')` makes "was it still open?" the same
    // statement as the move: whoever gets a row back did the closing.
    let task;
    let alreadyClosed = false;
    if (isCompletedStatus(status)) {
      const closed = await updateTaskStatusIfNot(db, taskId, status, "done");
      if (closed) {
        task = closed;
      } else {
        // No row matched: someone else closed it first, or the id is not a task.
        // The second is a real error; the first is a no-op, not a failure.
        if ((await previousTaskStatus(db, taskId)) === null) {
          throw new InvalidInputError(`no such task: ${taskId}`);
        }
        alreadyClosed = true;
      }
    } else {
      task = await updateTaskStatus(db, taskId, status);
    }

    // `previousStatus: null` is honest here — the conditional write above has
    // already proven the task was NOT done, which is the only thing the prior
    // status was ever read for.
    const { userId } = await getViewer();
    if (task && !alreadyClosed && userId && email) {
      await nudgeTaskClose({
        serviceDb: getServiceClient() ?? undefined,
        caller: { profileId: userId, email, role },
        task,
        previousStatus: null,
      });
    }
    revalidatePath("/tasks");
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}

/**
 * The assignment notice, for the two actions that can cause one. It is here
 * rather than inline because both callers need the same three facts and the
 * same "never let a notice fail the save" rule; the decision itself lives in
 * lib/agent/task-nudge.ts, shared with the tasks_write verb so the board and
 * the agent cannot drift on when somebody gets told.
 */
async function notifyAssigned(
  role: "admin" | "member",
  email: string | null,
  task: Awaited<ReturnType<typeof createTask>>,
  previousAssignee: string | null,
): Promise<void> {
  // NEVER THROWS, and that is the whole point of the try being here rather than
  // around the caller's write. The task is already committed by the time this
  // runs; notifyTaskAssigned is itself best-effort, but getViewer() and
  // getServiceClient() are not, and either one throwing used to turn a saved
  // assignment into {ok:false} — which the person answers by saving again, and
  // now there are two tasks.
  try {
    const { userId } = await getViewer();
    if (!userId || !email) return;
    await notifyTaskAssigned({
      serviceDb: getServiceClient() ?? undefined,
      caller: { profileId: userId, email, role },
      task,
      previousAssignee,
    });
  } catch (err) {
    console.warn("[tasks] could not send the assignment notice:", err);
  }
}

async function setAssigneeImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db, email, role } = await requireDb();
    const taskId = String(formData.get("taskId") ?? "");
    // Who held it BEFORE, so re-saving the same person in the dropdown is not a
    // second notice. One SELECT, same read the tasks_write verb does.
    const previousAssignee = (await previousTaskRow(db, taskId))?.assigned_to ?? null;
    // Empty means "back in the pool", which the data layer spells as null.
    const task = await assignTask(db, taskId, orNull(formData.get("assignedTo")));
    revalidatePath("/tasks");
    // AFTER the revalidate, and it cannot throw — see notifyAssigned.
    await notifyAssigned(role, email, task, previousAssignee);
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}

export async function addTask(formData: FormData): Promise<void> {
  finish(await addTaskImpl(formData), "/tasks");
}
export async function setStatus(formData: FormData): Promise<void> {
  finish(await setStatusImpl(formData), "/tasks");
}
export async function setAssignee(formData: FormData): Promise<void> {
  finish(await setAssigneeImpl(formData), "/tasks");
}
