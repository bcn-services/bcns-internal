/**
 * os-routes.test.mjs — the project-readme route handler.
 *
 * The handler is a pure adapter over already-tested libs, so what is checked
 * here is the adapter's own contract: the status it picks, and that it reads its
 * root from OS_DIR at call time rather than at module load.
 *
 * The fixture is built under the OS temp dir. Nothing here reads the real ~/os.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET as readmeGet } from "../app/api/project-readme/route.ts";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "bcns-osroutes-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "knowledge", "a.md"), "# A\n\nLinks to [[b]].\n");
  writeFileSync(join(root, "knowledge", "b.md"), "# B\n");
  mkdirSync(join(root, "projects", "demo"), { recursive: true });
  writeFileSync(
    join(root, "projects", "demo", "README.md"),
    "---\nname: Demo\nstatus: active\n---\n\nDemo **body**.\n",
  );
  process.env.OS_DIR = root;
  delete process.env.OS_PROJECTS_DIR;
});
after(() => {
  delete process.env.OS_DIR;
  rmSync(root, { recursive: true, force: true });
});

const readme = (qs) => readmeGet(new Request(`http://localhost/api/project-readme${qs}`));

describe("GET /api/project-readme", () => {
  test("renders a project README to sanitized html", async () => {
    const res = await readme("?slug=demo");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.html, /<strong>body<\/strong>/);
    // parseFrontmatter strips the block; it must not leak into the rendered html.
    assert.doesNotMatch(body.html, /status: active/);
  });

  test("a missing slug is a 400, not an empty render", async () => {
    const res = await readme("");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Missing slug parameter.");
  });

  test("an empty slug is refused rather than resolving to the projects root", async () => {
    const res = await readme("?slug=");
    assert.equal(res.status, 400);
  });

  test("a traversal slug never escapes the projects root", async () => {
    const res = await readme("?slug=" + encodeURIComponent("../knowledge"));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });

  test("an unknown project is a 404, not a 500", async () => {
    const res = await readme("?slug=nope");
    assert.equal(res.status, 404);
  });

  test("OS_PROJECTS_DIR overrides the root, matching getProjects()", async () => {
    process.env.OS_PROJECTS_DIR = join(root, "knowledge");
    try {
      // `knowledge/` has no `demo/README.md`, so the same slug must now miss.
      assert.equal((await readme("?slug=demo")).status, 404);
    } finally {
      delete process.env.OS_PROJECTS_DIR;
    }
  });
});
