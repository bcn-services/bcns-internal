/**
 * agent-verbs-io.test.mjs — the three verbs that leave the process.
 *
 * NOTHING HERE TOUCHES THE PUBLIC INTERNET OR THE REAL ~/os.
 *  * read_site      → a node:http server on 127.0.0.1 serving a file from disk,
 *                     and a CLOSED port on 127.0.0.1 for the unreachable case
 *                     (deterministic, and no DNS to be slow or absent).
 *  * os_publish     → a throwaway git repo under $TMPDIR with a local bare
 *                     remote. `ctx.osDir` is passed explicitly, so neither the
 *                     OS_DIR env var nor any default can point this at ~/os.
 *  * search_places  → a stub python script that prints canned JSON. The real
 *                     ~/os/skills/leads/places.py spends money and is never run.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read_site, os_publish, search_places } from "../lib/agent/verbs/index.ts";
import { isPrivateHost, htmlToText } from "../lib/agent/verbs/read_site.ts";

const ADMIN = { profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "nate@bcn-services.com", role: "admin" };
const MEMBER = { profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "brandon@bcn-services.com", role: "member" };

/* --------------------------------------------------------------- read_site -- */

describe("read_site", () => {
  let server;
  let base;
  let dir;
  let bigBody;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "bcns-read-site-"));
    // The fixture is a real file on disk, served by the fixture server.
    writeFileSync(
      join(dir, "page.html"),
      `<!doctype html><html><head><title>Coventry Contracting</title>
       <style>.x{color:red}</style><script>var secret="do-not-surface";</script></head>
       <body><h1>Roofing &amp; Siding</h1><p>Serving Rye since 1998.</p>
       <a href="/deeper">follow me</a></body></html>`,
    );
    bigBody = "y".repeat(2 * 1024 * 1024);

    server = createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(dir, "page.html")));
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(bigBody);
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/page" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/offsite") {
        res.writeHead(302, { location: "file:///etc/passwd" });
        res.end();
      } else if (req.url === "/hang") {
        // Headers never sent: the socket stays open until the client gives up.
      } else if (req.url === "/gone") {
        res.writeHead(404);
        res.end("nope");
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("plain body");
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.closeAllConnections?.();
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ caller: MEMBER, allowPrivateHosts: true });

  test("returns readable text for a local fixture served from disk", async () => {
    const r = await read_site.run(ctx(), { url: `${base}/page` });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.status, 200);
    assert.equal(r.data.title, "Coventry Contracting");
    assert.match(r.data.text, /Roofing & Siding/);
    assert.match(r.data.text, /Serving Rye since 1998/);
    assert.equal(r.data.truncated, false);
  });

  test("script and style contents never reach the caller", async () => {
    const r = await read_site.run(ctx(), { url: `${base}/page` });
    assert.ok(!r.data.text.includes("do-not-surface"), "script body leaked into the text");
    assert.ok(!r.data.text.includes("color:red"), "stylesheet leaked into the text");
    assert.ok(!r.data.text.includes("<"), "raw markup leaked into the text");
  });

  test("an unreachable host is a typed error, not a hang", async () => {
    // A closed port on loopback: refused immediately, no DNS involved.
    const closed = await new Promise((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    const started = Date.now();
    const r = await read_site.run(ctx(), { url: `http://127.0.0.1:${closed}/page`, timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "network_error", JSON.stringify(r.error));
    assert.match(r.error.message, /cannot reach/);
    assert.ok(Date.now() - started < 5000, "the verb waited out its whole timeout instead of failing");
  });

  test("a server that never answers times out rather than hanging", async () => {
    const started = Date.now();
    const r = await read_site.run(ctx(), { url: `${base}/hang`, timeoutMs: 250 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "timeout", JSON.stringify(r.error));
    assert.ok(Date.now() - started < 5000);
  });

  test("an oversized response is capped and reported as truncated", async () => {
    const r = await read_site.run(ctx(), { url: `${base}/big` });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.truncated, true);
    assert.ok(r.data.text.length < bigBody.length, "the whole 2MB body came back");
    assert.ok(r.data.text.length <= 512 * 1024);
  });

  test("a loopback host is REFUSED by default — the opt-in is what makes the tests above work", async () => {
    const r = await read_site.run({ caller: MEMBER }, { url: `${base}/page` });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
    assert.match(r.error.message, /private or loopback/);
  });

  test("non-http schemes are refused", async () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<b>x", "ftp://example.com/x", "not a url"]) {
      const r = await read_site.run(ctx(), { url });
      assert.equal(r.ok, false, `${url} was accepted`);
      assert.equal(r.error.code, "invalid_input");
    }
  });

  test("an HTTP redirect is followed, but re-checked against the same policy", async () => {
    const good = await read_site.run(ctx(), { url: `${base}/redirect` });
    assert.equal(good.ok, true, JSON.stringify(good.error));
    assert.equal(good.data.title, "Coventry Contracting");
    assert.equal(good.data.finalUrl, `${base}/page`);
    assert.equal(good.data.url, `${base}/redirect`, "the originally requested URL was lost");

    // A redirect must not be able to walk the fetch out of the scheme rule.
    const bad = await read_site.run(ctx(), { url: `${base}/offsite` });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "forbidden");
    assert.match(bad.error.message, /redirect refused/);
  });

  test("a redirect loop is bounded", async () => {
    const r = await read_site.run(ctx(), { url: `${base}/loop`, timeoutMs: 4000 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "network_error");
    assert.match(r.error.message, /too many redirects/);
  });

  test("an HTTP error status is reported, not returned as page text", async () => {
    const r = await read_site.run(ctx(), { url: `${base}/gone` });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "network_error");
    assert.match(r.error.message, /HTTP 404/);
  });

  test("it does NOT chase a link found in the page it just fetched", async () => {
    const r = await read_site.run(ctx(), { url: `${base}/page` });
    assert.equal(r.data.finalUrl, `${base}/page`, "the verb navigated somewhere the page pointed at");
    assert.match(r.data.text, /follow me/, "link text should survive as text");
  });

  test("isPrivateHost covers loopback, RFC1918 and the cloud metadata address", () => {
    for (const h of ["localhost", "127.0.0.1", "127.9.9.9", "10.0.0.5", "192.168.1.1",
                     "172.16.0.1", "172.31.255.255", "169.254.169.254", "::1", "0.0.0.0"]) {
      assert.equal(isPrivateHost(h), true, `${h} should be private`);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "11.0.0.1"]) {
      assert.equal(isPrivateHost(h), false, `${h} should be public`);
    }
  });

  test("htmlToText decodes entities and keeps paragraph breaks", () => {
    const { title, text } = htmlToText("<title>T &amp; Co</title><p>one</p><p>two &#65;</p>");
    assert.equal(title, "T & Co");
    assert.equal(text, "one\ntwo A");
  });
});

