/**
 * leads/actions.ts — the mutating entry points for the lead list.
 *
 * Trust boundary: every action re-reads the viewer from the session cookie.
 * It never trusts a role passed in from the form, because a form field is
 * attacker-controlled. RLS is still the final word — `convert` has no member
 * INSERT policy on `clients`, so a member's attempt fails at the database even
 * if this layer were bypassed.
 */
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/supabase-server";
import {
  setAccountStatus, logActivity, convertAccountToClient, isStage, InvalidInputError,
} from "@/lib/accounts";

/**
 * Shape returned by the internal implementations: either it worked, or here is
 * why it did not. The exported actions wrap these, because a plain <form
 * action={...}> requires a void-returning function — so a failure is reported
 * by redirecting back with ?error=, which also works with JavaScript off.
 */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Turn a result into what a form action must be: void, or a redirect. */
function finish(result: ActionResult, backTo: string): void {
  if (!result.ok) redirect(`${backTo}?error=${encodeURIComponent(result.error)}`);
}

async function requireDb() {
  const { role, client } = await getViewer();
  if (!client) throw new InvalidInputError("Supabase is not configured.");
  if (role === null) throw new InvalidInputError("Your account is not provisioned.");
  return { role, db: client };
}

function toResult(e: unknown): ActionResult {
  const msg = e instanceof Error ? e.message : String(e);
  // Database denials come back as PostgREST permission errors. Translate the
  // common one so a member sees an explanation, not a raw driver string.
  if (/permission denied|violates row-level security/i.test(msg)) {
    return { ok: false, error: "You do not have permission to do that." };
  }
  return { ok: false, error: msg };
}

async function advanceStageImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db } = await requireDb();
    const id = String(formData.get("accountId") ?? "");
    const status = String(formData.get("status") ?? "");
    if (!isStage(status)) return { ok: false, error: `Unknown stage: ${status}` };
    await setAccountStatus(db, id, status);
    // Every stage change leaves a trace — this is the history the sheet lost.
    await logActivity(db, { accountId: id, kind: "stage", note: `moved to ${status}` });
    revalidatePath("/leads");
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}

async function addNoteImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db } = await requireDb();
    await logActivity(db, {
      accountId: String(formData.get("accountId") ?? ""),
      kind: String(formData.get("kind") || "note"),
      note: String(formData.get("note") ?? "") || null,
    });
    revalidatePath("/leads");
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}

/** Admin-only in practice; enforced by RLS, not by a check here. */
async function convertLeadImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db } = await requireDb();
    const raw = String(formData.get("dealValue") ?? "").trim();
    const client = await convertAccountToClient(db, {
      accountId: String(formData.get("accountId") ?? ""),
      slug: String(formData.get("slug") ?? "").trim() || undefined,
      dealValueDollars: raw || undefined,
    });
    revalidatePath("/leads");
    revalidatePath("/clients");
    revalidatePath(`/clients/${client.slug}`);
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}

// Exported form actions. Each runs its implementation and, on failure, bounces
// back to the list with the reason in the query string.
export async function advanceStage(formData: FormData): Promise<void> {
  finish(await advanceStageImpl(formData), "/leads");
}
export async function addNote(formData: FormData): Promise<void> {
  finish(await addNoteImpl(formData), "/leads");
}
export async function convertLead(formData: FormData): Promise<void> {
  finish(await convertLeadImpl(formData), "/leads");
}
