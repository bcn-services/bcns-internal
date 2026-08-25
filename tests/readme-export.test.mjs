/**
 * readme-export.test.mjs — item 11's four criteria, plus the marker discipline
 * the item calls "the whole item".
 *
 *   "running the generator twice with no data change produces no diff on the
 *    second run"                        → describe("idempotency")
 *   "hand-editing the prose body and re-running leaves that edit
 *    byte-identical"                    → describe("the prose body survives")
 *   "a client with a NULL monthly rate exports without a rate field rather than
 *    a zero or a guess"                 → describe("money never reaches a file")
 *   "the generated frontmatter validates against every key in
 *    ~/os/clients/_TEMPLATE.md"         → describe("the template shape")
 *
 * NOTHING HERE WRITES TO A REAL ~/os. Every test builds a fixture directory
 * under $TMPDIR and passes it in explicitly; `resolveOsDir` has no hard-coded
 * fallback, so a test that forgot would get `not configured`, never a real
 * repo. The real `~/os/clients/_TEMPLATE.md` is READ (never written) by the
 * template test, and that test skips itself where the file is absent — it does
 * not exist on a fresh clone.
 *
 * The commit half runs against a throwaway `git init` repo in $TMPDIR with a
 * local bare remote, the same shape tests/agent-verbs-io.test.mjs uses for
 * os_publish. The real repo path is deliberately never exercised.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { fakeDb } from "./helpers/fake-db.mjs";
import {
  CLIENT_COLUMNS,
  MARKER_BEGIN,
  MARKER_END,
  TEMPLATE_KEYS,
  BOT_AUTHOR,
  commitMessage,
  githubUrl,
  lastActive,
  newReadme,
  readmeExportJob,
  renderBlock,
  resolveOsDir,
  spliceGenerated,
  templateStatus,
} from "../lib/os/readme-export.ts";

/* ------------------------------------------------------------------ fixtures */

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "readme-export-"));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const fresh = (name) => {
  const dir = join(root, name);
  mkdirSync(join(dir, "clients"), { recursive: true });
  return dir;
};

const ACCOUNT = {
  id: "acct-1",
  business_name: "L2 Detailz",
  business_type: "Auto Detailing",
  city: "Coventry",
};

/** A client whose monthly rate is deliberately NULL — one of the real four. */
const NULL_RATE_CLIENT = {
  slug: "l2detailz",
  account_id: "acct-1",
  status: "active",
  monthly_rate_cents: null,
  domain: "l2details.com",
  repo: "bcn-services/bcns-client-l2detailz",
  droplet_host: "146.190.138.141",
  droplet_port: 3000,
  launch_date: "2026-07-01",
  churn_date: null,
  notes: "Hosted web app with an admin dashboard. Booking flows into the calendar.",
  updated_at: "2026-08-15T12:00:00.000Z",
};

/** Same shape, but carrying a real rate, to prove the renderer ignores it. */
const PAID_CLIENT = {
  ...NULL_RATE_CLIENT,
  slug: "coventry",
  account_id: "acct-2",
  monthly_rate_cents: 49900,
  domain: null,
  repo: null,
  droplet_host: null,
};

const ACCOUNT_2 = { id: "acct-2", business_name: "Coventry Ltd", business_type: "Roofing", city: "Coventry" };

/** The admin whose profile os_publish borrows as its caller identity. */
const ADMIN_PROFILE = {
  id: "11111111-2222-4333-8444-555555555555",
  email: "nseluga@g.hmc.edu",
  display_name: "Nate",
  role: "admin",
};

const seeded = (clients, extra = {}) =>
  fakeDb({
    clients,
    accounts: [ACCOUNT, ACCOUNT_2],
    account_activity: [],
    profiles: [ADMIN_PROFILE],
    ...extra,
  });

/** Run the job once against `dir`, with no commit. Returns the JobResult. */
const runExport = (dir, db) => readmeExportJob({ osDir: dir, commit: false }).run({ db, now: new Date("2026-08-25T00:00:00Z") });

const readmeAt = (dir, slug) => readFileSync(join(dir, "clients", slug, "README.md"));

/* ------------------------------------------------------------- idempotency -- */

