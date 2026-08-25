/**
 * jobs.test.mjs — the job framework and the three jobs, against the in-memory
 * fake.
 *
 * Every one of item 9's `done when:` criteria is here by name:
 *
 *   "a job that throws mid-run leaves a job_runs row with status failed and a
 *    non-null finished_at"          → describe("the row always closes")
 *   "the health sweep on one reachable, one unreachable and three with no
 *    domain yields exactly one healthy, one down, three unmonitorable"
 *                                   → describe("the health sweep")
 *   "the credential job warns at 29 days and stays silent at 31"
 *                                   → describe("credential expiry")
 *   "the quiet detector flags at 8 days, not at 6, and ignores active and
 *    churned entirely"              → describe("the quiet detector")
 *
 * NOTHING HERE TOUCHES A NETWORK. The site fetcher is injected in every case
 * and the real one is never constructed, so no test can reach a client domain.
 * The clock is injected too, which is what makes 29-versus-31 a fact rather
 * than a thing that depends on the day the suite is run.
 *
 * The unique index that carries the whole idempotency guarantee is modelled by
 * `fakeDb`'s `unique` option and proved for real, against two overlapping psql
 * sessions, in tests/job-window-migration.test.mjs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./helpers/fake-db.mjs";
import { markServiceClient } from "../lib/service-client-mark.ts";
import { DEFAULT_ADMIN_EMAIL } from "../lib/env.ts";
import {
  GITHUB_PAT_EXPIRES_AT,
  JOB_NAMES,
  QUIET_DAYS,
  WARN_WITHIN_DAYS,
  checkSite,
  credentialExpiryJob,
  dailyWindow,
  daysUntil,
  healthTarget,
  jobRegistry,
  judgeQuiet,
  quietClientJob,
  runJob,
  siteHealthJob,
  weeklyWindow,
} from "../lib/jobs.ts";

const NATE = "eeeeeeee-0000-4000-8000-000000000001";
const ADMIN = {
  profileId: NATE,
  email: DEFAULT_ADMIN_EMAIL,
  displayName: "Nate",
  role: "admin",
};

/** Today, per the item. Never `new Date()` — that would make tests drift. */
const NOW = new Date("2026-08-24T09:00:00.000Z");
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const daysAgo = (n) => daysFromNow(-n);

/** A mailer that records instead of sending. Never a network. */
function fakeMailer() {
  const sent = [];
  return { sent, send: async (p) => (sent.push(p), { ok: true }) };
}

/** The unique index from 0014, as the fake models it. */
const UNIQUE = { unique: { job_runs: [["job", "window_key"]] } };

function harness(tables = {}) {
  tables.job_runs ??= [];
  tables.inbox_items ??= [];
  tables.email_outbox ??= [];
  const db = markServiceClient(fakeDb(tables, UNIQUE));
  const mailer = fakeMailer();
  return {
    tables,
    mailer,
    deps: { db, now: () => NOW, admin: async () => ADMIN, mailer },
  };
}

/** A job definition built from a plain function, for framework-level tests. */
const jobOf = (name, run, window = dailyWindow) => ({ name, window, schedule: "test", run });

/* ------------------------------------------------------------------------- */

describe("windows — the label two invocations have to agree on", () => {
  test("a daily window is the UTC calendar day", () => {
    assert.equal(dailyWindow(NOW), "2026-08-24");
    assert.equal(dailyWindow(new Date("2026-08-24T23:59:59.999Z")), "2026-08-24");
    assert.notEqual(dailyWindow(new Date("2026-08-25T00:00:00Z")), dailyWindow(NOW));
  });

  test("a weekly window is a fixed seven-day bucket, not a sliding one", () => {
    const w = weeklyWindow(NOW);
    // Every instant inside one bucket agrees, which is all a claim needs.
    const start = new Date(Math.floor(NOW.getTime() / 604_800_000) * 604_800_000);
    assert.equal(weeklyWindow(start), w);
    assert.equal(weeklyWindow(new Date(start.getTime() + 604_800_000 - 1)), w);
    // And the bucket after it is a different string, so a weekly job runs again.
    assert.notEqual(weeklyWindow(new Date(start.getTime() + 604_800_000)), w);
    assert.notEqual(weeklyWindow(new Date(NOW.getTime() + 8 * 86_400_000)), w);
  });
});

