/**
 * notes/actions.ts — the write path for notes.
 *
 * Same trust boundary as leads/actions.ts: every action re-reads the viewer
 * from the session cookie and never trusts a role or an author supplied by the
 * form. RLS is the final word — a member deleting someone else's note is
 * refused by the database, not by a branch here.
 */
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/supabase-server";
import { InvalidInputError } from "@/lib/accounts";
import { addNote, assignNote, deleteNote } from "@/lib/manual";

async function requireDb() {
  const { role, email, client } = await getViewer();
  if (!client) throw new InvalidInputError("Supabase is not configured.");
  if (role === null) throw new InvalidInputError("Your account is not provisioned.");
  return { role, email, db: client };
}

function toError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/permission denied|violates row-level security/i.test(msg)) {
    return "You do not have permission to do that.";
  }
  return msg;
}

/**
 * A form action must return void or redirect. Failures bounce back with the
 * reason in the query string, which keeps the page working with JavaScript off.
 */
async function run(work: () => Promise<void>): Promise<void> {
  let error: string | null = null;
  try {
    await work();
    revalidatePath("/notes");
  } catch (e) {
    error = toError(e);
  }
  // redirect() throws to unwind, so it must sit OUTSIDE the try that catches.
  if (error) redirect(`/notes?error=${encodeURIComponent(error)}`);
}

export async function createNote(formData: FormData): Promise<void> {
  await run(async () => {
    const { db, email } = await requireDb();
    await addNote(db, {
      body: String(formData.get("body") ?? ""),
      projectId: String(formData.get("projectId") ?? "") || null,
      // The signed session, never the form. A forged author would be a note
      // its claimed writer could then delete.
      author: email,
    });
  });
}

export async function fileNote(formData: FormData): Promise<void> {
  await run(async () => {
    const { db } = await requireDb();
    await assignNote(db, {
      id: String(formData.get("id") ?? ""),
      projectId: String(formData.get("projectId") ?? "") || null,
    });
  });
}

export async function removeNote(formData: FormData): Promise<void> {
  await run(async () => {
    const { db } = await requireDb();
    await deleteNote(db, String(formData.get("id") ?? ""));
  });
}
