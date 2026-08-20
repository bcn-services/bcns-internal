/**
 * auth-gating.test.mjs — exhaustive truth table over the pure access gate.
 *
 * routeAccessDecision() is the single security decision in the app. The
 * middleware only gathers (isAuthenticated, role) and delegates here, so this
 * table IS the app's authorization spec. Every route class x every caller
 * class is enumerated below — no sampling.
 *
 * Runs with plain `node --test`. No Postgres, no network, no Next runtime:
 * the core is pure by design so it can be tested this cheaply.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Run under `tsx --test` (see package.json) so the .ts core imports directly.
import {
  routeAccessDecision,
  resolveRole,
  LOGIN_PATH,
  PUBLIC_PREFIXES,
  ADMIN_PREFIX,
} from "../lib/auth.ts";

/** Caller classes. `null` role = authenticated but not provisioned. */
const ANON   = { isAuthenticated: false, role: null };
const NOROLE = { isAuthenticated: true,  role: null };
const MEMBER = { isAuthenticated: true,  role: "member" };
const ADMIN  = { isAuthenticated: true,  role: "admin" };

const decide = (pathname, caller) => routeAccessDecision({ pathname, ...caller }).action;

/**
 * The full table. Columns are the four caller classes.
 * Rows cover: public paths, their sub-paths, near-miss lookalikes, the app
 * root, staff pages, admin pages, API routes, and the admin near-miss.
 */
const TABLE = [
  // path                        anon        norole    member    admin
  ["/login",                     "allow",    "allow",  "allow",  "allow"],
  ["/login/reset",               "allow",    "allow",  "allow",  "allow"],
  ["/auth/callback",             "allow",    "allow",  "allow",  "allow"],
  ["/api/health",                "allow",    "allow",  "allow",  "allow"],
  ["/",                          "redirect", "forbid", "allow",  "allow"],
  ["/clients",                   "redirect", "forbid", "allow",  "allow"],
  ["/clients/coventry",          "redirect", "forbid", "allow",  "allow"],
  ["/leads",                     "redirect", "forbid", "allow",  "allow"],
  ["/api/accounts",              "redirect", "forbid", "allow",  "allow"],
  ["/admin",                     "redirect", "forbid", "forbid", "allow"],
  ["/admin/users",               "redirect", "forbid", "forbid", "allow"],
  ["/api/admin/rotate",          "redirect", "forbid", "allow",  "allow"], // not under /admin — see note below
];

for (const [path, anon, norole, member, admin] of TABLE) {
  test(`gate: ${path}`, () => {
    assert.equal(decide(path, ANON),   anon,   `anon @ ${path}`);
    assert.equal(decide(path, NOROLE), norole, `no-role @ ${path}`);
    assert.equal(decide(path, MEMBER), member, `member @ ${path}`);
    assert.equal(decide(path, ADMIN),  admin,  `admin @ ${path}`);
  });
}

test("admin-only protection is a path prefix, not a substring", () => {
  // /administration must NOT inherit /admin's rule by accident, and
  // /api/admin/* is NOT admin-gated by this layer — RLS is the backstop there.
  assert.equal(decide("/administration", MEMBER), "allow");
  assert.equal(decide("/api/admin/rotate", MEMBER), "allow");
  // Documented so a future admin API route is gated deliberately, not silently.
  assert.equal(ADMIN_PREFIX, "/admin");
});

test("public prefixes match on segment boundaries, not substrings", () => {
  // /loginhack must not ride in on /login's allow-listing.
  assert.equal(decide("/loginhack", ANON), "redirect");
  assert.equal(decide("/api/healthz", ANON), "redirect");
  assert.equal(decide("/authorize", ANON), "redirect");
});

test("unknown paths are private by default", () => {
  for (const p of ["/anything", "/a/b/c/d", "/api/whatever", "/未知"]) {
    assert.equal(decide(p, ANON), "redirect", p);
    assert.equal(decide(p, NOROLE), "forbid", p);
  }
});

test("redirect target is the login path", () => {
  assert.equal(routeAccessDecision({ pathname: "/clients", isAuthenticated: false, role: null }).to,
    LOGIN_PATH);
});

test("PUBLIC_PREFIXES is the complete public surface", () => {
  // Fails loudly if someone widens the public allow-list without review.
  assert.deepEqual([...PUBLIC_PREFIXES], ["/login", "/auth", "/api/health"]);
});

test("resolveRole trusts app_metadata only", () => {
  assert.equal(resolveRole({ app_metadata: { role: "admin" } }), "admin");
  assert.equal(resolveRole({ app_metadata: { role: "member" } }), "member");
  // The privilege-escalation case: user_metadata is user-writable. Ignore it.
  assert.equal(resolveRole({ user_metadata: { role: "admin" }, app_metadata: {} }), null);
  assert.equal(resolveRole({ app_metadata: { role: "owner" } }), null);
  assert.equal(resolveRole({ app_metadata: { role: "ADMIN" } }), null);
  assert.equal(resolveRole({ app_metadata: {} }), null);
  assert.equal(resolveRole({}), null);
  assert.equal(resolveRole(null), null);
  assert.equal(resolveRole(undefined), null);
});

test("non-string role claims never resolve", () => {
  for (const raw of [true, 1, {}, [], ["admin"], { role: "admin" }, null]) {
    assert.equal(resolveRole({ app_metadata: { role: raw } }), null, JSON.stringify(raw));
  }
});