describe("idempotency — twice in one window is one notification", () => {
  test("the second invocation does no work, writes no row and notifies nobody", async () => {
    const h = harness();
    let ran = 0;
    const job = jobOf("t_idem", async () => (ran++, { findings: ["a thing"], log: "x" }));

    const first = await runJob(job, h.deps);
    const second = await runJob(job, h.deps);

    assert.equal(ran, 1, "the job body ran exactly once");
    assert.equal(first.ran, true);
    assert.equal(second.ran, false, "the second invocation lost the window");
    assert.equal(second.status, null, "a lost window is not a failure");
    assert.equal(h.tables.job_runs.length, 1, "exactly one job_runs row");
    assert.equal(h.tables.inbox_items.length, 1, "exactly ONE notification");
    assert.equal(h.tables.email_outbox.length, 1, "exactly one email");
  });

  test("CONCURRENT invocations collapse to one — neither waits for the other", async () => {
    const h = harness();
    let ran = 0;
    // Both bodies are in flight before either closes: the claim, not a
    // finished row, is what excludes the loser.
    const job = jobOf("t_race", async () => {
      ran++;
      await new Promise((r) => setTimeout(r, 20));
      return { findings: ["a thing"], log: "x" };
    });

    const outs = await Promise.all([runJob(job, h.deps), runJob(job, h.deps), runJob(job, h.deps)]);

    assert.equal(ran, 1, "only one body ever started");
    assert.equal(outs.filter((o) => o.ran).length, 1, "exactly one invocation ran");
    assert.equal(h.tables.job_runs.length, 1);
    assert.equal(h.tables.inbox_items.length, 1, "three simultaneous invocations, ONE notification");
  });

  test("the next window is free again", async () => {
    const h = harness();
    let ran = 0;
    const job = jobOf("t_next", async () => (ran++, { findings: [], log: "" }));
    await runJob(job, h.deps);
    await runJob(job, { ...h.deps, now: () => new Date("2026-08-25T09:00:00Z") });
    assert.equal(ran, 2);
    assert.equal(h.tables.job_runs.length, 2);
  });

  test("an interactive skill run is NOT windowed — pressing twice runs twice", async () => {
    // The partial index ignores nulls, which is what keeps item 5 working.
    const { openRun } = await import("../lib/agent/skill-run.ts");
    const h = harness();
    const a = await openRun(h.deps.db, "leads", "someone@example.com");
    const b = await openRun(h.deps.db, "leads", "someone@example.com");
    assert.ok(a && b && a !== b, "two unwindowed runs of the same skill both open");
  });
});

