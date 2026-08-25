/**
 * tasks.ts — Data layer for assignable units of work (0005_tasks.sql).
 *
 * Platform rule (same as lib/accounts.ts): every function takes an INJECTED
 * Supabase client. This module reads no env, imports no `server-only`, and
 * constructs no client, so it stays keyless and testable with a fake.
 *
 * Authorization note: this layer does NOT check the caller's role. RLS in
 * supabase/migrations/0002_rls_policies.sql is the enforcement point — a
 * member's delete has no policy and fails at the database, not here.
 */

import { InvalidInputError, isUuid } from "./accounts";

/** The four task states. Order is lifecycle order; the DB CHECK matches. */
export const TASK_STATUSES = ["todo", "doing", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The states that still count as outstanding work — matches the partial index. */
export const OPEN_STATUSES: readonly TaskStatus[] = ["todo", "doing"];

export const isTaskStatus = (v: unknown): v is TaskStatus =>
  typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);

export interface Task {
  id: string;
  account_id: string | null;
  title: string;
  details: string | null;
  assigned_to: string | null;
  status: TaskStatus;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A list read with the two names the board actually renders. */
export interface TaskWithRefs extends Task {
  assignee: { display_name: string } | null;
  account: { business_name: string } | null;
}

const TASK_COLUMNS =
  "id, account_id, title, details, assigned_to, status, due_date, created_by, created_at, updated_at";

/**
 * `tasks` has TWO foreign keys to `profiles` (assigned_to and created_by), so a
 * bare `profiles(...)` embed is ambiguous and PostgREST rejects the request at
 * runtime. Naming the constraint — `profiles!tasks_assigned_to_fkey` — picks the
 * one we mean. `accounts` needs no hint: there is exactly one FK to it.
 */
const TASK_SELECT_WITH_REFS = `${TASK_COLUMNS}, assignee:profiles!tasks_assigned_to_fkey(display_name), account:accounts(business_name)`;

/** Structural shape of the query builder used here — see lib/accounts.ts. */
interface Result<T> {
  data: T | null;
  error: { message: string } | null;
}
type Client_ = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
};

function unwrap<T>(res: Result<T>, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data`);
  return res.data;
}

/**
 * The board read: soonest due first, undated work last, oldest first inside a
 * tie. RLS decides which rows come back.
 */
export async function listTasks(
  db: Client_,
  opts: {
    assignedTo?: string;
    accountId?: string;
    openOnly?: boolean;
    status?: TaskStatus;
  } = {},
): Promise<TaskWithRefs[]> {
  // Validate BEFORE touching the client, so a bad filter never issues a query.
  if (opts.assignedTo !== undefined && !isUuid(opts.assignedTo)) {
    throw new InvalidInputError(`bad assignee id: ${opts.assignedTo}`);
  }
  if (opts.accountId !== undefined && !isUuid(opts.accountId)) {
    throw new InvalidInputError(`bad account id: ${opts.accountId}`);
  }
  if (opts.status !== undefined && !isTaskStatus(opts.status)) {
    throw new InvalidInputError(`bad status: ${opts.status}`);
  }

  let q = db.from("tasks").select(TASK_SELECT_WITH_REFS);
  if (opts.assignedTo !== undefined) q = q.eq("assigned_to", opts.assignedTo);
  if (opts.accountId !== undefined) q = q.eq("account_id", opts.accountId);
  if (opts.status !== undefined) q = q.eq("status", opts.status);
  if (opts.openOnly) q = q.in("status", [...OPEN_STATUSES]);
  q = q.order("due_date", { ascending: true, nullsFirst: false });
  return unwrap<TaskWithRefs[]>(
    await q.order("created_at", { ascending: true }),
    "listTasks",
  );
}

export async function createTask(
  db: Client_,
  input: {
    title: string;
    details?: string | null;
    accountId?: string | null;
    assignedTo?: string | null;
    status?: TaskStatus;
    dueDate?: string | null;
    createdBy?: string | null;
  },
): Promise<Task> {
  // Mirrors the DB's `check (length(trim(title)) > 0)`.
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new InvalidInputError("task title is required");
  if (input.status !== undefined && !isTaskStatus(input.status)) {
    throw new InvalidInputError(`bad status: ${input.status}`);
  }
  for (const [label, id] of [
    ["account id", input.accountId],
    ["assignee id", input.assignedTo],
    ["creator id", input.createdBy],
  ] as const) {
    if (id !== undefined && id !== null && !isUuid(id)) {
      throw new InvalidInputError(`bad ${label}: ${id}`);
    }
  }

  return unwrap<Task>(
    await db
      .from("tasks")
      .insert({
        title,
        details: input.details ?? null,
        account_id: input.accountId ?? null,
        assigned_to: input.assignedTo ?? null,
        status: input.status ?? "todo",
        due_date: input.dueDate ?? null,
        created_by: input.createdBy ?? null,
      })
      .select(TASK_COLUMNS)
      .single(),
    "createTask",
  );
}

/**
 * ONE atomic patch of one task. Both writers below go through it: status and
 * assignee changed in two sequential updates can fail halfway, leaving the
 * first applied while the caller reports failure.
 */
export async function updateTask(
  db: Client_,
  id: string,
  patch: { status?: TaskStatus; assigned_to?: string | null },
): Promise<Task> {
  if (!isUuid(id)) throw new InvalidInputError(`bad task id: ${id}`);
  if (patch.status !== undefined && !isTaskStatus(patch.status)) {
    throw new InvalidInputError(`bad status: ${patch.status}`);
  }
  if (patch.assigned_to !== undefined && patch.assigned_to !== null && !isUuid(patch.assigned_to)) {
    throw new InvalidInputError(`bad assignee id: ${patch.assigned_to}`);
  }
  if (Object.keys(patch).length === 0) throw new InvalidInputError("updateTask: nothing to change");
  return unwrap<Task>(
    await db.from("tasks").update(patch).eq("id", id).select(TASK_COLUMNS).single(),
    "updateTask",
  );
}

export async function updateTaskStatus(db: Client_, id: string, status: TaskStatus): Promise<Task> {
  if (!isTaskStatus(status)) throw new InvalidInputError(`bad status: ${status}`);
  return updateTask(db, id, { status });
}

/**
 * Move a task's status ONLY if it does not already hold `unless`, and say
 * whether the move was this call's.
 *
 * The close path needs this. Read-the-status-then-update is two round trips
 * with a gap in the middle: two people (or two clicks) closing the same task
 * both read "doing", both update, and both send the nudge. The filter makes the
 * decision and the write one statement, so exactly one caller gets a row back.
 *
 * `null` means no row matched — already `unless`, or gone. The caller decides
 * which of those is an error; this function does not guess.
 */
export async function updateTaskStatusIfNot(
  db: Client_,
  id: string,
  status: TaskStatus,
  unless: TaskStatus,
): Promise<Task | null> {
  if (!isUuid(id)) throw new InvalidInputError(`bad task id: ${id}`);
  if (!isTaskStatus(status)) throw new InvalidInputError(`bad status: ${status}`);
  const res: Result<Task> = await db
    .from("tasks")
    .update({ status })
    .eq("id", id)
    .neq("status", unless)
    .select(TASK_COLUMNS)
    .maybeSingle();
  if (res.error) throw new Error(`updateTaskStatusIfNot: ${res.error.message}`);
  return res.data ?? null;
}

/** Reassign, or hand the work back to the pool with null. */
export async function assignTask(db: Client_, id: string, profileId: string | null): Promise<Task> {
  return updateTask(db, id, { assigned_to: profileId });
}
