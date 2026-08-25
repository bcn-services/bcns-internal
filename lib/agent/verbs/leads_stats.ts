/**
 * leads_stats — the funnel shape, counted rather than listed.
 *
 * Exists so an agent asking "how is the pipeline doing" does not pull every
 * account row into a prompt to count them itself. Counting happens over the
 * rows RLS returns, so the answer is already scoped to the caller.
 *
 * Deliberately no money in the payload — a stage histogram needs none, and a
 * verb that carries no money field cannot leak one.
 */

import { STAGES, TERMINAL_STAGES, type Stage } from "../../accounts";
import { defineVerb, fail, ok, requireDb, isUuid, type VerbResult } from "./types";

export interface LeadsStats {
  total: number;
  open: number;
  byStage: Record<Stage, number>;
  unassigned: number;
  /** True when the ceiling below was hit and the counts are a floor, not a total. */
  truncated: boolean;
}

/** PostgREST caps an unbounded select at 1000 rows and says nothing about it. */
const PAGE = 1000;
/** Hard ceiling so a runaway table cannot turn one verb call into 10k round trips. */
const MAX_PAGES = 100;

export interface LeadsStatsInput {
  assignedTo?: string;
}

export const leads_stats = defineVerb<LeadsStatsInput, LeadsStats>({
  name: "leads_stats",
  description:
    "Count leads by funnel stage. Returns a total, the number still open (not won/lost/dead), " +
    "a per-stage histogram, and how many have no owner. Optionally scoped to one assignee. " +
    "truncated:true means there were more leads than this verb will page through, so the counts are a floor.",
  roles: ["admin", "member"],
  properties: {
    assignedTo: { type: "string", description: "profiles.id — count only this person's leads." },
  },
  async handler(ctx, input): Promise<VerbResult<LeadsStats>> {
    const dbRes = requireDb(ctx, "leads_stats");
    if (!dbRes.ok) return dbRes;

    if (input.assignedTo !== undefined && !isUuid(input.assignedTo)) {
      return fail("invalid_input", `bad assignee id: ${input.assignedTo}`);
    }

    const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    let unassigned = 0;
    let total = 0;
    let truncated = false;

    // PAGED. An unpaginated select stops at PostgREST's 1000-row default and
    // returns a confidently wrong total, which is worse than a slow one.
    // Ordered by id so the page boundaries are stable across round trips.
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
      // Only the two columns the histogram needs — a `select *` here would pull
      // notes and score_reason for every lead in the database to count them.
      let q = dbRes.data.from("accounts").select("status, assigned_to, id");
      if (input.assignedTo !== undefined) q = q.eq("assigned_to", input.assignedTo);
      const res = await q.order("id", { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1);
      if (res.error) return fail("db_error", `leads_stats: ${res.error.message}`);
      const rows = (res.data ?? []) as { status: Stage; assigned_to: string | null }[];
      for (const row of rows) {
        if (row.status in byStage) byStage[row.status] += 1;
        if (row.assigned_to === null) unassigned += 1;
      }
      total += rows.length;
      if (rows.length < PAGE) break;
    }

    const closed = TERMINAL_STAGES.reduce((n, s) => n + byStage[s], 0);
    return ok({ total, open: total - closed, byStage, unassigned, truncated });
  },
});
