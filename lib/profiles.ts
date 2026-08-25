/**
 * profiles.ts — Data layer for the bcns employee directory.
 *
 * WHY THIS TABLE EXISTS. Staff identity already lives in auth.users, but that
 * table sits in the `auth` schema and PostgREST does not expose it, so the app
 * cannot read a name out of it. `profiles` is the standard Supabase mirror:
 * one public row per auth user, holding only what the UI has to display and
 * what a foreign key needs to point at.
 *
 * ROLE IS DELIBERATELY ABSENT here, as it is in 0004_profiles.sql. The gate and
 * every RLS policy read app_metadata.role off the JWT. A role column in an
 * API-writable table would be a second, member-editable source of truth — a
 * member could promote themselves by updating their own row.
 *
 * Platform rule (same as lib/accounts.ts): every function takes an INJECTED
 * Supabase client. This module reads no env, imports no `server-only`, and
 * constructs no client, so it stays keyless and testable with a fake.
 *
 * Authorization note: this layer does NOT check the caller's role. RLS in
 * supabase/migrations/0002_rls_policies.sql is the enforcement point.
 */

import { InvalidInputError, isUuid } from "./accounts";

export interface Profile {
  id: string;
  email: string;
  display_name: string;
  active: boolean;
  /**
   * What kind of work this person does — 0009's `developer` | `sales` | `ops`,
   * or null when nobody has set one. It is NOT a role: role lives in the JWT
   * and decides what anybody may do. Nothing security-critical reads this one,
   * which is why it is safe for it to sit in an API-readable column while role
   * deliberately does not.
   *
   * Typed as a plain string so the data layer states no opinion; `JOB_FUNCTIONS`
   * in lib/admin.ts is the list, and 0009's CHECK is the authority.
   */
  job_function: string | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_COLUMNS =
  "id, email, display_name, active, job_function, created_at, updated_at";

/** Structural shape of the query builder used here — see lib/accounts.ts. */
interface Result<T> {
  data: T | null;
  error: { message: string } | null;
}
type Client_ = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
};

/**
 * The directory, by display name — the order an assignment dropdown renders in.
 * `activeOnly` hides soft-offboarded staff from pickers while their existing
 * task history stays readable.
 */
export async function listProfiles(
  db: Client_,
  opts: { activeOnly?: boolean } = {},
): Promise<Profile[]> {
  let q = db.from("profiles").select(PROFILE_COLUMNS);
  if (opts.activeOnly) q = q.eq("active", true);
  const res: Result<Profile[]> = await q.order("display_name", { ascending: true });
  if (res.error) throw new Error(`listProfiles: ${res.error.message}`);
  return res.data ?? [];
}

export async function getProfile(db: Client_, id: string): Promise<Profile | null> {
  if (!isUuid(id)) throw new InvalidInputError(`bad profile id: ${id}`);
  const res: Result<Profile> = await db
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (res.error) throw new Error(`getProfile: ${res.error.message}`);
  return res.data ?? null;
}
