/**
 * outreach.test.mjs — item 10's lane logic, drafting job and target sweep,
 * against the in-memory fake.
 *
 * Item 10's `done when:` criteria, by name:
 *
 *   "writing a human account_activity row on an ai lead sets outreach_mode to
 *    paused, and the outreach job then selects 0 rows for it"
 *      → describe("a human touch pauses the lane") here for the JOB half, and
 *        tests/outreach-lanes-migration.test.mjs for the TRIGGER half, which is
 *        where the flip actually lives.
 *   "a lead with 3 bot activity rows and no reply is set to no_response and
 *    receives no 4th draft"
 *      → describe("the three-touch cap")
 *   "an outreach draft for a lead with a reachable website contains a business
 *    description derived from that site's content, not from its source_query"
 *      → describe("the description comes from the site")
 *   "the sweep with zero enough_data:true segments draws every target from
 *    lead_targets and invents none"
 *      → describe("the sweep never invents a territory")
 *
 * NOTHING HERE TOUCHES A NETWORK AND NOTHING SENDS. The site reader and the
 * evaluator are injected in every case and the real ones are never
 * constructed, so no test can reach a lead's website or a model. There is no
 * send path to test, because there is none to build.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./helpers/fake-db.mjs";
import { markServiceClient } from "../lib/service-client-mark.ts";
import { DEFAULT_ADMIN_EMAIL } from "../lib/env.ts";
import { runJob } from "../lib/jobs.ts";
import {
  LANE_MODES,
  MANUAL_LANE_MODES,
  MAX_BOT_TOUCHES,
  MIN_SEGMENT_ROWS,
  OPEN_STAGES,
  chooseTargets,
  countTouches,
  isHumanActivity,
  isManualLaneMode,
  laneVerdict,
  leadSweepJob,
  outreachJob,
  parseEvaluation,
  segmentsFrom,
} from "../lib/outreach.ts";

const NOW = new Date("2026-08-24T09:00:00.000Z");
const ADMIN = {
  profileId: "eeeeeeee-0000-4000-8000-000000000001",
  email: DEFAULT_ADMIN_EMAIL,
  displayName: "Nate",
  role: "admin",
};

/** The unique indexes the two jobs actually rely on, as the fake models them. */
const UNIQUE = {
  unique: {
    job_runs: [["job", "window_key"]],
    outreach_drafts: [["account_id", "touch_number"]],
  },
};

function fakeMailer() {
  const sent = [];
  return { sent, send: async (p) => (sent.push(p), { ok: true }) };
}

function harness(tables = {}) {
  tables.job_runs ??= [];
  tables.inbox_items ??= [];
  tables.email_outbox ??= [];
  tables.accounts ??= [];
  tables.account_activity ??= [];
  tables.outreach_drafts ??= [];
  tables.lead_targets ??= [];
  const mailer = fakeMailer();
  return {
    tables,
    mailer,
    deps: {
      db: markServiceClient(fakeDb(tables, UNIQUE)),
      now: () => NOW,
      admin: async () => ADMIN,
      mailer,
    },
  };
}

const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

const lead = (n, over = {}) => ({
  id: uuid(n),
  business_name: `Business ${n}`,
  business_type: "plumber",
  city: "Providence",
  website: `https://business${n}.example`,
  has_website: true,
  source_query: "plumbers in Providence RI",
  notes: null,
  status: "new",
  outreach_mode: "ai",
  ...over,
});

const touch = (accountId, kind, i = 0) => ({
  id: `act-${accountId}-${kind}-${i}`,
  account_id: accountId,
  kind,
  note: null,
  actor_email: null,
  occurred_at: "2026-08-01T00:00:00Z",
});

/** A reader that answers with the given page text and never opens a socket. */
const siteSaying = (text) => async (url) => ({
  ok: true,
  text: `<untrusted-content source="${url}">\n${text}\n</untrusted-content>`,
  finalUrl: url,
  title: null,
});

