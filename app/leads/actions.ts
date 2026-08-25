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
  setAccountStatus, logActivity, convertAccountToClient, assignAccount, updateAccount,
  isStage, isUuid, InvalidInputError,
} from "@/lib/accounts";
import { isManualLaneMode } from "@/lib/outreach";

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

/**
 * Log the trace a completed change leaves, WITHOUT undoing the change.
 *
 * The change is already committed by the time this runs, so a failed log may
 * not come back as a bare driver string on a page that has in fact moved on —
 * the person re-clicks and changes an already-changed lead. It says what
 * happened and what did not.
 */
async function logAfterChange(
  db: Awaited<ReturnType<typeof requireDb>>["db"],
  input: Parameters<typeof logActivity>[1],
  applied: string,
): Promise<ActionResult> {
  try {
    await logActivity(db, input);
    return { ok: true };
  } catch (e) {
    console.warn("[leads] change applied but activity log failed:", e);
    const why = toResult(e);
    return {
      ok: false,
      error: `${applied}, but it could not be logged: ${why.ok ? "unknown error" : why.error}`,
    };
  }
}

async function advanceStageImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db } = await requireDb();
    const id = String(formData.get("accountId") ?? "");
    const status = String(formData.get("status") ?? "");
    if (!isStage(status)) return { ok: false, error: `Unknown stage: ${status}` };
    await setAccountStatus(db, id, status);
    // Every stage change leaves a trace — this is the history the sheet lost.
    // `status_change`, not "stage": the permitted kinds are the eight in
    // account_activity_kind_check, and "stage" violated it on every move.
    const logged = await logAfterChange(
      db,
      { accountId: id, kind: "status_change", note: `moved to ${status}` },
      `The lead moved to ${status}`,
    );
    revalidatePath("/leads");
    return logged;
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

/**
 * Set or clear a lead's owner.
 *
 * The UPDATE is written here rather than in lib/accounts.ts because that file
 * does not yet know about `assigned_to` and is not this change's to edit — it
 * belongs there as `assignAccount(db, id, profileId)`.
 *
 * Both ids are checked as UUIDs before the query so a malformed value never
 * reaches PostgREST, and an empty select becomes SQL NULL, never the string "".
 * RLS still decides whether the write lands.
 */
async function assignLeadImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db } = await requireDb();
    const id = String(formData.get("accountId") ?? "");
    if (!isUuid(id)) throw new InvalidInputError(`bad account id: ${id}`);

    // Blank means unassign, which is a real operation — assignAccount takes
    // null for it and validates the id itself.
    const raw = String(formData.get("assignedTo") ?? "").trim();
    const profileId = raw === "" ? null : raw;
    await assignAccount(db, id, profileId);

    // Ownership changes are history too — the same trace a stage move leaves.
    // `note`, not "assign": there is no `assign` kind, and widening the CHECK
    // to invent one would add a member-writable kind for a bookkeeping line.
    const logged = await logAfterChange(
      db,
      {
        accountId: id,
        kind: "note",
        note: profileId === null ? "unassigned" : `assigned to ${profileId}`,
      },
      profileId === null ? "The lead was unassigned" : "The lead was reassigned",
    );
    revalidatePath("/leads");
    return logged;
  } catch (e) {
    return toResult(e);
  }
}

/**
 * The manual lane override: put the bot on this lead, take it over, or stop it.
 *
 * DELIBERATELY LOGS NO ACTIVITY. Every other action here leaves a trace,
 * because every other action is a thing that happened TO the lead. This one is
 * a control-plane setting, and an `account_activity` row would be worse than
 * noise: 0015's trigger pauses any 'ai' lane the moment a human row lands, so
 * logging this change would flip "put the bot back on" straight to 'paused'
 * again. The lane column is its own record; `updated_at` says when it moved.
 *
 * Only the three lanes a person may choose are accepted. `no_response` is a
 * conclusion the bot reached, not a setting — a rep un-parks a lead by
 * choosing 'ai', which is the same control.
 */
async function setLaneImpl(formData: FormData): Promise<ActionResult> {
  try {
    const { db } = await requireDb();
    const id = String(formData.get("accountId") ?? "");
    if (!isUuid(id)) throw new InvalidInputError(`bad account id: ${id}`);
    const mode = String(formData.get("outreachMode") ?? "");
    if (!isManualLaneMode(mode)) return { ok: false, error: `Unknown outreach lane: ${mode}` };
    await updateAccount(db, id, { outreach_mode: mode });
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
export async function assignLead(formData: FormData): Promise<void> {
  finish(await assignLeadImpl(formData), "/leads");
}
export async function setLane(formData: FormData): Promise<void> {
  finish(await setLaneImpl(formData), "/leads");
}
