/**
 * supabase-server.ts — the one place a server component or server action gets
 * a cookie-bound, RLS-governed Supabase client.
 *
 * Split from supabase-ssr.ts because this file imports next/headers, which
 * pins it to the Next server runtime. Keeping that import out of
 * supabase-ssr.ts is what lets middleware (edge) and the tests reuse the
 * factory there.
 */

import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSsrClient, getSessionUser } from "./supabase-ssr";
import { resolveRole, type Role } from "./auth";

/** Cookie-bound client for this request, or null when Supabase is unconfigured. */
export async function getServerClient(): Promise<SupabaseClient | null> {
  const store = await cookies();
  return getSsrClient({
    getAll: () => store.getAll(),
    // Server components cannot set cookies. Middleware already refreshed the
    // session on this request, so swallowing the write is correct, not lossy.
    setAll: () => {},
  });
}

/**
 * The caller's identity for this request. Middleware has already gated the
 * route; this is for rendering decisions (show the admin button or not) and
 * for the second check inside a mutating server action.
 */
export async function getViewer(): Promise<{ role: Role | null; client: SupabaseClient | null }> {
  const client = await getServerClient();
  const user = await getSessionUser(client);
  return { role: resolveRole(user), client };
}
