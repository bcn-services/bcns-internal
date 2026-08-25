/**
 * inbox_post — put one notice in one person's inbox.
 *
 * WHO MAY POST. `inbox_items` (0009) has NO insert policy, deliberately: a
 * user-writable inbox lets anyone plant a notification in a colleague's feed.
 * Rows are written by jobs running as service_role, so the client injected
 * here is the service-role client and RLS is NOT the guard. That makes this
 * file the guard, and it is narrow on purpose:
 *
 *   admin  → may post to anyone (the automation runs under an admin identity)
 *   member → may post to THEMSELVES only
 *
 * A member posting into someone else's inbox is `forbidden`, not a silent
 * no-op, so an agent acting for a member learns the rule instead of retrying.
 *
 * Reading is not here. An inbox is private even from an admin (0009 has no
 * admin read policy), so reads go through the owner's own RLS-scoped client.
 */

import { defineVerb, fail, ok, requireDb, isUuid, type VerbResult } from "./types";

export interface InboxPostInput {
  profileId: string;
  kind: string;
  title: string;
  body?: string | null;
  sourceJob?: string | null;
  accountId?: string | null;
  clientId?: string | null;
}

export interface InboxItem {
  id: string;
  profile_id: string;
  kind: string;
  title: string;
  body: string | null;
  source_job: string | null;
  account_id: string | null;
  client_id: string | null;
  read_at: string | null;
  created_at: string;
}

const INBOX_COLUMNS =
  "id, profile_id, kind, title, body, source_job, account_id, client_id, read_at, created_at";

export const inbox_post = defineVerb<InboxPostInput, InboxItem>({
  name: "inbox_post",
  description:
    "Send one notice to a person's inbox. An admin may post to anyone; a member may post only " +
    "to their own inbox. Optionally links the notice to an account or a client.",
  roles: ["admin", "member"],
  properties: {
    profileId: { type: "string", description: "Whose inbox to post into (profiles.id)." },
    kind: { type: "string", description: "Short machine label, e.g. 'lead_gone_cold'." },
    title: { type: "string", description: "One-line summary the person sees in the list." },
    body: { type: "string", description: "The full message." },
    sourceJob: { type: "string", description: "Which job produced this notice." },
    accountId: { type: "string", description: "Account uuid this notice is about." },
    clientId: { type: "string", description: "Client uuid this notice is about." },
  },
  required: ["profileId", "kind", "title"],
  async handler(ctx, input): Promise<VerbResult<InboxItem>> {
    const dbRes = requireDb(ctx, "inbox_post");
    if (!dbRes.ok) return dbRes;

    if (!isUuid(input.profileId)) return fail("invalid_input", `bad profile id: ${input.profileId}`);
    if (ctx.caller.role !== "admin" && input.profileId !== ctx.caller.profileId) {
      return fail("forbidden", "a member may only post to their own inbox");
    }
    const kind = typeof input.kind === "string" ? input.kind.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!kind) return fail("invalid_input", "inbox_post needs a kind");
    if (!title) return fail("invalid_input", "inbox_post needs a title");
    for (const [label, id] of [
      ["account id", input.accountId],
      ["client id", input.clientId],
    ] as const) {
      if (id !== undefined && id !== null && !isUuid(id)) {
        return fail("invalid_input", `bad ${label}: ${id}`);
      }
    }

    const res = await dbRes.data
      .from("inbox_items")
      .insert({
        profile_id: input.profileId,
        kind,
        title,
        body: input.body ?? null,
        source_job: input.sourceJob ?? null,
        account_id: input.accountId ?? null,
        client_id: input.clientId ?? null,
      })
      .select(INBOX_COLUMNS)
      .single();
    if (res.error) return fail("db_error", `inbox_post: ${res.error.message}`);
    return ok(res.data as InboxItem);
  },
});
