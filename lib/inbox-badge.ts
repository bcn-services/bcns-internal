/**
 * inbox-badge.ts — the unread number in the sidebar, WITHOUT a query per page.
 *
 * The problem: the badge lives in the root layout, and the root layout renders
 * on every navigation to every route. A straight `select count(*)` there is one
 * extra round trip on every page view forever, for a number that changes a
 * couple of times a day.
 *
 * What was chosen: ONE layout-level read, wrapped in `unstable_cache` keyed by
 * the viewer's profile id and tagged `inbox:<id>`. Navigations inside the
 * revalidate window read the cached integer and issue no query at all. The cost
 * is staleness — the badge can be up to BADGE_TTL_SECONDS behind for a row some
 * OTHER actor wrote (a job posting a notice). Everything this person does to
 * their own inbox calls `revalidateTag(unreadTag(id))` and is immediate.
 *
 * THE VIEWER, NOT AN ID, AND NO CALLER-SUPPLIED QUERY. This count runs through
 * the SERVICE-role client, which bypasses RLS, so the only thing scoping it is
 * the profile id it is given. That id must come from a verified
 * `auth.getUser()`. Taking the `getViewer()` RESULT rather than a string is
 * what makes an unverified id unrepresentable instead of merely discouraged,
 * and the query itself is built HERE (`countUnreadForOwner`) rather than passed
 * in, so a caller cannot hand a cached, RLS-bypassing closure that reads
 * something else. The only thing injected is the client FACTORY, because
 * lib/supabase-admin.ts imports `server-only` and this module must stay
 * loadable under plain node.
 */

import { unstable_cache } from "next/cache";
import { countUnreadForOwner } from "./inbox";

/** Structural shape of the service client, mirroring lib/inbox.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InboxDb = { from(table: string): any };

/** How long a badge may lag a row written by someone else. */
export const BADGE_TTL_SECONDS = 60;

/** The tag every mutation of this person's inbox must revalidate. */
export const unreadTag = (profileId: string): string => `inbox:${profileId}`;

/** Whatever `getViewer()` returned. Only `userId` is read. */
export type BadgeViewer = { userId: string | null };

/**
 * The cached count, or null when there is no number to show — signed out, no
 * Supabase configured, or called outside a Next render.
 *
 * NULL IS NOT ZERO. "We do not know" and "no mail" are different facts, and the
 * old code turned a permanently broken query into a permanently empty badge
 * behind a console.warn. Only the one expected failure — `unstable_cache`
 * outside a render, where Next throws about a missing incrementalCache — is
 * swallowed. A failing QUERY is re-thrown: a badge that lies forever is worse
 * than an error someone can see.
 */
export async function cachedUnreadCount(
  viewer: BadgeViewer,
  getServiceDb: () => InboxDb | null,
): Promise<number | null> {
  const profileId = viewer?.userId ?? null;
  if (!profileId) return null;

  // Built here, on purpose: see the header. Nothing about what is read or whose
  // rows they are comes from the caller.
  const load = async (): Promise<number> => {
    const db = getServiceDb();
    return db ? countUnreadForOwner(db, profileId) : 0;
  };

  try {
    const read = unstable_cache(load, ["inbox-unread", profileId], {
      revalidate: BADGE_TTL_SECONDS,
      tags: [unreadTag(profileId)],
    });
    return await read();
  } catch (err) {
    if (!String((err as { message?: unknown })?.message ?? err).includes("incrementalCache")) throw err;
    console.warn("[inbox-badge] no incremental cache; rendering no badge:", err);
    return null;
  }
}