describe("idempotency", () => {
  test("running twice with no data change produces no diff on the second run", async () => {
    const dir = fresh("idem");
    const db = seeded([{ ...NULL_RATE_CLIENT }, { ...PAID_CLIENT }]);

    const first = await runExport(dir, db);
    assert.equal(first.findings.length, 0, first.log);
    const afterOne = [readmeAt(dir, "l2detailz"), readmeAt(dir, "coventry")];

    const second = await runExport(dir, db);
    const afterTwo = [readmeAt(dir, "l2detailz"), readmeAt(dir, "coventry")];

    assert.deepEqual(afterTwo[0], afterOne[0], "l2detailz changed on the second run");
    assert.deepEqual(afterTwo[1], afterOne[1], "coventry changed on the second run");
    assert.equal(second.facts.changed, 0, "the second run reported a change");
    assert.equal(second.facts.unchanged, 2);
  });

  test("no wall-clock stamp reaches the file — last_active comes off the row", () => {
    const block = renderBlock(NULL_RATE_CLIENT, ACCOUNT);
    assert.match(block, /^last_active: 2026-08-15$/m);
    assert.equal(lastActive(NULL_RATE_CLIENT), "2026-08-15");
    // Today's date must appear nowhere, or two nights running would differ.
    assert.ok(!block.includes(new Date().toISOString().slice(0, 10)) || lastActive(NULL_RATE_CLIENT) === new Date().toISOString().slice(0, 10));
  });
});

/* --------------------------------------------------- the prose body survives */

describe("the prose body survives", () => {
  /** Deliberately awkward: the delimiter as prose, CRLF, trailing spaces,
   *  a code fence, and unicode. None of it is inside the markers. */
  const AWKWARD = [
    "",
    "## Where it stands\t ",
    "",
    "Hand-written. The generator is told never to touch this — not even the",
    "trailing whitespace at the end of this line.   ",
    "",
    "It documents its own delimiters, which must NOT be treated as markers:",
    "",
    MARKER_BEGIN,
    "name: not-real",
    MARKER_END,
    "",
    "```yaml",
    "---",
    "status: also-not-real",
    "---",
    "```",
    "",
    "Unicode survives too: café · naïve · 🚗 · ✅ · Ω",
    "",
  ].join("\r\n");

  test("hand-editing the prose body and re-running leaves that edit byte-identical", async () => {
    const dir = fresh("prose");
    const db = seeded([{ ...NULL_RATE_CLIENT }]);
    await runExport(dir, db);

    const path = join(dir, "clients", "l2detailz", "README.md");
    const generated = readFileSync(path, "utf8");
    const closing = generated.indexOf("\n---\n", generated.indexOf(MARKER_END)) + "\n---\n".length;
    const head = generated.slice(0, closing);
    writeFileSync(path, head + AWKWARD, "utf8");
    const handEdited = readFileSync(path);

    // Change the data so the generated half MUST be rewritten. If the body
    // survives a rewrite it survives a no-op trivially.
    const db2 = seeded([{ ...NULL_RATE_CLIENT, status: "paused", updated_at: "2026-08-20T00:00:00.000Z" }]);
    const res = await runExport(dir, db2);
    assert.equal(res.facts.changed, 1, "the generated block should have been rewritten");

    const after = readFileSync(path);
    const bodyBefore = handEdited.subarray(handEdited.indexOf(Buffer.from("## Where it stands")));
    const bodyAfter = after.subarray(after.indexOf(Buffer.from("## Where it stands")));
    assert.deepEqual(bodyAfter, bodyBefore, "the hand-written body was not byte-identical");
    assert.ok(after.includes(Buffer.from("café · naïve")), "unicode was mangled");
    assert.ok(after.includes(Buffer.from("this line.   \r\n")), "trailing whitespace / CRLF was rewritten");
    assert.match(after.toString("utf8"), /^status: on-hold$/m, "the generated half did not update");
    // The decoy markers in the prose are still there, untouched and inert.
    assert.equal(after.toString("utf8").split(MARKER_END).length - 1, 2);
  });

  test("a README with no markers is refused, never repaired", async () => {
    const dir = fresh("nomarkers");
    const path = join(dir, "clients", "l2detailz", "README.md");
    mkdirSync(join(dir, "clients", "l2detailz"), { recursive: true });
    const hand = "---\nname: mine\n---\n\nEntirely hand-written.\n";
    writeFileSync(path, hand, "utf8");

    const res = await runExport(dir, seeded([{ ...NULL_RATE_CLIENT }]));
    assert.equal(readFileSync(path, "utf8"), hand, "a marker-less README was overwritten");
    assert.equal(res.findings.length, 1);
    assert.match(res.findings[0], /bcns:generated marker/);
  });

  test("spliceGenerated refuses a file with no frontmatter at all", () => {
    const r = spliceGenerated("# just a heading\n", "name: x");
    assert.equal(r.ok, false);
    assert.match(r.error, /no YAML frontmatter/);
  });

  test("a body-only END marker cannot pull the splice out of the frontmatter", () => {
    const raw = newReadme("name: a", "x") + `\nprose\n${MARKER_END}\nmore\n`;
    const r = spliceGenerated(raw, "name: b");
    assert.equal(r.ok, true);
    assert.match(r.text, /^name: b$/m);
    assert.ok(r.text.endsWith("\nprose\n" + MARKER_END + "\nmore\n"), "the body was truncated");
  });
});