const siteDown = async () => ({ ok: false, error: "HTTP 500" });

/**
 * An evaluator that answers ONLY from what the prompt actually contained.
 *
 * This is the load-bearing half of the description test: it does not echo a
 * canned string, it searches the prompt it was handed for the site's own words
 * and refuses if they are not there. So the assertion proves the job put the
 * fetched page in front of the model, not that the fake was cooperative.
 */
function promptReadingEvaluator(phrase) {
  const seen = [];
  const evaluate = async (prompt) => {
    seen.push(prompt);
    if (!prompt.includes(phrase)) {
      return { ok: true, reply: JSON.stringify({ subject: "s", body: "b" }) };
    }
    return {
      ok: true,
      reply: JSON.stringify({
        description: `They ${phrase}.`,
        notes: "no online booking",
        subject: "A question about your site",
        body: "Hi there,",
      }),
    };
  };
  return { evaluate, seen };
}

/* ------------------------------------------------------------------ lanes -- */

describe("the four lanes", () => {
  test("no_response is a real stored lane, and not one a person may choose", () => {
    assert.deepEqual([...LANE_MODES], ["ai", "human", "paused", "no_response"]);
    assert.deepEqual([...MANUAL_LANE_MODES], ["ai", "human", "paused"]);
    assert.equal(isManualLaneMode("no_response"), false);
    assert.equal(isManualLaneMode("ai"), true);
    assert.equal(isManualLaneMode("nonsense"), false);
  });

  test("the open stages exclude every terminal one, so a won account is unreachable", () => {
    for (const dead of ["won", "lost", "dead"]) {
      assert.ok(!OPEN_STAGES.includes(dead), `${dead} must not be an open stage`);
    }
    assert.ok(OPEN_STAGES.includes("new"));
  });
});

describe("'written by a human' is decided from the row, not from the caller", () => {
  test("the five human kinds are human and the three agent kinds are not", () => {
    for (const k of ["call", "email", "meeting", "note", "status_change"]) {
      assert.equal(isHumanActivity(k), true, `${k} is a human kind`);
    }
    for (const k of ["ai_email_sent", "ai_email_reply", "agent_run"]) {
      assert.equal(isHumanActivity(k), false, `${k} is the bot's own kind`);
    }
  });
});

/* ----------------------------------------------------------- the selection -- */

describe("a human touch pauses the lane — and the job then sees nothing", () => {
  test("the job selects only 'ai' leads in an open stage", async () => {
    const h = harness({
      accounts: [
        lead(1), // ai, new         → drafted
        lead(2, { outreach_mode: "paused" }), // paused by a human's activity row
        lead(3, { outreach_mode: "human" }),
        lead(4, { outreach_mode: "no_response" }),
        lead(5, { status: "won" }), // one of the five won accounts
        lead(6, { status: "lost" }),
        lead(7, { status: "dead" }),
      ],
    });

    const out = await runJob(
      outreachJob({ readSite: siteSaying("we fix boilers"), evaluate: async () => ({ ok: false, error: "off" }) }),
      h.deps,
    );

    assert.equal(out.status, "ok");
    // `facts` ride in the run log as key=value (lib/jobs.ts). One lead of seven.
    assert.match(out.log, /considered=1 /);
    // Exactly one draft, and it belongs to the only lead in the ai lane.
    assert.equal(h.tables.outreach_drafts.length, 1);
    assert.equal(h.tables.outreach_drafts[0].account_id, uuid(1));
  });

  test("a lead paused after its human row gets zero drafts on the next run", async () => {
    // The flip itself is 0015's trigger (proven in the migration test). What
    // this asserts is the other half of the criterion: once paused, the
    // outreach job selects 0 rows for that lead.
    const h = harness({
      accounts: [lead(1, { outreach_mode: "paused" })],
      account_activity: [touch(uuid(1), "call")],
    });
    const out = await runJob(outreachJob({ readSite: siteSaying("x"), evaluate: async () => ({ ok: false, error: "off" }) }), h.deps);
    assert.match(out.log, /^no leads in the ai lane/);
    assert.equal(h.tables.outreach_drafts.length, 0);
  });
});

