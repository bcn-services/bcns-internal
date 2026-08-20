/**
 * supabase-browser.ts — the browser-side Supabase client, used only to start
 * sign-in. Every authorization decision still happens server-side.
 *
 * Deliberately does NOT use getConfig(): lib/env.ts reads `process.env[name]`
 * dynamically, and Next only inlines NEXT_PUBLIC_* into the client bundle
 * where it can see the property access statically. The two literals below are
 * what makes this work in the browser — do not refactor them behind a helper.
 *
 * Keyless behavior matches the server factories: returns `null` when
 * unconfigured so the sign-in form can say so instead of throwing.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function getBrowserClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
