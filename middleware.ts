/**
 * middleware.ts — the gate. Everything is private except an explicit allow-list.
 *
 * Platform rule (security foundation): this is a THIN ADAPTER. It gathers
 * (isAuthenticated, role) from the cookie-bound SSR client and delegates the
 * decision to the pure routeAccessDecision() in lib/auth.ts, which is unit-
 * tested exhaustively. No security logic lives in this file.
 *
 * Keyless behavior: NOTHING is read from env at module top level. When Supabase
 * env is absent getSsrClient() returns null → no session → every gated path
 * redirects to login. The middleware never throws on missing env.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { routeAccessDecision, resolveRole, LOGIN_PATH } from "@/lib/auth";
import { getSsrClient, getSessionUser } from "@/lib/supabase-ssr";

/**
 * Run on everything EXCEPT Next's own static output and the favicon.
 *
 * This is deliberately the inverse of a client app's matcher. Listing the
 * PROTECTED trees means a new page ships ungated when someone forgets to add
 * it; listing the EXCLUDED assets means a new page ships gated. For an app
 * holding every lead and client record, the safe default is the second one.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Base response that carries forward any cookies the client wants to refresh.
  const response = NextResponse.next({ request });

  // Cookie bridge: read from the request, write refreshed tokens onto response.
  const client = getSsrClient(
    {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
    { createServerClient },
  );

  const user = await getSessionUser(client);
  const decision = routeAccessDecision({
    pathname: request.nextUrl.pathname,
    isAuthenticated: user !== null,
    role: resolveRole(user),
  });

  if (decision.action === "redirect") {
    const url = request.nextUrl.clone();
    url.pathname = decision.to ?? LOGIN_PATH;
    // Preserve where they were headed so login can bounce them back.
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  if (decision.action === "forbid") {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return response;
}