/* ------------------------------------------------------------ the 3 cap --- */

describe("the three-touch cap", () => {
  test("laneVerdict, at the boundary: 2 drafts, 3 parks, 4 parks", () => {
    assert.deepEqual(laneVerdict({ touches: 0, replied: false }), { action: "draft", touchNumber: 1 });
    assert.deepEqual(laneVerdict({ touches: 2, replied: false }), { action: "draft", touchNumber: 3 });
    assert.equal(laneVerdict({ touches: 3, replied: false }).action, "park");
    assert.equal(laneVerdict({ touches: 4, replied: false }).action, "park");
    assert.equal(MAX_BOT_TOUCHES, 3);
  });

  test("a reply outranks the count at every number", () => {
    for (const n of [0, 2, 3, 4]) {
      assert.equal(laneVerdict({ touches: n, replied: true }).action, "skip", `at ${n} touches`);
    }
  });

  test("a touch is an ai_email_sent row; a reply is an ai_email_reply row", () => {
    const rows = [
      { kind: "ai_email_sent" },
      { kind: "ai_email_sent" },
      { kind: "call" },       // human contact is not a bot touch
      { kind: "agent_run" },  // bookkeeping is not a bot touch
    ];
    assert.deepEqual(countTouches(rows), { touches: 2, replied: false });
    assert.deepEqual(countTouches([...rows, { kind: "ai_email_reply" }]), { touches: 2, replied: true });
  });

  test("2 touches gets a third draft; 3 gets parked with no fourth", async () => {
    const twoTouches = [touch(uuid(1), "ai_email_sent", 1), touch(uuid(1), "ai_email_sent", 2)];
    const threeTouches = [
      touch(uuid(2), "ai_email_sent", 1),
      touch(uuid(2), "ai_email_sent", 2),
      touch(uuid(2), "ai_email_sent", 3),
    ];
    const h = harness({
      accounts: [lead(1), lead(2)],
      account_activity: [...twoTouches, ...threeTouches],
    });

    const out = await runJob(
      outreachJob({ readSite: siteSaying("we fix boilers"), evaluate: async () => ({ ok: false, error: "off" }) }),
      h.deps,
    );
    assert.equal(out.status, "ok");

    const drafts = h.tables.outreach_drafts;
    assert.equal(drafts.length, 1, "only the two-touch lead is drafted for");
    assert.equal(drafts[0].account_id, uuid(1));
    assert.equal(drafts[0].touch_number, 3);

    const parked = h.tables.accounts.find((a) => a.id === uuid(2));
    assert.equal(parked.outreach_mode, "no_response");
    assert.equal(h.tables.accounts.find((a) => a.id === uuid(1)).outreach_mode, "ai");

    // The park leaves an agent_run trace — an AGENT kind, so it cannot pause
    // the lane it just set.
    const trace = h.tables.account_activity.filter((r) => r.account_id === uuid(2) && r.kind === "agent_run");
    assert.equal(trace.length, 1);
    assert.match(trace[0].note, /no_response/);
    assert.equal(isHumanActivity(trace[0].kind), false);
  });

  test("a parked lead gets no draft on any later run", async () => {
    const h = harness({
      accounts: [lead(1)],
      account_activity: [1, 2, 3].map((i) => touch(uuid(1), "ai_email_sent", i)),
    });
    const job = outreachJob({ readSite: siteSaying("x"), evaluate: async () => ({ ok: false, error: "off" }) });

    await runJob(job, h.deps);
    assert.equal(h.tables.accounts[0].outreach_mode, "no_response");

    // A second run, in a different window, so idempotency is not what stops it.
    const tomorrow = { ...h.deps, now: () => new Date(NOW.getTime() + 86_400_000) };
    const second = await runJob(job, tomorrow);
    assert.equal(second.ran, true);
    assert.match(second.log, /^no leads in the ai lane/);
    assert.equal(h.tables.outreach_drafts.length, 0, "no fourth draft, ever");
  });

  test("re-running in a new window does not re-draft the same touch", async () => {
    const h = harness({ accounts: [lead(1)] });
    const job = outreachJob({ readSite: siteSaying("x"), evaluate: async () => ({ ok: false, error: "off" }) });
    await runJob(job, h.deps);
    await runJob(job, { ...h.deps, now: () => new Date(NOW.getTime() + 86_400_000) });
    assert.equal(h.tables.outreach_drafts.length, 1, "the unique index on (account, touch) holds");
  });
});

