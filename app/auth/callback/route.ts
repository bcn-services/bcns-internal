/**
 * /auth/callback — turns the magic-link code into a session cookie.
 *
 * Public via PUBLIC_PREFIXES ("/auth"), which it must be: the visitor is still
 * anonymous when they land here, so gating it would redirect the sign-in link
 * back to /login forever.
 *
 * Cookies are written onto the redirect response, so the Set-Cookie headers
 * ride along with the 302 to `next`.
 *
 * Two link shapes arrive here, and they are not interchangeable:
 *
 *  - `?code=` — the browser started the flow at /login, so it holds the PKCE
 *    verifier and exchangeCodeForSession can complete. This is the normal path.
 *  - `?token_hash=&type=` — the link was minted out of band, by
 *    `auth.admin.generateLink` in scripts/provision-user.mjs. No verifier exists
 *    because no browser began the flow, so PKCE cannot apply and verifyOtp is
 *    the documented server-side equivalent. This is what makes first sign-in
 *    possible before any SMTP is configured.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSsrClient } from "@/lib/supabase-ssr";
import { safeNext, LOGIN_PATH } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The token type must match the one the link was minted with, so it comes off
 * the URL — but it decides which token store Supabase checks, so it is matched
 * against a fixed set rather than passed through. "email" is the fallback
 * because that is what a link minted by /login carries.
 */
const OTP_TYPES = ["magiclink", "email", "invite", "recovery", "signup"] as const;
type OtpType = (typeof OTP_TYPES)[number];

function otpType(raw: string | null): OtpType {
  return OTP_TYPES.includes(raw as OtpType) ? (raw as OtpType) : "email";
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const next = safeNext(url.searchParams.get("next"));

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`${LOGIN_PATH}?error=${reason}`, url.origin));

  if (!code && !tokenHash) return fail("missing_code");

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

  // An out-of-band link carries no PKCE verifier, so it must be verified rather
  // than exchanged. Trying exchangeCodeForSession on it always fails.
  const { error } = tokenHash
    ? await client.auth.verifyOtp({ type: otpType(url.searchParams.get("type")), token_hash: tokenHash })
    : await client.auth.exchangeCodeForSession(code!);
  if (error) return fail("exchange_failed");
  return response;
}
