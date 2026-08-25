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

import { updateAccount, STAGES, isStage, isUuid, type Account, type Stage } from "../../accounts";
import { MANUAL_LANE_MODES, type ManualLaneMode } from "../../lanes";
import { defineVerb, fail, ok, requireDb, type VerbResult } from "./types";

// The lanes a person may pick, and this IS that list — not a second copy of it.
// It is the model-facing JSON-schema `enum` as well as the guard below, so a
// divergence from the database CHECK would be a tool description that lies.
export const OUTREACH_MODES = MANUAL_LANE_MODES;
export type OutreachMode = ManualLaneMode;

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

    // ONE update, not three. Sequential writes have no transaction around them:
    // a failure on the second would leave the first applied while this verb
    // reports an error, and the model would then re-issue the whole change.
    const patch: { status?: Stage; assigned_to?: string | null; outreach_mode?: OutreachMode } = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.assignedTo !== undefined) {
      const owner =
        input.assignedTo === null || input.assignedTo === "unassigned" ? null : input.assignedTo;
      if (owner !== null && !isUuid(owner)) return fail("invalid_input", `bad assignee id: ${owner}`);
      patch.assigned_to = owner;
    }
    if (input.outreachMode !== undefined) patch.outreach_mode = input.outreachMode;

    return ok(await updateAccount(db, input.id, patch));
  },
});