/* -------------------------------------------------------- the description -- */

describe("the description comes from the site, not from source_query", () => {
  test("a reachable site yields a description built from the page's own words", async () => {
    const PHRASE = "have rebuilt oil burners in Rhode Island since 1978";
    const { evaluate, seen } = promptReadingEvaluator(PHRASE);
    const h = harness({ accounts: [lead(1)] });

    await runJob(outreachJob({ readSite: siteSaying(`We ${PHRASE}.`), evaluate }), h.deps);

    const draft = h.tables.outreach_drafts[0];
    assert.ok(draft, "a draft was written");
    assert.match(draft.business_description, /oil burners/);
    // The lead's source_query is "plumbers in Providence RI". The description
    // must not be that, nor derived from it.
    assert.ok(
      !/plumbers in Providence RI/i.test(draft.business_description),
      `description leaked the source query: ${draft.business_description}`,
    );
    assert.equal(draft.site_url, "https://business1.example");

    // And the page really was what the model saw, inside its fence.
    assert.equal(seen.length, 1);
    assert.match(seen[0], /<untrusted-content source=/);
    assert.ok(seen[0].includes(PHRASE));
  });

  test("an unreadable site yields NO description — never one rebuilt from source_query", async () => {
    const h = harness({ accounts: [lead(1)] });
    let called = 0;
    await runJob(
      outreachJob({ readSite: siteDown, evaluate: async () => (called++, { ok: true, reply: "{}" }) }),
      h.deps,
    );
    const draft = h.tables.outreach_drafts[0];
    assert.equal(draft.business_description, null);
    assert.equal(draft.site_url, null);
    assert.equal(called, 0, "no evaluation is attempted when nothing was read");
    assert.ok(!/plumbers in Providence RI/i.test(draft.body));
  });

  test("a lead with no website is drafted for, without a description", async () => {
    const h = harness({ accounts: [lead(1, { website: null, has_website: false })] });
    let reads = 0;
    await runJob(
      outreachJob({ readSite: async () => (reads++, siteDown()), evaluate: async () => ({ ok: false, error: "off" }) }),
      h.deps,
    );
    assert.equal(reads, 0, "no fetch is attempted for a lead with no website");
    assert.equal(h.tables.outreach_drafts[0].business_description, null);
  });

  test("a draft row carries no recipient, no send state and no timestamp of sending", async () => {
    const h = harness({ accounts: [lead(1)] });
    await runJob(
      outreachJob({ readSite: siteSaying("we fix boilers"), evaluate: async () => ({ ok: false, error: "off" }) }),
      h.deps,
    );
    const draft = h.tables.outreach_drafts[0];
    for (const forbidden of ["to_email", "recipient", "sent_at", "status", "message_id"]) {
      assert.ok(!(forbidden in draft), `a draft must not carry ${forbidden}`);
    }
    // And nothing was queued for delivery to the lead.
    assert.equal(h.tables.email_outbox.length, 0);
  });

  test("parseEvaluation survives a model that wrapped its JSON in prose", () => {
    const e = parseEvaluation('Sure! ```json\n{"description":"a bakery","subject":"hi"}\n```');
    assert.equal(e.description, "a bakery");
    assert.equal(e.subject, "hi");
    assert.equal(e.body, null);
    assert.deepEqual(parseEvaluation("no json here"), {
      description: null, notes: null, subject: null, body: null,
    });
    assert.equal(parseEvaluation('{"description":"   "}').description, null);
  });
});

