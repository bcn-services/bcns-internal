/**
 * supabase-ssr.ts — Cookie-bound Supabase client for SSR session management.
 *
 * Adapted from bcns-client-coventry/lib/supabase-ssr.ts. Reads env only via
 * getConfig() inside functions — never at import — so the app stays buildable
 * and importable with no keys set.
 *
 * Keyless behavior: when Supabase env is absent the factory returns `null`
 * (unconfigured), so callers degrade to "no session" and the gate fails safe
 * rather than throwing a 500 on every request.
 */

import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig, type AppConfig } from "./env";
import { timeoutFetch } from "./fetch-timeout";

/** Test seam: swap the underlying SSR factory and/or config. */
export interface SsrClientDeps {
  createServerClient?: typeof createServerClient;
  config?: AppConfig;
}

/**
 * Build a cookie-bound anon client, or `null` if Supabase is unconfigured.
 *
 * The caller supplies the cookie adapter (Next request cookies in a server
 * component, or the request/response bridge in middleware) so this factory
 * stays runtime-agnostic and unit-testable.
 */
export function getSsrClient(
  cookies: CookieMethodsServer,
  deps: SsrClientDeps = {},
): SupabaseClient | null {
  const config = deps.config ?? getConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey) return null;
  const create = deps.createServerClient ?? createServerClient;
  return create(config.supabaseUrl, config.supabaseAnonKey, {
    cookies,
    global: { fetch: timeoutFetch },
  });
}

/**
 * Read the authenticated user from a cookie-bound client, or `null`.
 *
 * Uses getUser(), which validates the token against the Supabase Auth server
 * rather than trusting the cookie's contents — the correct call for an
 * authorization decision. getSession() would be cheaper and would trust
 * attacker-supplied cookie data; do not swap it in.
 *
 * Never throws: network or parse failures degrade to "no user", which the gate
 * treats as unauthenticated (deny-by-default).
 */
/**
 * The narrow slice of the Supabase user this app reads. Deliberately not
 * `User` from supabase-js: widening it invites reading user_metadata, which is
 * user-writable and must never decide anything. `email` is a verified claim and
 * is safe to record as an author.
 */
export type SessionUser = {
  /**
   * The auth user id. Same value as profiles.id (0004 declares the profile's
   * primary key as a reference to auth.users), which is why `assigned_to =
   * auth.uid()` in the RLS policies needs no join — and why a server action can
   * key a row on this id without looking a profile up first.
   */
  id?: string;
  app_metadata?: { role?: unknown } & Record<string, unknown>;
  email?: string | null;
};

export async function getSessionUser(
  client: SupabaseClient | null,
): Promise<SessionUser | null> {
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getUser();
    if (error) {
      // Fail safe (null → deny) but surface the outage: a real auth-server
      // error must be distinguishable from a legitimately signed-out user,
      // which is silent. Log the message only — never tokens or secrets.
      console.error("[auth] getUser failed:", error.message);
      return null;
    }
    return data.user ?? null;
  } catch (e) {
    console.error("[auth] getUser threw:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