/* -------------------------------------------------------------- os_publish -- */

describe("os_publish", () => {
  let root;
  const git = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

  const makeRepo = () => {
    const work = mkdtempSync(join(root, "repo-"));
    const remote = mkdtempSync(join(root, "remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main", work], { stdio: "ignore" });
    git(work, "config", "user.email", "t@example.com");
    git(work, "config", "user.name", "T");
    writeFileSync(join(work, "README.md"), "start\n");
    git(work, "add", "-A");
    git(work, "commit", "-m", "initial");
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "-u", "origin", "main");
    return { work, remote };
  };

  before(() => { root = mkdtempSync(join(tmpdir(), "bcns-os-publish-")); });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("commits and pushes, and reports which files went out", async () => {
    const { work, remote } = makeRepo();
    mkdirSync(join(work, "knowledge"), { recursive: true });
    writeFileSync(join(work, "knowledge", "note.md"), "remembered\n");

    const r = await os_publish.run({ caller: ADMIN, osDir: work }, { message: "add a note" });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.committed, true);
    assert.equal(r.data.pushed, true);
    assert.deepEqual(r.data.files, ["knowledge/note.md"]);
    // The remote really has it — asserted on the remote, not on the working copy.
    assert.match(git(remote, "log", "-1", "--pretty=%s"), /add a note/);
    assert.match(git(remote, "ls-tree", "-r", "--name-only", "HEAD"), /knowledge\/note\.md/);
  });

  test("a clean tree is committed:false, not an error and not an empty commit", async () => {
    const { work, remote } = makeRepo();
    const before = git(remote, "rev-list", "--count", "HEAD");
    const r = await os_publish.run({ caller: ADMIN, osDir: work }, { message: "nothing to do" });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.committed, false);
    assert.equal(r.data.pushed, false);
    assert.deepEqual(r.data.files, []);
    assert.equal(git(remote, "rev-list", "--count", "HEAD"), before);
  });

  test("pull-rebases onto a diverged remote and leaves NO merge commit", async () => {
    const { work, remote } = makeRepo();
    // Someone else pushed while this run was working.
    const other = mkdtempSync(join(root, "other-"));
    execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
    git(other, "config", "user.email", "o@example.com");
    git(other, "config", "user.name", "O");
    writeFileSync(join(other, "THEIRS.md"), "theirs\n");
    git(other, "add", "-A");
    git(other, "commit", "-m", "their work");
    git(other, "push");

    writeFileSync(join(work, "MINE.md"), "mine\n");
    const r = await os_publish.run({ caller: ADMIN, osDir: work }, { message: "my work" });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.pushed, true);
    assert.equal(git(remote, "log", "--merges", "--oneline"), "", "a merge commit was created");
    const files = git(remote, "ls-tree", "-r", "--name-only", "HEAD");
    assert.match(files, /MINE\.md/);
    assert.match(files, /THEIRS\.md/, "the other machine's commit was clobbered");
  });

  test("push:false commits locally and touches no remote", async () => {
    const { work, remote } = makeRepo();
    const before = git(remote, "rev-list", "--count", "HEAD");
    writeFileSync(join(work, "local-only.md"), "x\n");
    const r = await os_publish.run({ caller: ADMIN, osDir: work }, { message: "local", push: false });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.committed, true);
    assert.equal(r.data.pushed, false);
    assert.equal(git(remote, "rev-list", "--count", "HEAD"), before);
  });

  test("no directory configured is not_configured — it never guesses ~/os", async () => {
    const prev = process.env.OS_DIR;
    delete process.env.OS_DIR;
    try {
      const r = await os_publish.run({ caller: ADMIN }, { message: "m" });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "not_configured");
    } finally {
      if (prev !== undefined) process.env.OS_DIR = prev;
    }
  });

  test("a directory that is not a git work tree is not_configured", async () => {
    const plain = mkdtempSync(join(root, "plain-"));
    const r = await os_publish.run({ caller: ADMIN, osDir: plain }, { message: "m" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_configured");
  });

  test("an empty commit message is refused", async () => {
    const { work } = makeRepo();
    const r = await os_publish.run({ caller: ADMIN, osDir: work }, { message: "   " });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
  });

  test("a member cannot publish", async () => {
    const { work } = makeRepo();
    const r = await os_publish.run({ caller: MEMBER, osDir: work }, { message: "m" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "forbidden");
  });

  test("the source contains no force-push of any spelling", () => {
    const src = readFileSync(new URL("../lib/agent/verbs/os_publish.ts", import.meta.url), "utf8");
    // Comments say "force-push" in prose; only argv literals matter.
    const argv = src.match(/"[^"]*"/g) ?? [];
    for (const bad of ["--force", "--force-with-lease", "-f", "+HEAD", "--mirror"]) {
      assert.ok(!argv.includes(`"${bad}"`), `os_publish passes ${bad} to git`);
    }
  });
});

/* ------------------------------------------------------------ search_places -- */

describe("search_places", () => {
  let dir;
  let stub;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bcns-places-"));
    stub = join(dir, "places_stub.py");
    // Stands in for ~/os/skills/leads/places.py: same contract — JSON on
    // stdout, commentary on stderr, non-zero exit when it refuses to spend.
    writeFileSync(
      stub,
      [
        "import json, sys",
        "if '--boom' in sys.argv:",
        "    sys.exit('monthly Places cap reached: 950/950. Resets on the 1st.')",
        "args = sys.argv[1:]",
        "query = args[1]",
        "count = int(args[args.index('--count') + 1])",
        "rows = [{'place_id': 'p%d' % i, 'business_name': 'Biz %d' % i, 'type': 'plumber',",
        "         'city': 'Rye', 'phone': '', 'website': '', 'has_website': 'no',",
        "         'rating': '', 'review_count': '', 'source_query': query,",
        "         'date_added': '2026-08-24'} for i in range(count)]",
        "json.dump(rows, sys.stdout)",
        "print('# commentary on stderr', file=sys.stderr)",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const ctx = (extra = {}) => ({
    caller: ADMIN,
    places: { python: "python3", script: stub, ...extra },
  });

  test("wraps the script and parses its rows", async () => {
    const r = await search_places.run(ctx(), { query: "plumbers in Rye RI", count: 3 });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.length, 3);
    // Matched by content, not by position.
    assert.ok(r.data.every((row) => row.source_query === "plumbers in Rye RI"));
    assert.ok(r.data.some((row) => row.place_id === "p2"));
  });

  test("count is capped so a model cannot ask for a thousand", async () => {
    const r = await search_places.run(ctx(), { query: "x", count: 5000 });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.length, 60);
  });

  test("the script refusing to spend is passed through, not swallowed", async () => {
    const r = await search_places.run(
      { caller: ADMIN, places: { python: "python3", script: stub } },
      { query: "--boom" },
    );
    assert.equal(r.ok, false);
    assert.match(r.error.message, /monthly Places cap reached/);
  });

  test("a missing interpreter is not_configured", async () => {
    const r = await search_places.run(
      { caller: ADMIN, places: { python: join(dir, "no-such-python"), script: stub } },
      { query: "x" },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_configured");
  });

  test("an empty query never spawns anything", async () => {
    const r = await search_places.run(ctx(), { query: "   " });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
  });

  test("a member cannot spend the Places budget", async () => {
    const r = await search_places.run(
      { caller: MEMBER, places: { python: "python3", script: stub } },
      { query: "plumbers" },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "forbidden");
  });

  test("the real places.py is never reimplemented here", () => {
    const src = readFileSync(new URL("../lib/agent/verbs/search_places.ts", import.meta.url), "utf8");
    assert.ok(!src.includes("places.googleapis.com"), "the Places API was called directly");
    assert.ok(!src.includes("monitoring.googleapis.com"), "the budget guard was reimplemented");
    assert.match(src, /places\.py/);
  });
});
