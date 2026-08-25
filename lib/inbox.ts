/**
 * inbox.ts — reading and marking one person's mail from the automation.
 *
 * PRIVACY IS RLS, NOT THIS FILE. `inbox_items_own_select` and
 * `inbox_items_own_update` (0009) both compare `profile_id = auth.uid()`, and
 * the UPDATE policy carries a WITH CHECK as well, so an owner can neither read
 * nor hand away someone else's row. There is deliberately no admin override.
 * The `.eq("profile_id", …)` calls below are therefore NOT the guard — they are
 * there to hit `inbox_items_profile_idx` and to make the badge count cheap.
 * `tests/inbox.test.mjs` proves the guard with a forged JWT against real
 * Postgres, never through these functions.
 *
 * Same platform rule as lib/profiles.ts: the Supabase client is INJECTED. This
 * module reads no env, imports no `server-only`, and constructs no client.
 *
 * WRITING IS NOT HERE. `inbox_items` has no INSERT policy at all; every row is
 * posted by `lib/agent/verbs/inbox_post.ts` through the service client, which
 * is the one bounded place that escalation is allowed.
 */

import { InvalidInputError, isUuid } from "./accounts";

export interface InboxItemRow {
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

/** Structural shape of the query builder used here — see lib/accounts.ts. */
interface Result<T> {
  data: T | null;
  count?: number | null;
  error: { message: string } | null;
}
type Client_ = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
};

/**
 * The mail, newest first. `limit` is a real cap and not politeness: an inbox
 * grows for as long as someone works here, and PostgREST would otherwise
 * truncate at its own maximum and say nothing about it.
 */
export async function listInbox(
  db: Client_,
  profileId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<InboxItemRow[]> {
  if (!isUuid(profileId)) throw new InvalidInputError(`bad profile id: ${profileId}`);
  let q = db.from("inbox_items").select(INBOX_COLUMNS).eq("profile_id", profileId);
  if (opts.unreadOnly) q = q.is("read_at", null);
  const res: Result<InboxItemRow[]> = await q
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);
  if (res.error) throw new Error(`listInbox: ${res.error.message}`);
  return res.data ?? [];
}

/**
 * How many are unread. `head: true` so the badge costs a count and not the
 * rows — this runs for the sidebar, which every page renders.
 */
export async function countUnread(db: Client_, profileId: string): Promise<number> {
  if (!isUuid(profileId)) throw new InvalidInputError(`bad profile id: ${profileId}`);
  const res: Result<null> = await db
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .is("read_at", null);
  if (res.error) throw new Error(`countUnread: ${res.error.message}`);
  return res.count ?? 0;
}

/**
 * Mark one item read or unread. The id is the ONLY thing a caller supplies: no
 * profile id is accepted, so there is no field to forge, and RLS' USING clause
 * is what decides whether the row is yours. A row that is not yours updates
 * zero rows and returns false — a miss, not an error, because "already read"
 * and "not yours" must look the same from outside.
 */
export async function setRead(db: Client_, id: string, read: boolean, now = new Date()): Promise<boolean> {
  if (!isUuid(id)) throw new InvalidInputError(`bad inbox item id: ${id}`);
  const res: Result<InboxItemRow[]> = await db
    .from("inbox_items")
    .update({ read_at: read ? now.toISOString() : null })
    .eq("id", id)
    .select("id");
  if (res.error) throw new Error(`setRead: ${res.error.message}`);
  return (res.data ?? []).length > 0;
}

/**
 * Where an item points, or null when it references nothing reachable.
 *
 * A client has its own page, so it wins when an item carries both. An account
 * has none — the funnel is one list — so the link is that list with the owner
 * filter forced to `anyone` (a member's bare /leads defaults to their own, and
 * a notice about a colleague's lead would land on a page not containing it)
 * and an anchor at the row, which app/leads/page.tsx gives every article.
 *
 * `source_job` is deliberately NOT a link. `inbox_items` stores the job's NAME,
 * not a `job_runs` id, and the run history page is item 12; inventing a URL for
 * a row we cannot identify would be a dead link, not a feature.
 */
export function itemHref(
  item: Pick<InboxItemRow, "account_id" | "client_id">,
  slugFor: (clientId: string) => string | undefined = () => undefined,
): string | null {
  if (item.client_id) {
    const slug = slugFor(item.client_id);
    return slug ? `/clients/${slug}` : "/clients";
  }
  if (item.account_id) return `/leads?assigned=anyone#account-${item.account_id}`;
  return null;
}

/**
 * What a reply to this item is ABOUT — the target `log_activity` needs.
 *
 * A reply is the second surface of item 4's verb, not a second write path: it
 * hands this target to the same parse → confirm → commit box the lead and
 * client pages use, so "nothing commits without the user seeing the parsed row"
 * holds here too. An item that references neither an account nor a client has
 * nothing to reply ONTO, and returns null so the box is not offered.
 */
export function replyTarget(
  item: Pick<InboxItemRow, "account_id" | "client_id">,
): { accountId: string } | { clientId: string } | null {
  if (item.account_id) return { accountId: item.account_id };
  if (item.client_id) return { clientId: item.client_id };
  return null;
}