describe("the row always closes — a throw, a timeout and a rejected promise", () => {
  const cases = [
    ["a synchronous throw", async () => { throw new Error("boom"); }],
    ["a rejected promise", () => Promise.reject(new Error("rejected"))],
  ];

  for (const [label, body] of cases) {
    test(`${label} leaves a closed, failed row`, async () => {
      const h = harness();
      const out = await runJob(jobOf(`t_${label.replace(/\W/g, "")}`, body), h.deps);

      assert.equal(out.status, "failed");
      const [row] = h.tables.job_runs;
      assert.equal(row.status, "failed", "job_runs.status is failed");
      assert.ok(row.finished_at, "finished_at is non-null");
      assert.ok(Date.parse(row.finished_at) > 0, "finished_at is a real timestamp");
      assert.match(row.log, /boom|rejected/);
    });
  }

  test("a job that hangs is closed as failed rather than left running", async () => {
    const h = harness();
    const out = await runJob(
      jobOf("t_hang", () => new Promise(() => {})),
      { ...h.deps, timeoutMs: 30 },
    );
    assert.equal(out.status, "failed");
    assert.match(out.log, /timed out after 30ms/);
    const [row] = h.tables.job_runs;
    assert.equal(row.status, "failed");
    assert.ok(row.finished_at, "a hung job still has a non-null finished_at");
  });

  test("a failed run emails the admin; a clean run does not", async () => {
    const h = harness();
    await runJob(jobOf("t_bad", async () => { throw new Error("nope"); }), h.deps);
    assert.equal(h.tables.email_outbox.length, 1, "job_run_failed emails the admin");
    assert.equal(h.tables.email_outbox[0].kind, "job_run_failed");

    const clean = harness();
    await runJob(jobOf("t_good", async () => ({ findings: [], log: "all fine" })), clean.deps);
    assert.equal(clean.tables.email_outbox.length, 0, "job_run_ok emails nobody");
    assert.equal(clean.tables.inbox_items.length, 1, "but it still reaches the inbox");
    assert.equal(clean.tables.inbox_items[0].kind, "job_run_ok");
  });

  test("a job that finds something is `attention`, NOT `failed` — it ran perfectly", async () => {
    // Item 9 wrote `failed` here and item 12 corrected it: a sweep that came
    // back and found a site down is a healthy job and an unhealthy world, and
    // /admin's job history is unreadable if the two share a word. The email
    // still goes to the admin — only the sentence changed.
    const h = harness();
    const out = await runJob(
      jobOf("t_finding", async () => ({ findings: ["one thing"], log: "looked" })),
      h.deps,
    );
    assert.equal(out.status, "attention", "findings are the only thing that decides status");
    assert.equal(h.tables.job_runs[0].status, "attention", "and the ROW says so, not just the return");
    assert.ok(h.tables.job_runs[0].finished_at, "it still closed");
    assert.equal(h.tables.email_outbox.length, 1, "and it still reaches the admin");
    assert.equal(h.tables.email_outbox[0].kind, "job_run_attention");
    assert.match(h.tables.inbox_items[0].title, /needs attention/);
  });

  test("`failed` is now reserved for a run that did not come back", async () => {
    const h = harness();
    const out = await runJob(jobOf("t_threw", async () => { throw new Error("boom"); }), h.deps);
    assert.equal(out.status, "failed");
    assert.equal(h.tables.email_outbox[0].kind, "job_run_failed", "still the admin, different sentence");
    assert.match(h.tables.inbox_items[0].title, /failed/);
  });

  test("with no service client the job refuses rather than running unguarded", async () => {
    const out = await runJob(jobOf("t_nodb", async () => ({ findings: [], log: "" })), { db: null });
    assert.equal(out.ran, false);
    assert.equal(out.status, null);
    assert.match(out.log, /refusing to run unguarded/);
  });

  test("a claim that fails for a REAL reason is reported, not mistaken for 'already ran'", async () => {
    const tables = { job_runs: [], inbox_items: [], email_outbox: [] };
    const db = markServiceClient(fakeDb(tables, { failOn: { job_runs: "connection reset" } }));
    const mailer = fakeMailer();
    const out = await runJob(jobOf("t_dberr", async () => ({ findings: [], log: "" })), {
      db,
      now: () => NOW,
      admin: async () => ADMIN,
      mailer,
    });
    assert.equal(out.ran, false);
    assert.equal(out.status, "failed", "a broken database must not look like a clean skip");
    assert.match(out.log, /connection reset/);
  });
});

/* ------------------------------------------------------------ health sweep -- */

