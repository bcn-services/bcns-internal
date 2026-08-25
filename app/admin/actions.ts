/**
 * admin/actions.ts — the three mutating entry points on /admin.
 *
 * ADMIN-ONLY IS ENFORCED TWICE, AND HIDING A CONTROL IS NEITHER TIME.
 *
 *   1. THE ROUTE. middleware.ts gates `/admin` through lib/auth.ts's pure
 *      `routeAccessDecision`, which forbids a non-admin and is turned into a
 *      403 — not a redirect. `requireAdmin` below re-reads the viewer from the
 *      session COOKIE, never from the form, because a server action is a POST
 *      to its own endpoint and a caller can reach it without ever loading the
 *      page whose middleware ran.
 *   2. THE DATABASE. Every write goes through the viewer's own cookie-bound,
 *      RLS-governed client. `lead_targets_admin_all` (0009) and
 *      `profiles_admin_all` (0004) both test `public.is_admin()`, which reads
 *      the same `app_metadata.role` claim `resolveRole` does. A member who got
 *      past step 1 is refused by Postgres.
 *
 * Nothing here touches the service role. There is no delete of anything.
 */
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/supabase-server";
import { InvalidInputError } from "@/lib/accounts";
import {
  addLeadTarget,
  asJobFunctionInput,
  setJobFunction,
  setLeadTargetActive,
} from "@/lib/admin";

/**
 * The second gate. Throws rather than returning a role, so there is no way to
 * call one of the writes below having forgotten to check.
 */
async function requireAdmin() {
  const { role, userId, client } = await getViewer();
  if (role !== "admin") throw new InvalidInputError("Administrators only.");
  if (!client) throw new InvalidInputError("Supabase is not configured.");
  return { db: client, userId };
}

/**
 * Report a failure the way the rest of this app does: back to the page with
 * `?error=`, which works with JavaScript off. A plain <form action> must
 * return void, so every exported action ends in a redirect or nothing.
 */
function finish(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const friendly = /permission denied|violates row-level security/i.test(msg)
    ? "You do not have permission to do that."
    : msg;
  redirect(`/admin?error=${encodeURIComponent(friendly)}`);
}

export async function addTarget(formData: FormData): Promise<void> {
  try {
    const { db, userId } = await requireAdmin();
    await addLeadTarget(db, {
      trade: formData.get("trade"),
      town: formData.get("town"),
      // The authenticated caller, never a form field.
      createdBy: userId,
    });
  } catch (e) {
    finish(e);
  }
  revalidatePath("/admin");
}

/**
 * Deactivate or reactivate a target. A FLAG FLIP, AND ONLY A FLAG FLIP.
 *
 * Nothing is deleted: not the target, and certainly not the accounts that came
 * from it — no account row references `lead_targets` at all, so there is no
 * cascade here to get wrong. The sweep's own query already filters on
 * `active`, so this one write is the whole behaviour change.
 */
export async function setTargetActive(formData: FormData): Promise<void> {
  try {
    const { db } = await requireAdmin();
    await setLeadTargetActive(
      db,
      String(formData.get("id") ?? ""),
      formData.get("active") === "true",
    );
  } catch (e) {
    finish(e);
  }
  revalidatePath("/admin");
}

/**
 * Set somebody's job function. NOT their role.
 *
 * This column gates which skill buttons render and nothing else — it is in no
 * RLS policy and in no JWT claim, and `app/api/skills/run/route.ts` authorizes
 * on role regardless of what any button showed. Setting it can therefore never
 * grant anybody a permission they did not already have.
 */
export async function setPersonJobFunction(formData: FormData): Promise<void> {
  try {
    const { db } = await requireAdmin();
    await setJobFunction(
      db,
      String(formData.get("profileId") ?? ""),
      asJobFunctionInput(formData.get("jobFunction")),
    );
  } catch (e) {
    finish(e);
  }
  revalidatePath("/admin");
}