/* ------------------------------------------------ money never reaches a file */

describe("money never reaches a file", () => {
  test("a NULL monthly rate exports with no rate field — not a zero, not a guess", async () => {
    const dir = fresh("null-rate");
    await runExport(dir, seeded([{ ...NULL_RATE_CLIENT }]));
    const text = readmeAt(dir, "l2detailz").toString("utf8");
    // The generated block only — the marker line itself contains "gene-rate-d".
    const block = text.split(MARKER_BEGIN)[1].split(MARKER_END)[0];
    assert.ok(!/rate|cents|price|\$|monthly/i.test(block), `a money field appeared:\n${block}`);
    assert.ok(!/:\s*0\s*$/m.test(block), "a zero was written into the generated block");
    assert.equal(renderBlock(NULL_RATE_CLIENT, ACCOUNT), block.trim(), "the file and the renderer disagree");
  });

  test("a client WITH a rate exports no rate either — the renderer has no branch for it", async () => {
    const dir = fresh("paid");
    await runExport(dir, seeded([{ ...PAID_CLIENT }]));
    const text = readmeAt(dir, "coventry").toString("utf8");
    assert.ok(!text.includes("49900"), "a real monthly rate was written to a tracked file");
    assert.ok(!/monthly_rate|cents/.test(text));
  });

  test("monthly_rate_cents is never even selected", () => {
    assert.ok(!CLIENT_COLUMNS.includes("monthly_rate"), "money is in the export's SELECT list");
    assert.ok(!CLIENT_COLUMNS.includes("deal_value"), "deal value is in the export's SELECT list");
  });
});

/* ------------------------------------------------------- the template shape */

describe("the template shape", () => {
  test("the generated frontmatter validates against every key in _TEMPLATE.md", () => {
    const template = join(homedir(), "os", "clients", "_TEMPLATE.md");
    if (!existsSync(template)) return; // absent on a fresh clone; nothing to check against.

    // READ ONLY. This test never writes anywhere near ~/os.
    const raw = readFileSync(template, "utf8");
    const fm = raw.split(/^---[ \t]*$/m)[1] ?? "";
    const keys = [...fm.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    assert.ok(keys.length >= 8, `parsed too few keys from _TEMPLATE.md: ${keys}`);

    const block = renderBlock(NULL_RATE_CLIENT, ACCOUNT);
    const emitted = new Set([...block.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]));
    for (const key of keys) {
      // The template's own rule: `repo_note` stands in for `repo`.
      if (key === "repo") {
        assert.ok(emitted.has("repo") || emitted.has("repo_note"), "neither repo nor repo_note was emitted");
        continue;
      }
      assert.ok(emitted.has(key), `generated frontmatter is missing the template key \`${key}\``);
    }
    assert.deepEqual([...TEMPLATE_KEYS].filter((k) => !keys.includes(k)), [], "TEMPLATE_KEYS drifted from _TEMPLATE.md");
  });

  test("the emitted block parses as YAML and holds template-legal values", () => {
    const block = renderBlock(PAID_CLIENT, ACCOUNT_2);
    assert.match(block, /^status: (lead|active|in-progress|on-hold|complete)$/m);
    assert.match(block, /^priority: (high|medium|low)$/m);
    assert.match(block, /^last_active: \d{4}-\d{2}-\d{2}$/m);
    assert.match(block, /^next_step: ".+"$/m);
    assert.match(block, /^summary: ".+"$/m);
    assert.match(block, /^tags: \[.+\]$/m);
    // A client with no repo has no GitHub URL, and says so rather than guessing.
    assert.match(block, /^github: null$/m);
    // New detail lands in next_step, never in an appended body section.
    assert.match(block, /next_step: ".*clients\.domain.*"/);
  });

  test("status and repo mappings are total", () => {
    assert.equal(templateStatus("onboarding"), "in-progress");
    assert.equal(templateStatus("paused"), "on-hold");
    assert.equal(templateStatus("churned"), "complete");
    assert.equal(templateStatus("active"), "active");
    assert.equal(githubUrl("bcn-services/x"), "https://github.com/bcn-services/x");
    assert.equal(githubUrl("~/local/path"), null);
    assert.equal(githubUrl(null), null);
  });
});

