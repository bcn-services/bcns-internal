/**
 * inbox/page.tsx — what the automation has to say to YOU.
 *
 * PRIVACY IS RLS. This page reads through the viewer's own cookie-bound client,
 * and `inbox_items` has owner-scoped SELECT and UPDATE policies and no admin
 * override at all (0009). The `profile_id` filter in lib/inbox.ts is an index
 * hint, not the gate — swap it out and an admin still sees nothing of anyone
 * else's, which is what tests/inbox.test.mjs proves with a forged JWT.
 *
 * REPLYING IS ITEM 4's VERB, SECOND SURFACE. The reply box is the same
 * <ActivityCapture> the lead and client pages mount, pointed at whatever the
 * item references, so a reply is parsed, shown to the person, edited if they
 * want, and only then written — the "nothing commits unseen" guardrail is not
 * re-implemented here, it is inherited by reusing the component.
 *
 * No client JavaScript for the read/unread controls: they are plain form posts
 * to ./actions.ts, styled by element like the rest of the app.
 */
import Link from "next/link";
import { getViewer } from "@/lib/supabase-server";
import { listInbox, countUnread, itemHref, replyTarget } from "@/lib/inbox";
import { listClientsByIds } from "@/lib/accounts";
import ActivityCapture from "../activity-capture";
import { markRead, markUnread } from "./actions";

export const dynamic = "force-dynamic";

/** One page of notices. The `before` cursor below walks back through the rest. */
const PAGE_SIZE = 100;

export default async function InboxPage({
  searchParams,
}: {
  searchParams?: { before?: string };
}) {
  const { userId, client: db } = await getViewer();

  // PAGED, NOT CAPPED. `inbox_items` has no DELETE policy, so a hard limit of
  // 100 makes the 101st notice a person ever receives permanently unreachable.
  // `before` is the previous page's oldest created_at.
  const before = searchParams?.before;
  const items = db && userId ? await listInbox(db, userId, { limit: PAGE_SIZE, before }) : [];

  // One read for the whole page rather than one per item, and only for the ids
  // actually on it — most notices reference no client at all.
  const clientIds = [...new Set(items.map((i) => i.client_id).filter((id): id is string => !!id))];
  const slugById = new Map<string, string>();
  if (db) {
    for (const c of await listClientsByIds(db, clientIds)) slugById.set(c.id, c.slug);
  }

  // Counted, not filtered from `items`: above one page the filtered number and
  // the nav badge would disagree on screen at the same time.
  const unread = db && userId ? await countUnread(db, userId) : 0;

  const older = items.length === PAGE_SIZE ? (items.at(-1)?.created_at ?? null) : null;

  return (
    <main>
      <h1>Inbox</h1>
      <p>
        {items.length} {items.length === 1 ? "notice" : "notices"} on this page, {unread} unread in
        total.
      </p>
      {before && <p><Link href="/inbox">Back to the newest</Link></p>}

      {!userId && <p>Sign in to read your inbox.</p>}
      {userId && items.length === 0 && <p>Nothing here yet.</p>}

      {items.map((item) => {
        const href = itemHref(item, (id) => slugById.get(id));
        const target = replyTarget(item);
        const isUnread = item.read_at === null;
        return (
          <article key={item.id} id={`item-${item.id}`}>
            <h2>
              {isUnread && <strong>• </strong>}
              {item.title}
            </h2>
            <p>
              <small>
                {new Date(item.created_at).toLocaleString()}
                {item.source_job ? ` · ${item.source_job}` : ""} · {item.kind}
                {isUnread ? " · unread" : ""}
              </small>
            </p>
            {item.body && <p>{item.body}</p>}

            <div>
              {href && <Link href={href}>Open what this is about</Link>}
              <form action={isUnread ? markRead : markUnread}>
                <input type="hidden" name="itemId" value={item.id} />
                <button type="submit">{isUnread ? "Mark read" : "Mark unread"}</button>
              </form>
            </div>

            {/* A notice about nothing in particular has nothing to log against. */}
            {target && <ActivityCapture target={target} label="Reply — log what happened" />}
          </article>
        );
      })}

      {older && (
        <p>
          <Link href={`/inbox?before=${encodeURIComponent(older)}`}>Load older notices</Link>
        </p>
      )}
    </main>
  );
}
