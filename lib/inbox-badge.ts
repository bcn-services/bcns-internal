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
 * The loader is INJECTED so this file stays free of Supabase and of `cookies()`
 * — which matters twice: it is testable under plain node, and a cached function
 * may not touch request-scoped dynamic APIs anyway.
 */

import { unstable_cache } from "next/cache";

/** How long a badge may lag a row written by someone else. */
export const BADGE_TTL_SECONDS = 60;

/** The tag every mutation of this person's inbox must revalidate. */
export const unreadTag = (profileId: string): string => `inbox:${profileId}`;

/**
 * The cached count. Returns 0 rather than throwing: a sidebar is not worth a
 * 500, and a badge that fails closed reads as "no mail", which is the honest
 * degraded answer.
 */
export async function cachedUnreadCount(
  profileId: string,
  load: () => Promise<number>,
): Promise<number> {
  try {
    const read = unstable_cache(load, ["inbox-unread", profileId], {
      revalidate: BADGE_TTL_SECONDS,
      tags: [unreadTag(profileId)],
    });
    return await read();
  } catch (err) {
    console.warn("[inbox-badge] could not read the unread count:", err);
    return 0;
  }
}
