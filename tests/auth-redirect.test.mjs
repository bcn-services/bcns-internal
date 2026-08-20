/**
 * auth-redirect.test.mjs — safeNext() is the open-redirect guard on the
 * post-login destination.
 *
 * The `next` param travels browser -> magic-link email -> /auth/callback, so
 * it is attacker-controllable by the time it is redirected to. Anything that
 * escapes this origin must fall back to "/".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "../lib/auth.ts";

const ESCAPES = [
  "//evil.com",              // protocol-relative: resolves off-origin
  "//evil.com/path",
  "/\\evil.com",             // backslash variant browsers normalize to //
  "https://evil.com",
  "http://evil.com",
  "javascript:alert(1)",
  "evil.com",                // no leading slash: relative to current dir
  "",
  null,
  undefined,
];

test("off-origin destinations fall back", () => {
  for (const bad of ESCAPES) {
    assert.equal(safeNext(bad), "/", `expected fallback for ${JSON.stringify(bad)}`);
  }
});

test("same-origin paths pass through", () => {
  for (const good of ["/", "/leads", "/clients/acme", "/leads?sort=new", "/a#b"]) {
    assert.equal(safeNext(good), good);
  }
});

test("caller-supplied fallback is honored", () => {
  assert.equal(safeNext("//evil.com", "/login"), "/login");
});
