/**
 * supabase-admin.ts — the ONE place a service-role Supabase client is built.
 *
 * The service-role key bypasses RLS entirely. Every guarantee written into
 * supabase/migrations/0002_rls_policies.sql and 0007_own_tasks_only.sql stops
 * applying to a client built here, so a caller that reaches for this is taking
 * responsibility for the authorization check itself.
 *
 * `server-only` is imported for that reason: it makes bundling this into a
 * client component a build error rather than a leaked key.
 *
 * Use it only where RLS cannot express the rule. Today that is exactly one
 * table — `agent_tokens`, which has RLS on and no policies precisely so that
 * nothing but this client can touch it. Reaching for it anywhere else usually
 * means a policy is missing.
 */

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "./env";
import { markServiceClient } from "./service-client-mark";

/**
 * A service-role client, or null when Supabase is unconfigured — the same
 * keyless-degradation contract every other factory in this app follows.
 *
 * No session is persisted and no token is auto-refreshed: this client
 * represents the server, not a person, and a refresh loop in a request handler
 * would be a leak.
 */
export function getServiceClient(): SupabaseClient | null {
  const { supabaseUrl, supabaseServiceRoleKey } = getConfig();
  if (!supabaseUrl || !supabaseServiceRoleKey) return null;
  // Stamped so the RLS-bound data-layer functions can REFUSE it — see
  // lib/service-client-mark.ts and countUnread in lib/inbox.ts.
  return markServiceClient(
    createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}
