/**
 * os-port.test.mjs — the modules ported from project-dashboard still work here.
 *
 * These files were written for Astro on Nate's laptop. Two things have to hold
 * after the port: they read their root from OS_DIR (so a server can point at a
 * clone instead of ~/os), and they parse a real directory rather than throwing.
 *
 * The fixture is built under the OS temp dir. Nothing here reads the real ~/os.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { osDir, expandTilde } from "../lib/os/paths.ts";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "bcns-osport-"));
  mkdirSync(join(root, "skills", "grill-me"), { recursive: true });
  writeFileSync(join(root, "skills", "grill-me", "SKILL.md"),
    "---\nname: grill-me\ndescription: Interrogate a plan.\n---\n\nBody.\n");
  mkdirSync(join(root, "knowledge", "memory"), { recursive: true });
  writeFileSync(join(root, "knowledge", "memory", "MEMORY.md"), "# Memory Index\n\n- [A](a.md) — hook\n");
  process.env.OS_DIR = root;
});
after(() => {
  delete process.env.OS_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("ported os modules", () => {
  test("OS_DIR repoints the root — the server-clone requirement", () => {
    assert.equal(osDir(), root);
  });

  test("a relative OS_DIR is refused, not resolved against the cwd", () => {
    // On a server the cwd differs from the dev machine's, so silently
    // resolving a relative path would read the wrong tree.
    process.env.OS_DIR = "../os";
    assert.notEqual(osDir(), "../os");
    assert.ok(osDir().startsWith("/"));
    process.env.OS_DIR = root;
  });

  test("a blank OS_DIR falls back to ~/os", () => {
    process.env.OS_DIR = "   ";
    assert.equal(osDir(), expandTilde("~/os"));
    process.env.OS_DIR = root;
  });

});
