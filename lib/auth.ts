/**
 * auth.ts — Pure, dependency-free authorization core for route gating.
 *
 * Platform rule (copied from bcns-client-coventry/lib/auth.ts): the access
 * decision is the single security-critical surface of the app, so it lives in a
 * PURE function with NO Supabase/Next/edge dependency. The middleware is a thin
 * adapter that gathers (isAuthenticated, role) and calls routeAccessDecision().
 * The truth table is therefore fully unit-testable with no server and no
 * Supabase project.
 *
 * How this app differs from a client app: bcns-internal is entirely private.
 * A client app gates two subtrees and leaves the marketing pages public; here
 * the DEFAULT IS DENY and only an explicit allow-list is public. Adding a new
 * page therefore gates it automatically — the failure mode of forgetting to
 * list a route is "staff cannot reach it", not "the world can read our leads".
 *
 * Keyless behavior: importing this module reads no env and constructs nothing.
 */

/** The two roles the app recognizes. Stored server-side in app_metadata.role. */
export type Role = "admin" | "member";

/** Where a user must go to sign in. Every gated path redirects here. */
export const LOGIN_PATH = "/login";

/**
 * The ONLY paths reachable without a session. Everything else is gated.
 *
 *  /login   — the sign-in page itself; gating it would be a lockout loop.
 *  /auth    — Supabase's callback tree (email invite + magic link land here);
 *             the caller is by definition not yet signed in when it runs.
 *  /api/health — the deploy pipeline curls this after every release to decide
 *             whether to roll back. It must answer before anyone signs in, and
 *             it deliberately exposes no business data.
 */
export const PUBLIC_PREFIXES = ["/login", "/auth", "/api/health"] as const;

/** Subtree only an admin may reach: user management and commercial settings. */
export const ADMIN_PREFIX = "/admin";

/** Outcome of a gating decision. `to` is set only for a redirect. */
export type AccessAction = "allow" | "redirect" | "forbid";
export interface AccessDecision {
  action: AccessAction;
  to?: string;
}

export interface RouteAccessInput {
  /** The request pathname, e.g. "/clients/coventry". */
  pathname: string;
  /** Whether the request carries a valid, authenticated session. */
  isAuthenticated: boolean;
  /** The authenticated user's role, or null if unknown/unprovisioned. */
  role: Role | null;
}

/** True when `pathname` is `prefix` itself or a child segment of it. */
function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * Decide whether a request may proceed. Pure: same inputs → same output, no I/O.
 *
 * Rules (deny-by-default):
 *  - A path under a PUBLIC_PREFIXES entry → allow.
 *  - Otherwise unauthenticated → redirect to login.
 *  - Otherwise a null role → forbid. This is the invited-but-unprovisioned
 *    case: Supabase created the user when the invite was sent, but nobody has
 *    run set-user-role yet. Such a user must see nothing, and 403 (not a login
 *    redirect) is the honest answer — they ARE signed in; they lack a role.
 *  - /admin subtree requires role "admin"; a member → forbid (403).
 *  - Everything else → allow for admin and member alike.
 */
export function routeAccessDecision(input: RouteAccessInput): AccessDecision {
  const { pathname, isAuthenticated, role } = input;

  if (PUBLIC_PREFIXES.some((p) => isUnder(pathname, p))) return { action: "allow" };

  if (!isAuthenticated) return { action: "redirect", to: LOGIN_PATH };

  // Authenticated but unprovisioned. Deny rather than defaulting to member —
  // defaulting a stranger to the lowest role is still granting a role.
  if (role === null) return { action: "forbid" };

  if (isUnder(pathname, ADMIN_PREFIX)) {
    return role === "admin" ? { action: "allow" } : { action: "forbid" };
  }

  return { action: "allow" };
}

/**
 * Resolve a Role from a Supabase auth user's app_metadata.
 *
 * SECURITY: role is read from `app_metadata` ONLY — never `user_metadata`.
 * app_metadata is server-controlled (settable exclusively via the service-role
 * Admin API), whereas user_metadata is editable by the signed-in user through
 * the public client SDK and would be a straight privilege-escalation hole. Any
 * unrecognized or absent value resolves to null, which the gate treats as
 * "not authorized".
 *
 * This mirrors public.role_claim() in supabase/migrations/0002_rls_policies.sql,
 * so the app-layer gate and the database's RLS agree on who the caller is. If
 * one is ever changed, change the other in the same commit.
 *
 * Accepts a minimal structural shape so it stays free of the supabase-js type
 * and remains unit-testable with a plain object.
 */
export function resolveRole(
  user: { app_metadata?: { role?: unknown } & Record<string, unknown> } | null | undefined,
): Role | null {
  const raw = user?.app_metadata?.role;
  return raw === "admin" || raw === "member" ? raw : null;
}

/**
 * Sanitize the post-login destination before redirecting to it.
 *
 * The middleware stashes the intended path in `?next=`, which then round-trips
 * through the browser and the magic-link email — so by the time the callback
 * reads it back, it is attacker-controllable. Redirecting to it unchecked
 * turns /auth/callback into an open redirect. Only a same-origin absolute path
 * survives; "//evil.com" and "/\evil.com" are protocol-relative URLs that most
 * parsers resolve as another origin, despite the leading slash.
 */
export function safeNext(next: string | null | undefined, fallback: string = "/"): string {
  if (!next || !next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
