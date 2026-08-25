/**
 * profiles_query — the staff directory, plus each person's open-task load.
 *
 * THE DERIVED FIELD IS THE REASON THIS VERB EXISTS. "Who should take this?" is
 * the question an agent actually asks, and answering it from a bare directory
 * means pulling every task row into a prompt to count them. `openTasks` is that
 * count, computed here.
 *
 * TWO QUERIES, GROUPED IN MEMORY. PostgREST cannot return a GROUP BY without a
 * database view or RPC, and adding one for a staff-sized table would be a
 * migration to save a loop over a handful of rows.
 *
 * ponytail: the task read is bounded only by RLS. At bcns-scale (single-digit
 * staff, hundreds of open tasks) that is nothing. If `tasks` ever grows past
 * what one page can hold, this needs a `count` view rather than a bigger limit.
 *
 * A ZERO IS A REAL ANSWER. Every profile gets an `openTasks` number, including
 * profiles with no tasks at all — a missing key would read as "unknown load"
 * and an agent would route work by accident.
 */

import { OPEN_STATUSES } from "../../tasks";
import { defineVerb, fail, ok, requireDb, isUuid, type VerbResult } from "./types";

export interface ProfileWithLoad {
  id: string;
  email: string;
  display_name: string;
  active: boolean;
  job_function: string | null;
  last_briefed_at: string | null;
  /** Count of tasks assigned to this profile in a todo/doing state. */
  openTasks: number;
}

const PROFILE_COLUMNS =
  "id, email, display_name, active, job_function, last_briefed_at";

export interface ProfilesQueryInput {
  id?: string;
  activeOnly?: boolean;
}

export const profiles_query = defineVerb<ProfilesQueryInput, ProfileWithLoad[]>({
  name: "profiles_query",
  description:
    "Read the bcns staff directory. Each profile carries its job function, when it was last " +
    "briefed, and openTasks — how many todo/doing tasks are assigned to that person right now.",
  roles: ["admin", "member"],
  properties: {
    id: { type: "string", description: "A single profiles.id." },
    activeOnly: { type: "boolean", description: "Hide offboarded staff." },
  },
  async handler(ctx, input): Promise<VerbResult<ProfileWithLoad[]>> {
    const dbRes = requireDb(ctx, "profiles_query");
    if (!dbRes.ok) return dbRes;
    const db = dbRes.data;

    if (input.id !== undefined && !isUuid(input.id)) {
      return fail("invalid_input", `bad profile id: ${input.id}`);
    }

    let pq = db.from("profiles").select(PROFILE_COLUMNS);
    if (input.id !== undefined) pq = pq.eq("id", input.id);
    if (input.activeOnly) pq = pq.eq("active", true);
    const pres = await pq.order("display_name", { ascending: true });
    if (pres.error) return fail("db_error", `profiles_query: ${pres.error.message}`);
    const profiles = (pres.data ?? []) as Omit<ProfileWithLoad, "openTasks">[];

    // Only the grouping column. The rows themselves are never used, so
    // selecting anything else would be paying to transfer them.
    const tres = await db
      .from("tasks")
      .select("assigned_to")
      .in("status", [...OPEN_STATUSES]);
    if (tres.error) return fail("db_error", `profiles_query (tasks): ${tres.error.message}`);

    const load = new Map<string, number>();
    for (const row of (tres.data ?? []) as { assigned_to: string | null }[]) {
      if (row.assigned_to === null) continue;
      load.set(row.assigned_to, (load.get(row.assigned_to) ?? 0) + 1);
    }

    return ok(profiles.map((p) => ({ ...p, openTasks: load.get(p.id) ?? 0 })));
  },
});
