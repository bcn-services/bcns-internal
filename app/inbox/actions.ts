/**
 * inbox/actions.ts — the only mutation the inbox has: marking a row read.
 *
 * MARKING READ IS NOT A WRITE PATH INTO ANOTHER PROFILE'S ROWS, and this file
 * is not what makes that true. The action takes an item ID and nothing else —
 * no profile id, so there is no field to forge — and it runs on the viewer's
 * own cookie-bound client, so `inbox_items_own_update` (0009: USING and WITH
 * CHECK both `profile_id = auth.uid()`) is what decides. Someone else's id
 * updates zero rows. `tests/inbox.test.mjs` proves that against real Postgres
 * with a forged JWT rather than through this action.
 *
 * The only reason it reports nothing on a miss is that "already read" and "not
 * yours" must be indistinguishable — a differing answer is a membership oracle
 * for a table that is private even from an admin.
 */
"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { getViewer } from "@/lib/supabase-server";
import { setRead } from "@/lib/inbox";
import { unreadTag } from "@/lib/inbox-badge";

async function markImpl(formData: FormData, read: boolean): Promise<void> {
  const { userId, client } = await getViewer();
  if (!client || !userId) return;
  const id = String(formData.get("itemId") ?? "");
  try {
    await setRead(client, id, read);
  } catch (err) {
    // A bad id is a malformed request, not something to 500 the page over.
    console.warn("[inbox] could not mark:", err);
    return;
  }
  // The badge is cached (lib/inbox-badge.ts); without this the number a person
  // just changed would sit stale for up to a minute on their own screen.
  revalidateTag(unreadTag(userId));
  revalidatePath("/inbox");
}

export async function markRead(formData: FormData): Promise<void> {
  await markImpl(formData, true);
}

export async function markUnread(formData: FormData): Promise<void> {
  await markImpl(formData, false);
}