/* --------------------------------------------------------- the nightly commit */

describe("the nightly commit", () => {
  test("no os directory configured is a finding, not a guess at ~/os", async () => {
    const saved = process.env.OS_DIR;
    delete process.env.OS_DIR;
    try {
      assert.equal(resolveOsDir(), "");
      const res = await readmeExportJob({}).run({ db: seeded([]), now: new Date() });
      assert.equal(res.findings.length, 1);
      assert.match(res.findings[0], /no os directory configured/);
    } finally {
      if (saved !== undefined) process.env.OS_DIR = saved;
    }
  });

  test("commits into a throwaway repo as bcns-os-bot, naming the real actor", async () => {
    const dir = fresh("git");
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "seed@example.com");
    git("config", "user.name", "seed");
    writeFileSync(join(dir, ".keep"), "");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");

    const db = seeded([{ ...NULL_RATE_CLIENT }], {
      account_activity: [
        { account_id: "acct-1", actor_email: "old@bcn-services.com", occurred_at: "2026-08-01T00:00:00Z" },
        { account_id: "acct-1", actor_email: "newest.human@bcn-services.com", occurred_at: "2026-08-20T00:00:00Z" },
      ],
    });

    // `push: false` is implicit — the throwaway repo has no remote, and
    // os_publish reports pushed:false rather than failing.
    const res = await readmeExportJob({ osDir: dir }).run({ db, now: new Date("2026-08-25T00:00:00Z") });
    assert.equal(res.findings.length, 0, res.log);
    assert.match(res.log, /committed via os_publish/);

    assert.equal(git("log", "-1", "--format=%an").trim(), BOT_AUTHOR.name);
    assert.equal(git("log", "-1", "--format=%ae").trim(), BOT_AUTHOR.email);
    const body = git("log", "-1", "--format=%B");
    assert.match(body, /export client README frontmatter/);
    assert.match(body, /- l2detailz/);
    // The newest human actor, from the column item 4's trigger stamps itself.
    // Deliberately NOT the admin address os_publish borrows as its caller, so
    // this proves attribution rather than an identity leaking through.
    assert.match(body, /newest\.human@bcn-services\.com/);
    assert.ok(!body.includes("old@bcn-services.com"), "an older actor was named over the newest");

    // Second run: nothing changed, so nothing is committed.
    const before = git("rev-parse", "HEAD").trim();
    const again = await readmeExportJob({ osDir: dir }).run({ db, now: new Date("2026-08-26T00:00:00Z") });
    assert.equal(again.facts.changed, 0);
    assert.equal(git("rev-parse", "HEAD").trim(), before, "an unchanged run still made a commit");
  });

  test("the commit message stays inside os_publish's 500-char cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => `client-with-a-long-slug-${i}`);
    const actors = new Map(many.map((s) => [s, `${s}@example.com`]));
    const msg = commitMessage(many, actors);
    assert.ok(msg.length <= 500, `commit message was ${msg.length} chars`);
    assert.match(msg, /^chore\(os\): export client README frontmatter \(40 clients\)/);
  });
});

/* ------------------------------------------------ the registry knows about it */

describe("the registry", () => {
  test("readme_export is a job, not a second runner", async () => {
    const { jobRegistry, JOB_NAMES } = await import("../lib/jobs.ts");
    assert.ok(JOB_NAMES.includes("readme_export"));
    const reg = jobRegistry({ readme: { osDir: fresh("registry"), commit: false } });
    assert.equal(reg.readme_export.name, "readme_export");
    assert.equal(reg.readme_export.schedule, "daily");
    assert.equal(reg.readme_export.window(new Date("2026-08-25T23:00:00Z")), "2026-08-25");
  });
});
