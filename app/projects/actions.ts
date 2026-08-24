/**
 * projects/actions.ts — the manual-override write layer.
 *
 * A project README under `~/os/projects` is the source of truth. These
 * actions do not touch it. They write a correction that sits ON TOP of what the
 * file says, in project_overrides / project_settings, so the board can be fixed
 * from the UI without a server editing someone's repository.
 *
 * Same trust boundary as the other action files: the viewer is re-read from the
 * session cookie on every call, and RLS is the enforcement point.
 */
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/supabase-server";
import { InvalidInputError } from "@/lib/accounts";
import { setOverride, setDueDate, setFieldHidden } from "@/lib/manual";

async function requireDb() {
  const { email, role, client } = await getViewer();
  if (!client) throw new InvalidInputError("Supabase is not configured.");
  if (role === null) throw new InvalidInputError("Your account is not provisioned.");
  return { email, db: client };
}

function toError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/permission denied|violates row-level security/i.test(msg)) {
    return "You do not have permission to do that.";
  }
  return msg;
}

async function run(work: () => Promise<void>): Promise<void> {
  let error: string | null = null;
  try {
    await work();
    revalidatePath("/projects");
  } catch (e) {
    error = toError(e);
  }
  if (error) redirect(`/projects?error=${encodeURIComponent(error)}`);
}

/** Set one overridden field. An empty value clears the override. */
export async function saveOverride(formData: FormData): Promise<void> {
  await run(async () => {
    const { db, email } = await requireDb();
    await setOverride(db, {
      projectId: String(formData.get("projectId") ?? ""),
      field: String(formData.get("field") ?? ""),
      value: String(formData.get("value") ?? ""),
      actor: email,
    });
  });
}

/** Set or clear a due date. An empty date field clears it. */
export async function saveDueDate(formData: FormData): Promise<void> {
  await run(async () => {
    const { db, email } = await requireDb();
    await setDueDate(db, {
      projectId: String(formData.get("projectId") ?? ""),
      date: String(formData.get("date") ?? "") || null,
      actor: email,
    });
  });
}

/**
 * Toggle a hideable field. The desired state is submitted explicitly rather
 * than flipped from what the server last read: two people on the board would
 * otherwise race, and the second click would undo the first.
 */
export async function saveFieldHidden(formData: FormData): Promise<void> {
  await run(async () => {
    const { db, email } = await requireDb();
    await setFieldHidden(db, {
      projectId: String(formData.get("projectId") ?? ""),
      field: String(formData.get("field") ?? ""),
      hidden: formData.get("hidden") === "1",
      actor: email,
    });
  });
}
