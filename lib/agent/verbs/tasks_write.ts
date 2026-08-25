/**
 * tasks_write — create a task, move it, or reassign it.
 *
 * `created_by` is forced to the CALLER's profile id and is not an input. A
 * model that could name the author of a task could forge one from the boss.
 */

import {
  assignTask,
  createTask,
  isTaskStatus,
  updateTaskStatus,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
} from "../../tasks";
import { isUuid } from "../../accounts";
import { defineVerb, fail, ok, requireDb, type VerbResult } from "./types";

export interface TasksWriteInput {
  id?: string;
  title?: string;
  details?: string | null;
  accountId?: string | null;
  assignedTo?: string | null;
  status?: TaskStatus;
  dueDate?: string | null;
}

export const tasks_write = defineVerb<TasksWriteInput, Task>({
  name: "tasks_write",
  description:
    "Create a task (give title) or update one (give id plus status and/or assignedTo). " +
    "The creator is always the calling user and cannot be set.",
  roles: ["admin", "member"],
  properties: {
    id: { type: "string", description: "Task uuid to update. Omit to create." },
    title: { type: "string", description: "Task title. Required when creating." },
    details: { type: "string", description: "Longer description." },
    accountId: { type: "string", description: "Account uuid this task is about." },
    assignedTo: {
      type: "string",
      description: "profiles.id of the assignee, or the literal 'unassigned' to release it.",
    },
    status: { type: "string", description: "Task status.", enum: TASK_STATUSES },
    dueDate: { type: "string", description: "Due date as YYYY-MM-DD." },
  },
  async handler(ctx, input): Promise<VerbResult<Task>> {
    const dbRes = requireDb(ctx, "tasks_write");
    if (!dbRes.ok) return dbRes;
    const db = dbRes.data;

    const assignee =
      input.assignedTo === undefined
        ? undefined
        : input.assignedTo === null || input.assignedTo === "unassigned"
          ? null
          : input.assignedTo;
    if (assignee !== undefined && assignee !== null && !isUuid(assignee)) {
      return fail("invalid_input", `bad assignee id: ${assignee}`);
    }
    if (input.status !== undefined && !isTaskStatus(input.status)) {
      return fail("invalid_input", `bad status: ${String(input.status)}`);
    }

    if (input.id === undefined) {
      if (typeof input.title !== "string" || input.title.trim() === "") {
        return fail("invalid_input", "tasks_write needs a title to create a task, or an id to update one");
      }
      return ok(
        await createTask(db, {
          title: input.title,
          details: input.details ?? null,
          accountId: input.accountId ?? null,
          assignedTo: assignee ?? null,
          dueDate: input.dueDate ?? null,
          // Never from input: the author is whoever is calling.
          createdBy: ctx.caller.profileId,
          ...(input.status !== undefined ? { status: input.status } : {}),
        }),
      );
    }

    if (!isUuid(input.id)) return fail("invalid_input", `bad task id: ${input.id}`);
    if (input.status === undefined && assignee === undefined) {
      return fail("invalid_input", "tasks_write needs status or assignedTo when updating");
    }

    let row: Task | null = null;
    if (input.status !== undefined) row = await updateTaskStatus(db, input.id, input.status);
    if (assignee !== undefined) row = await assignTask(db, input.id, assignee);
    if (!row) return fail("internal", "tasks_write applied no update");
    return ok(row);
  },
});
