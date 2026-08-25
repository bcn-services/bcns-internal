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
}

export interface LeadsStatsInput {
  assignedTo?: string;
}

export const leads_stats = defineVerb<LeadsStatsInput, LeadsStats>({
  name: "leads_stats",
  description:
    "Count leads by funnel stage. Returns a total, the number still open (not won/lost/dead), " +
    "a per-stage histogram, and how many have no owner. Optionally scoped to one assignee.",
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

    // Only the two columns the histogram needs — a `select *` here would pull
    // notes and score_reason for every lead in the database to count them.
    let q = dbRes.data.from("accounts").select("status, assigned_to");
    if (input.assignedTo !== undefined) q = q.eq("assigned_to", input.assignedTo);
    const res = await q;
    if (res.error) return fail("db_error", `leads_stats: ${res.error.message}`);

    const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    let unassigned = 0;
    const rows = (res.data ?? []) as { status: Stage; assigned_to: string | null }[];
    for (const row of rows) {
      if (row.status in byStage) byStage[row.status] += 1;
      if (row.assigned_to === null) unassigned += 1;
    }
    const closed = TERMINAL_STAGES.reduce((n, s) => n + byStage[s], 0);
    return ok({ total: rows.length, open: rows.length - closed, byStage, unassigned });
  },
});