/* -------------------------------------------------------------- the sweep -- */

describe("the sweep never invents a territory", () => {
  test("with zero enough_data segments every target comes from lead_targets", async () => {
    const h = harness({
      lead_targets: [
        { trade: "roofer", town: "Warwick", active: true, created_at: "2026-01-01" },
        { trade: "dentist", town: "Cranston", active: true, created_at: "2026-01-02" },
        { trade: "florist", town: "Newport", active: false, created_at: "2026-01-03" },
      ],
      // Four plumbers in Providence: below MIN_SEGMENT_ROWS, so enough_data is
      // false no matter how well the segment looks like it converts.
      accounts: [1, 2, 3, 4].map((n) => lead(n, { status: "won" })),
    });

    const out = await runJob(leadSweepJob(), h.deps);
    assert.equal(out.status, "ok");
    assert.match(out.log, /segments_with_enough_data=0/);
    assert.match(out.log, /targets=2 from_lead_targets=2/);
    // Two active targets, both from lead_targets, and nothing else.
    assert.match(out.log, /1\. roofer in Warwick — lead_targets/);
    assert.match(out.log, /2\. dentist in Cranston — lead_targets/);
    assert.ok(!/plumber/i.test(out.log), `the sweep invented a territory: ${out.log}`);
    assert.ok(!/Newport/.test(out.log), "an inactive target is not swept");
  });

  test("an empty lead_targets with no evidence yields zero targets, not a guess", async () => {
    const h = harness({ lead_targets: [], accounts: [lead(1)] });
    const out = await runJob(leadSweepJob(), h.deps);
    assert.equal(out.status, "ok", "an empty target list is a gap, not a failure");
    assert.deepEqual(out.findings, []);
    assert.match(out.log, /nothing to prospect/);
  });

  test("chooseTargets: no earned segment means the lead_targets list, verbatim", () => {
    const targets = [{ trade: "roofer", town: "Warwick" }];
    const weak = [{ trade: "plumber", town: "Providence", total: 4, won: 4, win_rate: 1, enough_data: false }];
    assert.deepEqual(chooseTargets(targets, weak), [
      { trade: "roofer", town: "Warwick", why: "lead_targets" },
    ]);
    assert.deepEqual(chooseTargets([], weak), []);
    assert.deepEqual(chooseTargets([], []), []);
  });

  test("chooseTargets: an earned segment leads, and lead_targets still follow", () => {
    const targets = [{ trade: "roofer", town: "Warwick" }];
    const earned = [{ trade: "plumber", town: "Providence", total: 10, won: 4, win_rate: 0.4, enough_data: true }];
    const out = chooseTargets(targets, earned);
    assert.equal(out.length, 2);
    assert.equal(out[0].trade, "plumber");
    assert.match(out[0].why, /4\/10 won/);
    assert.equal(out[1].why, "lead_targets");
  });

  test("segmentsFrom follows the skill's rule: below the floor is enough_data false", () => {
    const rows = (n, status) =>
      Array.from({ length: n }, () => ({ business_type: "plumber", city: "Providence", status }));
    const small = segmentsFrom(rows(MIN_SEGMENT_ROWS - 1, "won"));
    assert.equal(small[0].enough_data, false);
    assert.equal(small[0].win_rate, 1);
    const big = segmentsFrom(rows(MIN_SEGMENT_ROWS, "won"));
    assert.equal(big[0].enough_data, true);
    // A half-named segment is not a territory and never becomes one.
    assert.deepEqual(segmentsFrom([{ business_type: "plumber", city: null, status: "won" }]), []);
    assert.deepEqual(segmentsFrom([{ business_type: null, city: "Rye", status: "won" }]), []);
  });
});
