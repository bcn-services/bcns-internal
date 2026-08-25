/**
 * inbox.ts — reading and marking one person's mail from the automation.
 *
 * WHICH CLIENT YOU HAND IN IS THE WHOLE SAFETY STORY, and it is NOT the same
 * answer for every function here. Read the note on each one.
 *
 *   - `listInbox`, `countUnread`, `setRead` are RLS-BOUND. They take the
 *     viewer's cookie-bound client, and `inbox_items_own_select` /
 *     `inbox_items_own_update` (0009) compare `profile_id = auth.uid()`, so
 *     the `.eq("profile_id", …)` in them is an index hint and not the guard.
 *     They REFUSE a service-role client outright (lib/service-client-mark.ts)
 *     — with that client the comment above would be a lie.
 *
 *   - `countUnreadForOwner` is the escalated one, for the sidebar badge, and
 *     there the `.eq("profile_id", …)` IS the guard. See its own note.
 *
 * `tests/inbox.test.mjs` proves the RLS guard with a forged JWT against real
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
import { isServiceClient } from "./service-client-mark";

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
 * The RLS-bound functions' one precondition, checked rather than documented.
 * A service-role client bypasses every policy on `inbox_items`, which would
 * silently turn "the .eq is only an index hint" into "the .eq is the only
 * thing scoping this query" — the exact mistake this throws on.
 */
function assertRlsBound(db: Client_, fn: string): void {
  if (isServiceClient(db)) {
    throw new Error(
      `${fn}: refusing a service-role client — RLS is this function's guard. ` +
        `Use countUnreadForOwner if you meant the badge's escalated count.`,
    );
  }
}

/**
 * The mail, newest first. `limit` is a real cap and not politeness: an inbox
 * grows for as long as someone works here, and PostgREST would otherwise
 * truncate at its own maximum and say nothing about it.
 */
export async function listInbox(
  db: Client_,
  profileId: string,
  opts: { unreadOnly?: boolean; kind?: string; limit?: number; before?: string } = {},
): Promise<InboxItemRow[]> {
  assertRlsBound(db, "listInbox");
  if (!isUuid(profileId)) throw new InvalidInputError(`bad profile id: ${profileId}`);
  let q = db.from("inbox_items").select(INBOX_COLUMNS).eq("profile_id", profileId);
  if (opts.unreadOnly) q = q.is("read_at", null);
  // One kind of notice, for a surface that shows one kind — the briefing card
  // wants this person's newest `daily_briefing` and not their newest anything.
  if (opts.kind) q = q.eq("kind", opts.kind);
  // The cursor. `inbox_items` has no DELETE policy, so without one the 101st
  // notice a person ever receives is unreachable for the rest of their
  // employment. `before` is the last row's created_at from the previous page.
  //
  // ponytail: the cursor is created_at ALONE, so two notices written in the
  // same microsecond could straddle a page boundary and one be skipped. The
  // order below is (created_at desc, id desc) so the fix is a compound
  // `.or("created_at.lt.X,and(created_at.eq.X,id.lt.Y)")` here — do it if the
  // jobs ever post in batches that share a timestamp.
  if (opts.before) q = q.lt("created_at", opts.before);
  const res: Result<InboxItemRow[]> = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(opts.limit ?? 100);
  if (res.error) throw new Error(`listInbox: ${res.error.message}`);
  return res.data ?? [];
}

/**
 * How many are unread, for the VIEWER'S OWN client. `head: true` so it costs a
 * count and not the rows.
 *
 * RLS-bound: the `.eq("profile_id", …)` here is an index hint, and deleting it
 * would still return only your own rows. That is true because this function
 * refuses a service-role client — see `countUnreadForOwner` for the case where
 * the same filter is load-bearing.
 */
export async function countUnread(db: Client_, profileId: string): Promise<number> {
  assertRlsBound(db, "countUnread");
  return countUnreadForOwner(db, profileId);
}

/**
 * The sidebar badge's count, taken through the SERVICE-role client.
 *
 * HERE THE `.eq("profile_id", …)` IS THE GUARD. No policy applies to this
 * query; that one filter is the only thing standing between this person's
 * badge and the number of unread notices in the whole company. Do not remove
 * it, and do not widen this function's parameters — `profileId` must come from
 * a verified `auth.getUser()`, which lib/inbox-badge.ts enforces by taking the
 * viewer object rather than a bare string.
 */
export async function countUnreadForOwner(db: Client_, profileId: string): Promise<number> {
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
  assertRlsBound(db, "setRead");
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
