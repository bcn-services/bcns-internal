/**
 * log_activity — write one row into an account's timeline.
 *
 * TWO PATHS, ONE OF WHICH IS A STUB ON PURPOSE.
 *
 *   Explicit path  — the caller names `kind` (and optionally a note). Fully
 *                    implemented; this is what the confirmation step in item 4
 *                    will submit once a human has approved the parsed row.
 *   Parse path     — the caller passes free `text` and no `kind`. Item 4 owns
 *                    the parse (it runs through lib/agent/runner.ts). Until
 *                    then this returns a typed `not_implemented` and — the
 *                    part that matters — WRITES NO ROW. A stub that guessed a
 *                    kind would put fabricated history in the audit trail.
 *
 * AGENT KINDS ARE REFUSED HERE. 0009 narrowed `account_activity_staff_insert`
 * so an interactive member cannot insert `ai_email_sent` / `ai_email_reply` /
 * `agent_run`; only service_role writes those. This verb refuses them for
 * EVERY caller, admin included, because an admin's own 0002 policy
 * (`account_activity_admin_all`, FOR ALL) would otherwise let the audit trail
 * be forged through the very surface a model can reach.
 *
 * `actor_email` is always the caller's, never taken from input or from the
 * text — forging authorship is the whole risk in a free-text logging verb.
 */

import { logActivity as writeActivity, isUuid } from "../../accounts";
import { AGENT_KINDS, HUMAN_KINDS, type ActivityKind } from "./activity_query";
import { defineVerb, fail, ok, type VerbResult } from "./types";

export interface LogActivityInput {
  accountId: string;
  text?: string;
  kind?: ActivityKind;
  note?: string | null;
}

export interface LogActivityResult {
  written: true;
  accountId: string;
  kind: ActivityKind;
  note: string | null;
  actorEmail: string;
}

export const log_activity = defineVerb<LogActivityInput, LogActivityResult>({
  name: "log_activity",
  description:
    "Record one contact event on an account. Give an explicit kind to write it directly. " +
    "Free-text parsing (passing only `text`) is not implemented yet and writes nothing.",
  roles: ["admin", "member"],
  properties: {
    accountId: { type: "string", description: "Account uuid the event happened on." },
    text: { type: "string", description: "Free-text description of what happened." },
    kind: { type: "string", description: "The event kind.", enum: HUMAN_KINDS },
    note: { type: "string", description: "Cleaned note to store. Defaults to `text`." },
  },
  required: ["accountId"],
  async handler(ctx, input): Promise<VerbResult<LogActivityResult>> {
    if (!ctx.db) return fail("not_configured", "log_activity: no database client was injected");
    if (!isUuid(input.accountId)) return fail("invalid_input", `bad account id: ${input.accountId}`);

    if (input.kind !== undefined && AGENT_KINDS.includes(input.kind)) {
      return fail(
        "forbidden",
        `${input.kind} is written by the automation as service_role, not through log_activity`,
      );
    }
    if (input.kind !== undefined && !HUMAN_KINDS.includes(input.kind)) {
      return fail("invalid_input", `unknown activity kind: ${String(input.kind)}`);
    }

    if (input.kind === undefined) {
      // ponytail: parse stub — item 4 replaces this branch with a runner call.
      // It must keep returning BEFORE any write; a half-parse that guesses is
      // worse than no row.
      if (typeof input.text !== "string" || input.text.trim() === "") {
        return fail("invalid_input", "log_activity needs either a kind or some text");
      }
      return fail(
        "not_implemented",
        "free-text activity parsing lands in a later item; pass an explicit kind for now",
      );
    }

    const note = (input.note ?? input.text ?? null) || null;
    await writeActivity(ctx.db, {
      accountId: input.accountId,
      kind: input.kind,
      note,
      actor: ctx.caller.email,
    });
    return ok({
      written: true,
      accountId: input.accountId,
      kind: input.kind,
      note,
      actorEmail: ctx.caller.email,
    });
  },
});
