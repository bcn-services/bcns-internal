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
import { cache } from "react";
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
/*
 * Wrapped in React cache() because a signed-in render calls this twice — once
 * in the root layout for the sidebar, once in the page for its own gating —
 * and getSessionUser() uses getUser(), which is a network round trip to the
 * Supabase Auth server every time rather than a local cookie read. cache()
 * dedupes per request render, so those two calls become one.
 *
 * The middleware's own check is a separate runtime and is NOT deduped by
 * this. That is correct: it is the gate, and the gate must not be skipped.
 */
export const getViewer = cache(async function getViewer(): Promise<{
  role: Role | null;
  /** The auth user id — also this person's profiles.id. Null when signed out. */
  userId: string | null;
  email: string | null;
  client: SupabaseClient | null;
}> {
  const client = await getServerClient();
  const user = await getSessionUser(client);
  // email comes from the verified session, never from a form field. RLS
  // compares the same claim, so an author recorded here matches what the
  // database will later accept as that person's own row.
  return { role: resolveRole(user), userId: user?.id ?? null, email: user?.email ?? null, client };
});
