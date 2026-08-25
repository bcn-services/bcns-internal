/**
 * tasks_query — read the work board.
 *
 * RLS (0007_own_tasks_only.sql) already decides which tasks a member sees, so
 * this verb adds filters, not authorization beyond the role gate.
 */

import { listTasks, TASK_STATUSES, type TaskStatus, type TaskWithRefs } from "../../tasks";
import { defineVerb, fail, ok, requireDb, isUuid, type VerbResult } from "./types";

export interface TasksQueryInput {
  assignedTo?: string;
  accountId?: string;
  status?: TaskStatus;
  openOnly?: boolean;
}

export const tasks_query = defineVerb<TasksQueryInput, TaskWithRefs[]>({
  name: "tasks_query",
  description:
    "Read tasks, soonest due first. Filter by assignee, by account, by status, or ask for open " +
    "work only (todo + doing). Each row carries the assignee's display name and the account name.",
  roles: ["admin", "member"],
  properties: {
    assignedTo: { type: "string", description: "profiles.id of the assignee." },
    accountId: { type: "string", description: "Account uuid the task hangs off." },
    status: { type: "string", description: "Exact task status.", enum: TASK_STATUSES },
    openOnly: { type: "boolean", description: "Only todo and doing." },
  },
  async handler(ctx, input): Promise<VerbResult<TaskWithRefs[]>> {
    const dbRes = requireDb(ctx, "tasks_query");
    if (!dbRes.ok) return dbRes;

    for (const [label, id] of [
      ["assignee id", input.assignedTo],
      ["account id", input.accountId],
    ] as const) {
      if (id !== undefined && !isUuid(id)) return fail("invalid_input", `bad ${label}: ${id}`);
    }

    return ok(
      await listTasks(dbRes.data, {
        ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.openOnly !== undefined ? { openOnly: input.openOnly } : {}),
      }),
    );
  },
});
