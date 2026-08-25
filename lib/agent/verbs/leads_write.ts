/**
 * leads_write — move a lead through the funnel or change its owner.
 *
 * Staff-writable by design: working leads is the member job (0002 gives
 * `authenticated` staff an UPDATE policy on accounts). What a member may NOT
 * do is decided at the database, not here — this verb's own gate is only about
 * which callers may attempt it at all.
 *
 * `outreach_mode` (0009) is settable here because pausing the agent on a lead
 * is exactly the kind of thing the person working it needs to do without an
 * admin.
 */

import { assignAccount, setAccountStatus, STAGES, isStage, isUuid, type Account, type Stage }
  from "../../accounts";
import { defineVerb, fail, ok, requireDb, type VerbResult } from "./types";

export const OUTREACH_MODES = ["ai", "human", "paused"] as const;
export type OutreachMode = (typeof OUTREACH_MODES)[number];

export interface LeadsWriteInput {
  id: string;
  status?: Stage;
  assignedTo?: string | null;
  outreachMode?: OutreachMode;
}

export const leads_write = defineVerb<LeadsWriteInput, Account>({
  name: "leads_write",
  description:
    "Update one lead: its funnel status, its owner, and/or whether the agent may contact it. " +
    "At least one field besides id must be given.",
  roles: ["admin", "member"],
  properties: {
    id: { type: "string", description: "The account uuid to update." },
    status: { type: "string", description: "New funnel stage.", enum: STAGES },
    assignedTo: {
      type: "string",
      description: "profiles.id of the new owner, or the literal 'unassigned' to release it.",
    },
    outreachMode: {
      type: "string",
      description: "Whether automated outreach may contact this lead.",
      enum: OUTREACH_MODES,
    },
  },
  required: ["id"],
  async handler(ctx, input): Promise<VerbResult<Account>> {
    const dbRes = requireDb(ctx, "leads_write");
    if (!dbRes.ok) return dbRes;
    const db = dbRes.data;

    if (!isUuid(input.id)) return fail("invalid_input", `bad account id: ${input.id}`);
    if (input.status === undefined && input.assignedTo === undefined && input.outreachMode === undefined) {
      return fail("invalid_input", "leads_write needs at least one of status, assignedTo, outreachMode");
    }
    if (input.status !== undefined && !isStage(input.status)) {
      return fail("invalid_input", `bad status: ${String(input.status)}`);
    }
    if (
      input.outreachMode !== undefined &&
      !(OUTREACH_MODES as readonly string[]).includes(input.outreachMode)
    ) {
      return fail("invalid_input", `bad outreach mode: ${String(input.outreachMode)}`);
    }

    let row: Account | null = null;
    if (input.status !== undefined) row = await setAccountStatus(db, input.id, input.status);
    if (input.assignedTo !== undefined) {
      const owner =
        input.assignedTo === null || input.assignedTo === "unassigned" ? null : input.assignedTo;
      if (owner !== null && !isUuid(owner)) return fail("invalid_input", `bad assignee id: ${owner}`);
      row = await assignAccount(db, input.id, owner);
    }
    if (input.outreachMode !== undefined) {
      const res = await db
        .from("accounts")
        .update({ outreach_mode: input.outreachMode })
        .eq("id", input.id)
        .select("*")
        .single();
      if (res.error) return fail("db_error", `leads_write (outreach_mode): ${res.error.message}`);
      row = res.data as Account;
    }
    if (!row) return fail("internal", "leads_write applied no update");
    return ok(row);
  },
});