describe("the health sweep — unmonitorable is a third state, never healthy", () => {
  /** The item's fixture: one reachable, one unreachable, three with nothing. */
  const FIXTURE = {
    clients: [
      { id: "c1", slug: "alpha", account_id: "a1", status: "active", domain: "alpha.example", droplet_host: null, droplet_port: null },
      { id: "c2", slug: "bravo", account_id: "a2", status: "active", domain: "bravo.example", droplet_host: null, droplet_port: null },
      { id: "c3", slug: "charlie", account_id: "a3", status: "active", domain: null, droplet_host: null, droplet_port: null },
      { id: "c4", slug: "delta", account_id: "a4", status: "onboarding", domain: null, droplet_host: null, droplet_port: null },
      { id: "c5", slug: "echo", account_id: "a5", status: "churned", domain: null, droplet_host: null, droplet_port: null },
    ],
  };

  const fetcher = async (url) => {
    if (url.includes("alpha.example")) return { status: 200 };
    throw new Error("ENOTFOUND");
  };

  test("one healthy, one down, three unmonitorable — exactly", async () => {
    const h = harness(structuredClone(FIXTURE));
    const out = await runJob(siteHealthJob(fetcher), h.deps);

    assert.deepEqual(out.notification?.email ? "emailed" : "silent", "emailed");
    const facts = h.tables.job_runs[0];
    assert.match(facts.log, /alpha: healthy \(200\)/);
    assert.match(facts.log, /bravo: DOWN/);
    for (const slug of ["charlie", "delta", "echo"]) {
      assert.match(facts.log, new RegExp(`${slug}: unmonitorable`));
    }
    // The counts, read off the sweep itself rather than off the prose.
    const states = await Promise.all(FIXTURE.clients.map((c) => checkSite(c, fetcher)));
    const count = (s) => states.filter((r) => r.state === s).length;
    assert.equal(count("healthy"), 1);
    assert.equal(count("down"), 1);
    assert.equal(count("unmonitorable"), 3);
    assert.equal(count("healthy") + count("down") + count("unmonitorable"), 5);
  });

  test("an unmonitorable result carries no url and no status to mistake for a check", async () => {
    const r = await checkSite({ slug: "x", domain: null, droplet_host: null, droplet_port: null }, fetcher);
    assert.equal(r.state, "unmonitorable");
    assert.equal("url" in r, false, "there is no url field to read as 'checked this and it was fine'");
    assert.equal("status" in r, false);
    assert.match(r.reason, /no domain and no droplet_host/);
  });

  test("the fetcher is never called for a client with nothing to check", async () => {
    const calls = [];
    await checkSite({ slug: "x", domain: null, droplet_host: null, droplet_port: null }, async (u) => {
      calls.push(u);
      return { status: 200 };
    });
    assert.deepEqual(calls, [], "no HTTP is attempted against a client that has no address");
  });

  test("only DOWN sites are findings — unmonitorable ones do not email every morning", async () => {
    const h = harness(structuredClone(FIXTURE));
    const out = await runJob(siteHealthJob(fetcher), h.deps);
    assert.equal(out.findings.length, 1);
    assert.match(out.findings[0], /^bravo is DOWN/);
  });

  test("all five unmonitorable is a clean run, not a healthy one", async () => {
    const tables = { clients: FIXTURE.clients.map((c) => ({ ...c, domain: null, droplet_host: null })) };
    const h = harness(tables);
    const out = await runJob(siteHealthJob(fetcher), h.deps);
    assert.equal(out.status, "ok", "nothing is DOWN");
    assert.equal(out.findings.length, 0);
    // The per-client lines say unmonitorable; the summary counts zero healthy.
    assert.equal(/: healthy/.test(out.log), false, "and no client is reported healthy either");
    assert.match(out.log, /healthy=0 down=0 unmonitorable=5/);
  });

  test("a 500 is down, a 200 is healthy, a 301 is healthy", async () => {
    const at = async (status) =>
      (await checkSite({ slug: "s", domain: "x.example", droplet_host: null, droplet_port: null }, async () => ({ status }))).state;
    assert.equal(await at(200), "healthy");
    assert.equal(await at(301), "healthy");
    assert.equal(await at(404), "down");
    assert.equal(await at(500), "down");
  });

  test("a droplet host is checked at its health endpoint, a domain at its root", () => {
    assert.equal(healthTarget({ slug: "a", domain: "a.example", droplet_host: "h", droplet_port: 3000 }), "https://a.example");
    assert.equal(healthTarget({ slug: "b", domain: null, droplet_host: "1.2.3.4", droplet_port: 3100 }), "http://1.2.3.4:3100/api/health");
    assert.equal(healthTarget({ slug: "c", domain: null, droplet_host: "h", droplet_port: null }), "http://h/api/health");
    assert.equal(healthTarget({ slug: "d", domain: "https://d.example/", droplet_host: null, droplet_port: null }), "https://d.example");
    assert.equal(healthTarget({ slug: "e", domain: "  ", droplet_host: null, droplet_port: null }), null);
  });
});

/* ------------------------------------------------------- credential expiry -- */

