/**
 * activity_query — one account's contact history, newest first.
 *
 * This is the timeline 0009 deliberately kept as ONE table: what a human did
 * and what the agent did come back interleaved, so an agent reading an account
 * sees the same history a rep does.
 */

import { defineVerb, fail, ok, requireDb, isUuid, type VerbResult } from "./types";

export const ACTIVITY_KINDS = [
  "call",
  "email",
  "meeting",
  "note",
  "status_change",
  "ai_email_sent",
  "ai_email_reply",
  "agent_run",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The three kinds 0009 reserved for service_role writers. */
export const AGENT_KINDS: readonly ActivityKind[] = ["ai_email_sent", "ai_email_reply", "agent_run"];
export const HUMAN_KINDS: readonly ActivityKind[] = ACTIVITY_KINDS.filter(
  (k) => !AGENT_KINDS.includes(k),
);

export interface ActivityRow {
  id: string;
  account_id: string;
  kind: ActivityKind;
  note: string | null;
  actor_email: string | null;
  created_at: string;
}

const ACTIVITY_COLUMNS = "id, account_id, kind, note, actor_email, created_at";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface ActivityQueryInput {
  accountId: string;
  kind?: ActivityKind;
  limit?: number;
}

export const activity_query = defineVerb<ActivityQueryInput, ActivityRow[]>({
  name: "activity_query",
  description:
    "Read the activity timeline for one account, newest first. Includes both human contact " +
    "records and the agent's own entries.",
  roles: ["admin", "member"],
  properties: {
    accountId: { type: "string", description: "Account uuid whose history to read." },
    kind: { type: "string", description: "Only this kind of entry.", enum: ACTIVITY_KINDS },
    limit: { type: "integer", description: `Max rows (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}).` },
  },
  required: ["accountId"],
  async handler(ctx, input): Promise<VerbResult<ActivityRow[]>> {
    const dbRes = requireDb(ctx, "activity_query");
    if (!dbRes.ok) return dbRes;

    if (!isUuid(input.accountId)) return fail("invalid_input", `bad account id: ${input.accountId}`);
    if (input.kind !== undefined && !(ACTIVITY_KINDS as readonly string[]).includes(input.kind)) {
      return fail("invalid_input", `unknown activity kind: ${String(input.kind)}`);
    }

    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(Math.floor(input.limit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    let q = dbRes.data
      .from("account_activity")
      .select(ACTIVITY_COLUMNS)
      .eq("account_id", input.accountId);
    if (input.kind !== undefined) q = q.eq("kind", input.kind);
    // Bounded at the DATABASE, not after the fetch: an account with years of
    // history should not cross the wire to be sliced in memory.
    const res = await q.order("created_at", { ascending: false }).limit(limit);
    if (res.error) return fail("db_error", `activity_query: ${res.error.message}`);
    return ok((res.data ?? []) as ActivityRow[]);
  },
});
