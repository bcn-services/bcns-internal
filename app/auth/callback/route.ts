/**
 * /auth/callback — turns the magic-link code into a session cookie.
 *
 * Public via PUBLIC_PREFIXES ("/auth"), which it must be: the visitor is still
 * anonymous when they land here, so gating it would redirect the sign-in link
 * back to /login forever.
 *
 * Cookies are written onto the redirect response, so the Set-Cookie headers
 * ride along with the 302 to `next`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSsrClient } from "@/lib/supabase-ssr";
import { safeNext, LOGIN_PATH } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`${LOGIN_PATH}?error=${reason}`, url.origin));

  if (!code) return fail("missing_code");

  const response = NextResponse.redirect(new URL(next, url.origin));
  const client = getSsrClient({
    getAll: () => request.cookies.getAll(),
    setAll: (cookies) => {
      for (const { name, value, options } of cookies) {
        response.cookies.set(name, value, options);
      }
    },
  });
  if (!client) return fail("unconfigured");

  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) return fail("exchange_failed");
  return response;
}
