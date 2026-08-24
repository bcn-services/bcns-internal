/**
 * os-note-route.test.mjs — GET /api/os/note, the read behind the brain graph's
 * node popup.
 *
 * The route is a thin adapter over `resolveNotePath` and `readNote`, both
 * already tested, so what is checked here is the adapter's own contract: the
 * status it picks per rejection, that it renders a real file, and that it reads
 * its root from OS_DIR at call time rather than at module load.
 *
 * The guard cases are not ceremony. This endpoint is reachable by any signed-in
 * employee and its whole input is a path, so a traversal or a hidden-segment
 * escape here would serve the operator's private os over HTTP. A past bug in
 * this codebase served ~1000 hidden .md files, which is why the hidden case has
 * a test of its own rather than riding on the traversal one.
 *
 * The fixture is built under the OS temp dir. Nothing here reads the real ~/os.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET } from "../app/api/os/note/route.ts";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "bcns-osnote-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "knowledge", "a.md"), "# A\n\nA **body**.\n");
  writeFileSync(join(root, "knowledge", "notes.txt"), "not markdown\n");
  mkdirSync(join(root, ".secret"), { recursive: true });
  writeFileSync(join(root, ".secret", "private.md"), "# Private\n");
  process.env.OS_DIR = root;
});
after(() => {
  delete process.env.OS_DIR;
  rmSync(root, { recursive: true, force: true });
});

const get = (qs) => GET(new Request(`http://localhost/api/os/note${qs}`));

describe("GET /api/os/note", () => {
  test("renders a markdown file under OS_DIR", async () => {
    const res = await get("?file=knowledge%2Fa.md");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.relPath, "knowledge/a.md");
    assert.match(body.html, /<strong>body<\/strong>/);
  });

  test("no ?file= is a 400, not a read of the root", async () => {
    const res = await get("");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });

  test("a path climbing out of the root is refused", async () => {
    const res = await get("?file=..%2F..%2Fetc%2Fpasswd.md");
    assert.equal((await res.json()).ok, false);
    assert.notEqual(res.status, 200);
  });

  test("an absolute path is refused", async () => {
    const res = await get("?file=%2Fetc%2Fpasswd.md");
    assert.equal(res.status, 400);
  });

  test("a hidden segment is refused even though the file exists", async () => {
    const res = await get("?file=.secret%2Fprivate.md");
    assert.notEqual(res.status, 200);
    assert.equal((await res.json()).ok, false);
  });

  test("a non-markdown file is refused", async () => {
    const res = await get("?file=knowledge%2Fnotes.txt");
    assert.equal(res.status, 400);
  });

  test("OS_DIR is read per call, so repointing the root needs no restart", async () => {
    const before = await (await get("?file=knowledge%2Fa.md")).json();
    assert.equal(before.ok, true);
    process.env.OS_DIR = join(root, "does-not-exist");
    try {
      const res = await get("?file=knowledge%2Fa.md");
      assert.notEqual(res.status, 200);
    } finally {
      process.env.OS_DIR = root;
    }
  });
});