describe("credential expiry — 29 days warns, 31 days is silent", () => {
  const withTokens = (rows) => ({
    agent_tokens: rows,
    profiles: [{ id: NATE, display_name: "Nate" }, { id: "b", display_name: "Sam" }],
  });

  test("a token expiring in 29 days warns", async () => {
    const h = harness(withTokens([{ profile_id: NATE, expires_at: daysFromNow(29) }]));
    const out = await runJob(credentialExpiryJob(), h.deps);
    assert.equal(out.status, "attention", "a warning is a finding, and a finding is not a failure");
    assert.equal(out.findings.length, 1);
    assert.match(out.findings[0], /Nate's Claude Code token expires in 29d/);
    assert.equal(h.tables.email_outbox.length, 1, "and it reaches the admin by email");
  });

  test("a token expiring in 31 days stays silent", async () => {
    const h = harness(withTokens([{ profile_id: NATE, expires_at: daysFromNow(31) }]));
    const out = await runJob(credentialExpiryJob(), h.deps);
    assert.deepEqual(out.findings, [], "nothing to warn about");
    assert.equal(out.status, "ok");
    assert.equal(h.tables.email_outbox.length, 0, "no email");
    assert.match(out.log, /^ok {2}Nate's Claude Code token expires in 31d/m, "but it is still logged");
  });

  test("the boundary is 30 days inclusive", () => {
    const at = (n) => daysUntil(daysFromNow(n), NOW) <= WARN_WITHIN_DAYS;
    assert.equal(at(29), true);
    assert.equal(at(30), true);
    assert.equal(at(31), false);
  });

  test("an already-expired token warns, and says so", async () => {
    const h = harness(withTokens([{ profile_id: "b", expires_at: daysAgo(3) }]));
    const out = await runJob(credentialExpiryJob(), h.deps);
    assert.match(out.findings[0], /Sam's Claude Code token EXPIRED 3d ago/);
  });

  test("the GitHub PAT is watched by DATE and warns 30 days out", async () => {
    // 2026-08-24 is 68 days before 2026-10-31: silent today.
    const quiet = harness(withTokens([]));
    const a = await runJob(credentialExpiryJob(), quiet.deps);
    assert.deepEqual(a.findings, [], "68 days out, nothing is said");
    assert.match(a.log, /the GitHub PAT expires in 67d|the GitHub PAT expires in 68d/);

    // Two days before the 30-day line.
    const near = new Date(Date.parse(GITHUB_PAT_EXPIRES_AT) - 28 * 86_400_000);
    const loud = harness(withTokens([]));
    const b = await runJob(credentialExpiryJob(), { ...loud.deps, now: () => near });
    assert.equal(b.findings.length, 1);
    assert.match(b.findings[0], /the GitHub PAT expires in 28d \(2026-10-31\)/);
  });

  test("the job never reads or prints a token value", async () => {
    const tables = withTokens([
      { profile_id: NATE, expires_at: daysFromNow(29), sealed: "v1.SECRET.SECRET.SECRET", key_id: "k1" },
    ]);
    const h = harness(tables);
    const out = await runJob(credentialExpiryJob(), h.deps);
    const everything = JSON.stringify([out, h.tables.job_runs, h.tables.inbox_items, h.tables.email_outbox]);
    assert.equal(everything.includes("SECRET"), false, "no ciphertext anywhere in the output");
    // And it is not merely absent from the output — it was never selected.
    const selects = h.deps.db.calls.filter((c) => c.table === "agent_tokens");
    for (const c of selects) {
      const cols = c.ops.find((o) => o[0] === "select")?.[1] ?? "";
      assert.equal(cols.includes("sealed"), false, `agent_tokens select asked for: ${cols}`);
    }
  });

  test("it runs on a weekly window", () => {
    assert.equal(credentialExpiryJob().window(NOW), weeklyWindow(NOW));
    assert.equal(credentialExpiryJob().schedule, "weekly");
  });
});

/* --------------------------------------------------------- quiet detector -- */

describe("the quiet detector — 8 days flags, 6 does not, and only onboarding", () => {
  const client = (slug, status, extra = {}) => ({
    id: `id-${slug}`,
    slug,
    account_id: `acct-${slug}`,
    status,
    repo: null,
    domain: null,
    droplet_host: null,
    droplet_port: null,
    ...extra,
  });

  const dead = async () => {
    throw new Error("ENOTFOUND");
  };

  test("an onboarding client quiet for 8 days is flagged; one at 6 days is not", async () => {
    const h = harness({
      clients: [client("eight", "onboarding"), client("six", "onboarding")],
      account_activity: [
        { account_id: "acct-eight", occurred_at: daysAgo(8) },
        { account_id: "acct-six", occurred_at: daysAgo(6) },
      ],
      tasks: [],
    });
    const out = await runJob(quietClientJob(dead), h.deps);
    assert.equal(out.findings.length, 1);
    assert.match(out.findings[0], /^eight \(onboarding\) has been quiet for 8d/);
    assert.equal(/six \(onboarding\)/.test(out.findings.join("\n")), false);
    assert.match(out.log, /six: ok — last signal 6d ago/);
  });

  test("exactly seven days is inside the threshold", () => {
    const at = (n) =>
      judgeQuiet("x", { lastCommitAt: null, siteHealthy: false, lastContactAt: daysAgo(n), lastTaskAt: null }, NOW).quiet;
    assert.equal(at(6), false);
    assert.equal(at(7), false, "at the threshold, not past it");
    assert.equal(at(8), true);
    assert.equal(QUIET_DAYS, 7);
  });

  test("active and churned clients are never read at all", async () => {
    const h = harness({
      clients: [
        client("live", "active"),
        client("gone", "churned"),
        client("paused-one", "paused"),
        client("new", "onboarding"),
      ],
      account_activity: [
        { account_id: "acct-live", occurred_at: daysAgo(400) },
        { account_id: "acct-gone", occurred_at: daysAgo(400) },
        { account_id: "acct-new", occurred_at: daysAgo(2) },
      ],
      tasks: [],
    });
    const out = await runJob(quietClientJob(dead), h.deps);
    assert.deepEqual(out.findings, [], "a year-old active client is not the quiet job's business");
    assert.equal(/live|gone|paused-one/.test(out.log), false, "they do not even appear in the log");
    assert.match(out.log, /new: ok/);
  });

  test("Tier 2 — an open task counts, a done one does not", async () => {
    const h = harness({
      clients: [client("tasky", "onboarding"), client("closed", "onboarding")],
      account_activity: [],
      tasks: [
        { account_id: "acct-tasky", status: "doing", updated_at: daysAgo(2) },
        { account_id: "acct-closed", status: "done", updated_at: daysAgo(1) },
      ],
    });
    const out = await runJob(quietClientJob(dead), h.deps);
    assert.match(out.log, /tasky: ok/);
    assert.equal(out.findings.length, 1, "a closed task is not a signal of life");
    assert.match(out.findings[0], /^closed \(onboarding\) has never shown a signal/);
  });

  test("Tier 1 — a repo commit outranks a stale contact log", async () => {
    const h = harness({
      clients: [client("shipping", "onboarding", { repo: "bcn-services/x" })],
      account_activity: [{ account_id: "acct-shipping", occurred_at: daysAgo(40) }],
      tasks: [],
    });
    const out = await runJob(quietClientJob(dead, async () => daysAgo(1)), h.deps);
    assert.deepEqual(out.findings, []);
    assert.match(out.log, /shipping: ok — last signal 1d ago/);
  });

  test("Tier 1 — a site that answers is not quiet, whatever the dates say", async () => {
    const h = harness({
      clients: [client("up", "onboarding", { domain: "up.example" })],
      account_activity: [{ account_id: "acct-up", occurred_at: daysAgo(365) }],
      tasks: [],
    });
    const out = await runJob(quietClientJob(async () => ({ status: 200 })), h.deps);
    assert.deepEqual(out.findings, []);
    assert.match(out.log, /up: ok — site is up/);
  });

  test("an unreadable commit reader costs sensitivity, never a false flag", () => {
    // The default reader answers "unknown", and an absent signal is absent —
    // it is never treated as evidence that nothing happened.
    const v = judgeQuiet("x", { lastCommitAt: null, siteHealthy: false, lastContactAt: daysAgo(2), lastTaskAt: null }, NOW);
    assert.equal(v.quiet, false);
  });

  test("no onboarding clients is a clean run, not an empty sweep of everything", async () => {
    const h = harness({ clients: [client("live", "active")], account_activity: [], tasks: [] });
    const out = await runJob(quietClientJob(dead), h.deps);
    assert.equal(out.status, "ok");
    assert.match(out.log, /^no onboarding clients\n\nwindow=2026-08-24 onboarding=0$/);
  });
});

/* ------------------------------------------------------------------- misc -- */

describe("the registry — what scripts/run-job.mjs can be asked for", () => {
  test("exactly the three jobs, and nothing constructs a schedule", () => {
    const reg = jobRegistry({ fetcher: async () => ({ status: 200 }) });
    assert.deepEqual(Object.keys(reg).sort(), [...JOB_NAMES].sort());
    for (const name of JOB_NAMES) {
      assert.equal(reg[name].name, name);
      assert.equal(typeof reg[name].window, "function");
    }
  });

  test("the source contains no timer — scheduling is the caller's job", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../lib/jobs.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const forbidden of ["setInterval", "node-cron", "cron.schedule"]) {
      assert.equal(code.includes(forbidden), false, `lib/jobs.ts must not use ${forbidden}`);
    }
    // The entry point must stay importable under plain node: lib/supabase-admin.ts
    // imports `server-only`, which throws outside a React server render, so a
    // CLI that reached for it would crash before running anything.
    const entry = readFileSync(new URL("../scripts/run-job.mjs", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal(entry.includes("supabase-admin"), false, "a CLI cannot import server-only code");
    assert.equal(/setInterval|setTimeout/.test(entry), false, "the entry point schedules nothing");

    // setTimeout appears exactly twice: the timer that FAILS a hung run, and
    // the `ReturnType<typeof setTimeout>` that types its handle. A third
    // occurrence means somebody added a schedule.
    assert.equal((code.match(/setTimeout/g) ?? []).length, 2);
  });
});
