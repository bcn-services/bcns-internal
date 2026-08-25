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
import { listInbox, itemHref, replyTarget } from "@/lib/inbox";
import { listClients } from "@/lib/accounts";
import ActivityCapture from "../activity-capture";
import { markRead, markUnread } from "./actions";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { userId, client: db } = await getViewer();

  const items = db && userId ? await listInbox(db, userId) : [];

  // One read for the whole page rather than one per item. Only fetched when an
  // item actually references a client — most notices reference neither.
  const needsSlugs = items.some((i) => i.client_id);
  const slugById = new Map<string, string>();
  if (db && needsSlugs) {
    for (const c of await listClients(db)) slugById.set(c.id, c.slug);
  }

  const unread = items.filter((i) => i.read_at === null).length;

  return (
    <main>
      <h1>Inbox</h1>
      <p>
        {items.length} {items.length === 1 ? "notice" : "notices"}, {unread} unread.
      </p>

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
    </main>
  );
}
