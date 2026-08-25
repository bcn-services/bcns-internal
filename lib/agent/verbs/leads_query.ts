/**
 * leads_query — read accounts (leads) the caller is allowed to see.
 *
 * Both roles may read: RLS in 0002 lets staff select every account, and the
 * agent's whole job is working the funnel. `deal_value_cents` is stripped for a
 * member by the shared redactor in types.ts, not here.
 */

import { getAccount, listAccounts, STAGES, type Account, type Stage } from "../../accounts";
import { defineVerb, fail, ok, requireDb, isUuid, type VerbResult } from "./types";

export interface LeadsQueryInput {
  id?: string;
  status?: Stage;
  assignedTo?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const leads_query = defineVerb<LeadsQueryInput, Account[]>({
  name: "leads_query",
  description:
    "Read leads (accounts). Give an id for one lead, or filter by funnel status and/or assignee. " +
    "Returns newest first. Monetary fields are omitted unless the caller is an admin.",
  roles: ["admin", "member"],
  properties: {
    id: { type: "string", description: "A single account uuid. When given, other filters are ignored." },
    status: { type: "string", description: "Funnel stage to filter on.", enum: STAGES },
    assignedTo: {
      type: "string",
      description:
        "profiles.id of the owner to filter on. Pass the literal string 'unassigned' for leads with no owner.",
    },
    limit: { type: "integer", description: `Max rows (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}).` },
  },
  async handler(ctx, input): Promise<VerbResult<Account[]>> {
    const dbRes = requireDb(ctx, "leads_query");
    if (!dbRes.ok) return dbRes;
    const db = dbRes.data;

    if (input.id !== undefined) {
      if (!isUuid(input.id)) return fail("invalid_input", `bad account id: ${input.id}`);
      const row = await getAccount(db, input.id);
      return row ? ok([row]) : fail("not_found", `no account ${input.id}`);
    }

    // "unassigned" is spelled out because a model cannot type a JSON null into
    // a string-typed schema field, and `undefined` already means "no filter".
    const assignedTo =
      input.assignedTo === undefined
        ? undefined
        : input.assignedTo === null || input.assignedTo === "unassigned"
          ? null
          : input.assignedTo;

    const rows = await listAccounts(db, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(assignedTo !== undefined ? { assignedTo } : {}),
      // The cap goes to the DATABASE, as activity_query already does. A
      // rows.slice() here would pull the whole funnel back to drop most of it.
      limit: clampLimit(input.limit),
    });
    return ok(rows);
  },
});

export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}
