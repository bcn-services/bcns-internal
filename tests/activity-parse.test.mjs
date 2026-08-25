/**
 * activity-parse.test.mjs — the free-text logging path, without a model call.
 *
 * The split under test: Layer A (verbs/log_activity.ts) builds the prompt and
 * calls the INJECTED runner; Layer B (lib/agent/activity-parse.ts) is pure and
 * turns the reply plus {now, timeZone} into a row. Nothing here spawns the
 * claude CLI or touches the network — the runner is a stub returning canned
 * JSON, which is the only way a date rule can be asserted at all.
 *
 * THE DATE TESTS ARE THE POINT. A relative date resolves against the
 * SUBMITTER'S LOCAL CALENDAR DATE. Every one of them is run at an instant where
 * the local date and the UTC date DIFFER, in both directions, so an
 * implementation that quietly used UTC would fail rather than coincide.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  buildParsePrompt,
  instantFor,
  localDate,
  resolveActivity,
  resolveDateToken,
  safeZone,
  weekdayOf,
  withLocalDate,
  MAX_NOTE_CHARS,
} from "../lib/agent/activity-parse.ts";
import { log_activity } from "../lib/agent/verbs/index.ts";
import {
  captureReducer,
  commitPayload,
  draftDateLocal,
  emptyCapture,
  manualDraft,
} from "../lib/activity-capture.ts";
import { fakeDb } from "./helpers/fake-db.mjs";

/* ---------------------------------------------------------- identities -- */

const MEMBER = {
  profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  email: "brandon@bcn-services.com",
  role: "member",
};
const ACCT = "11111111-1111-4111-8111-111111111111";
const ACCT2 = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";

/** Two accounts and two clients, so nothing below can match by position. */
function fixture() {
  return {
    accounts: [
      { id: ACCT, business_name: "Coventry Contracting" },
      { id: ACCT2, business_name: "Untouched Diner" },
    ],
    clients: [
      { id: "99999999-9999-4999-8999-999999999999", account_id: ACCT2, slug: "diner" },
      { id: CLIENT, account_id: ACCT, slug: "coventry" },
    ],
    account_activity: [
      { id: "seeded-1", account_id: ACCT2, kind: "note", note: "pre-existing", actor_email: "x@y.z" },
    ],
  };
}

/** A runner stub. Records every prompt it was handed; never leaves the process. */
function stubRunner(reply) {
  const prompts = [];
  return {
    prompts,
    run: async (prompt) => {
      prompts.push(prompt);
      return typeof reply === "string" ? { ok: true, reply } : reply;
    },
  };
}

const at = (iso) => () => new Date(iso);

/* ================================================================ zones == */

/*
 * The two instants every date test runs at. Both are chosen so the local
 * calendar date is NOT the UTC calendar date:
 *
 *   LA_EVENING  2026-08-19T01:30:00Z  =  Aug 18, 18:30 in Los Angeles
 *               UTC says the 19th (a Wednesday); LA says the 18th (a Tuesday).
 *   NZ_MORNING  2026-08-19T20:00:00Z  =  Aug 20, 08:00 in Auckland
 *               UTC says the 19th (Wednesday); NZ says the 20th (Thursday).
 */
const LA = "America/Los_Angeles";
const NZ = "Pacific/Auckland";
const LA_EVENING = "2026-08-19T01:30:00.000Z";
const NZ_MORNING = "2026-08-19T20:00:00.000Z";

describe("the submitter's local date, not UTC's", () => {
  test("the two fixture instants really do straddle midnight in opposite directions", () => {
    // If this ever stops being true the rest of the file proves nothing.
    assert.equal(localDate(new Date(LA_EVENING), "UTC"), "2026-08-19");
    assert.equal(localDate(new Date(LA_EVENING), LA), "2026-08-18");
    assert.equal(localDate(new Date(NZ_MORNING), "UTC"), "2026-08-19");
    assert.equal(localDate(new Date(NZ_MORNING), NZ), "2026-08-20");
  });

  test("westward: 'today' is the local day, a day BEHIND UTC's", () => {
    const today = localDate(new Date(LA_EVENING), LA);
    assert.equal(resolveDateToken("today", today), "2026-08-18");
    assert.notEqual(resolveDateToken("today", today), "2026-08-19");
  });

  test("eastward: 'today' is the local day, a day AHEAD of UTC's", () => {
    const today = localDate(new Date(NZ_MORNING), NZ);
    assert.equal(resolveDateToken("today", today), "2026-08-20");
    assert.notEqual(resolveDateToken("today", today), "2026-08-19");
  });

  test("westward: 'yesterday' lands on the 17th, which UTC would call the 18th", () => {
    assert.equal(resolveDateToken("yesterday", localDate(new Date(LA_EVENING), LA)), "2026-08-17");
  });

  test("eastward: 'yesterday' lands on the 19th, which UTC would call the 18th", () => {
    assert.equal(resolveDateToken("yesterday", localDate(new Date(NZ_MORNING), NZ)), "2026-08-19");
  });

  test("a bare weekday looks BACKWARD from the local day, and the direction matters", () => {
    // LA's local day IS Tuesday the 18th, so "tuesday" is today.
    assert.equal(weekdayOf("2026-08-18"), 2);
    assert.equal(resolveDateToken("tuesday", "2026-08-18"), "2026-08-18");
    // Resolved off UTC's Wednesday the 19th it would have been the 18th too —
    // so the distinguishing case is Monday, a whole week apart.
    assert.equal(resolveDateToken("wednesday", "2026-08-18"), "2026-08-12");
    assert.equal(resolveDateToken("wednesday", "2026-08-19"), "2026-08-19");
  });

  test("eastward, a bare weekday is a full week off if UTC is used", () => {
    // NZ local: Thursday 2026-08-20. UTC: Wednesday 2026-08-19.
    assert.equal(weekdayOf("2026-08-20"), 4);
    assert.equal(resolveDateToken("thursday", "2026-08-20"), "2026-08-20");
    assert.equal(resolveDateToken("thursday", "2026-08-19"), "2026-08-13");
  });

  test("'last <weekday>' on that weekday goes back a week; 'next' goes forward", () => {
    assert.equal(resolveDateToken("last tuesday", "2026-08-18"), "2026-08-11");
    assert.equal(resolveDateToken("this tuesday", "2026-08-18"), "2026-08-18");
    assert.equal(resolveDateToken("next tuesday", "2026-08-18"), "2026-08-25");
    assert.equal(resolveDateToken("next friday", "2026-08-18"), "2026-08-21");
  });

  test("an explicit date passes through; an impossible one is refused, not rolled over", () => {
    assert.equal(resolveDateToken("2026-03-01", "2026-08-18"), "2026-03-01");
    assert.equal(resolveDateToken("2026-13-45", "2026-08-18"), null);
    assert.equal(resolveDateToken("2026-02-30", "2026-08-18"), null);
    assert.equal(resolveDateToken("thursdayish", "2026-08-18"), null);
    assert.equal(resolveDateToken("", "2026-08-18"), null);
  });

  test("instantFor round-trips a local wall clock through both zones, DST included", () => {
    // 09:00 local on a summer day and on a winter day: different UTC offsets,
    // same local reading. A fixed-offset implementation fails one of the two.
    for (const [zone, summer, winter] of [
      [LA, "2026-08-18", "2026-01-14"],
      [NZ, "2026-01-14", "2026-08-18"],
    ]) {
      for (const day of [summer, winter]) {
        const i = instantFor(day, 9, 0, zone);
        assert.equal(localDate(i, zone), day, `${zone} ${day}`);
      }
    }
    // ...and the summer/winter offsets genuinely differ, so the loop was a test.
    assert.notEqual(
      instantFor("2026-08-18", 9, 0, LA).getTime() % 86400000,
      instantFor("2026-01-14", 9, 0, LA).getTime() % 86400000,
    );
  });

  test("an unknown zone degrades to UTC instead of throwing", () => {
    assert.equal(safeZone("Mars/Olympus"), "UTC");
    assert.equal(safeZone(""), "UTC");
    assert.equal(safeZone(undefined), "UTC");
    assert.equal(safeZone(LA), LA);
  });

  test("addDays crosses a month and a year boundary", () => {
    assert.equal(addDays("2026-08-31", 1), "2026-09-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  });
});

/* ============================================== LAYER B: resolveActivity == */

/** The JSON a model should return for the criterion sentence. */
const COVENTRY_REPLY = JSON.stringify({
  kind: "call",
  outcome: "wants a quote",
  note: "Called Mike at Coventry; he wants a quote by Friday.",
  date: "tuesday",
  time: null,
  event: true,
});

describe("Layer B — the model's reply becomes a row", () => {
  test("the criterion sentence: kind call, that Tuesday, and a note keeping 'quote'", () => {
    const now = new Date(LA_EVENING); // LA local Tuesday 2026-08-18, UTC Wed the 19th
    const out = resolveActivity(COVENTRY_REPLY, {
      now,
      timeZone: LA,
      rawText: "called Mike at Coventry Tuesday, wants a quote by Friday",
    });
    assert.equal(out.ok, true, JSON.stringify(out.failure));
    assert.equal(out.parsed.kind, "call");
    assert.match(out.parsed.note, /quote/);
    // On that Tuesday — read back in the SUBMITTER's zone, which is the claim.
    assert.equal(localDate(new Date(out.parsed.occurredAt), LA), "2026-08-18");
    assert.equal(weekdayOf(localDate(new Date(out.parsed.occurredAt), LA)), 2);
  });

  test("the same reply an hour earlier in NZ still lands on ITS local Tuesday", () => {
    // NZ local Tuesday is 2026-08-18 at 2026-08-18T02:00Z (UTC still Monday).
    const now = new Date("2026-08-18T02:00:00.000Z");
    assert.equal(localDate(now, "UTC"), "2026-08-18");
    assert.equal(localDate(now, NZ), "2026-08-18");
    const out = resolveActivity(COVENTRY_REPLY, { now, timeZone: NZ, rawText: "x" });
    assert.equal(out.ok, true);
    assert.equal(localDate(new Date(out.parsed.occurredAt), NZ), "2026-08-18");
  });

  test("a past day with no time gets local noon, not midnight — the day survives the zone", () => {
    const reply = JSON.stringify({ kind: "call", note: "n", date: "2026-08-11", event: true });
    for (const zone of [LA, NZ, "UTC"]) {
      const out = resolveActivity(reply, { now: new Date(LA_EVENING), timeZone: zone, rawText: "x" });
      assert.equal(out.ok, true);
      assert.equal(localDate(new Date(out.parsed.occurredAt), zone), "2026-08-11", zone);
    }
  });

  test("an explicit time is honoured in the submitter's zone", () => {
    const reply = JSON.stringify({ kind: "meeting", note: "n", date: "2026-08-11", time: "08:30", event: true });
    const out = resolveActivity(reply, { now: new Date(LA_EVENING), timeZone: LA, rawText: "x" });
    assert.equal(out.ok, true);
    assert.equal(out.parsed.occurredAt, instantFor("2026-08-11", 8, 30, LA).toISOString());
  });

  test("no date at all means today, in the submitter's zone", () => {
    const reply = JSON.stringify({ kind: "note", note: "n", date: null, event: true });
    const out = resolveActivity(reply, { now: new Date(LA_EVENING), timeZone: LA, rawText: "x" });
    assert.equal(out.ok, true);
    // Today keeps the actual submit instant, not a synthesised noon.
    assert.equal(out.parsed.occurredAt, LA_EVENING);
    assert.equal(localDate(new Date(out.parsed.occurredAt), LA), "2026-08-18");
  });

  test("JSON wrapped in prose or a code fence is still read", () => {
    const out = resolveActivity("Sure!\n```json\n" + COVENTRY_REPLY + "\n```\nHope that helps.", {
      now: new Date(LA_EVENING),
      timeZone: LA,
      rawText: "x",
    });
    assert.equal(out.ok, true);
    assert.equal(out.parsed.kind, "call");
  });

  test("an empty note falls back to the person's own words, never to blank", () => {
    const reply = JSON.stringify({ kind: "note", note: "   ", date: null, event: true });
    const out = resolveActivity(reply, {
      now: new Date(LA_EVENING),
      timeZone: LA,
      rawText: "  swung by the shop  ",
    });
    assert.equal(out.ok, true);
    assert.equal(out.parsed.note, "swung by the shop");
  });

  test("a runaway note and outcome are capped", () => {
    const reply = JSON.stringify({ kind: "note", note: "z".repeat(9000), outcome: "y".repeat(900), event: true });
    const out = resolveActivity(reply, { now: new Date(LA_EVENING), timeZone: LA, rawText: "x" });
    assert.equal(out.ok, true);
    assert.equal(out.parsed.note.length, MAX_NOTE_CHARS);
    assert.equal(out.parsed.outcome.length, 200);
  });

  describe("typed failures", () => {
    const cases = [
      ["not JSON at all", "I'm not sure what you mean.", "no_json"],
      ["a JSON array", "[1,2,3]", "no_json"],
      ["broken JSON", "{ kind: call, ", "no_json"],
      ["event: false", JSON.stringify({ event: false }), "no_event"],
      ["no kind", JSON.stringify({ note: "hi", event: true }), "no_event"],
      ["a kind that is not a kind", JSON.stringify({ kind: "vibes", event: true }), "bad_kind"],
      ["an unreadable date", JSON.stringify({ kind: "call", date: "sometime", event: true }), "bad_date"],
    ];
    for (const [label, reply, reason] of cases) {
      test(`${label} → ${reason}`, () => {
        const out = resolveActivity(reply, { now: new Date(LA_EVENING), timeZone: LA, rawText: "x" });
        assert.equal(out.ok, false, `${label} was accepted`);
        assert.equal(out.failure.reason, reason);
        assert.ok(out.failure.message.length > 5);
      });
    }

    test("the three agent kinds are a parse failure, never a proposal", () => {
      for (const kind of ["ai_email_sent", "ai_email_reply", "agent_run"]) {
        const out = resolveActivity(JSON.stringify({ kind, note: "n", event: true }), {
          now: new Date(LA_EVENING),
          timeZone: LA,
          rawText: "x",
        });
        assert.equal(out.ok, false, `${kind} was proposed`);
        assert.equal(out.failure.reason, "bad_kind");
      }
    });
  });
});

/* ============================================= LAYER A: the verb wiring == */

describe("Layer A — log_activity's parse path", () => {
  test("sends the RAW text and the caller's timezone to the runner", async () => {
    const runner = stubRunner(COVENTRY_REPLY);
    const text = "called Mike at Coventry Tuesday, wants a quote by Friday";
    const r = await log_activity.run(
      { caller: MEMBER, db: fakeDb(fixture()), runParse: runner.run, now: at(LA_EVENING) },
      { accountId: ACCT, text, timeZone: LA },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(runner.prompts.length, 1);
    const prompt = runner.prompts[0];
    assert.ok(prompt.includes(text), "the raw text never reached the runner");
    assert.ok(prompt.includes(LA), "the submitter's timezone never reached the runner");
    // The submitter's LOCAL date, not the server's — the prompt is where the
    // model learns what "Tuesday" is relative to.
    assert.ok(prompt.includes("2026-08-18"), "the prompt carried the wrong local date");
    assert.ok(!prompt.includes("2026-08-19"), "the prompt carried the UTC date");
  });

  test("the parse path PROPOSES and writes NO row", async () => {
    const tables = fixture();
    const before = tables.account_activity.length;
    const db = fakeDb(tables);
    const r = await log_activity.run(
      { caller: MEMBER, db, runParse: stubRunner(COVENTRY_REPLY).run, now: at(LA_EVENING) },
      { accountId: ACCT, text: "called Mike at Coventry Tuesday, wants a quote by Friday", timeZone: LA },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.written, false);
    assert.equal(r.data.proposal.kind, "call");
    assert.match(r.data.proposal.note, /quote/);
    assert.equal(localDate(new Date(r.data.proposal.occurredAt), LA), "2026-08-18");
    // The negative side effect, on the real store the verb writes to...
    assert.equal(tables.account_activity.length, before, "the parse path wrote a row");
    // ...and no insert was even attempted.
    assert.equal(db.calls.filter((c) => c.ops.some((o) => o[0] === "insert")).length, 0);
  });

  test("text with no recognisable event is a typed parse_failure and writes no row", async () => {
    const tables = fixture();
    const before = tables.account_activity.length;
    const db = fakeDb(tables);
    const r = await log_activity.run(
      {
        caller: MEMBER,
        db,
        runParse: stubRunner(JSON.stringify({ event: false })).run,
        now: at(LA_EVENING),
      },
      { accountId: ACCT, text: "asdkjh qwe zzz", timeZone: LA },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "parse_failure");
    assert.equal(tables.account_activity.length, before, "a failed parse wrote a row");
    assert.equal(db.calls.filter((c) => c.ops.some((o) => o[0] === "insert")).length, 0);
  });

  test("a runner that fails is a parse_failure, not a crash, and writes no row", async () => {
    const tables = fixture();
    const before = tables.account_activity.length;
    const r = await log_activity.run(
      {
        caller: MEMBER,
        db: fakeDb(tables),
        runParse: stubRunner({ ok: false, error: "agent timed out after 45000ms" }).run,
        now: at(LA_EVENING),
      },
      { accountId: ACCT, text: "called Mike", timeZone: LA },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "parse_failure");
    assert.match(r.error.message, /timed out/);
    assert.equal(tables.account_activity.length, before);
  });

  test("no runner injected is not_configured — never a silent write", async () => {
    const tables = fixture();
    const r = await log_activity.run(
      { caller: MEMBER, db: fakeDb(tables) },
      { accountId: ACCT, text: "called Mike", timeZone: LA },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_configured");
    assert.equal(tables.account_activity.length, 1);
  });

  test("a clientId is resolved to ITS account, matched by id and not by position", async () => {
    const tables = fixture();
    const r = await log_activity.run(
      { caller: MEMBER, db: fakeDb(tables), runParse: stubRunner(COVENTRY_REPLY).run, now: at(LA_EVENING) },
      { clientId: CLIENT, text: "called Mike", timeZone: LA },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.data.accountId, ACCT, "resolved to the wrong client's account");
  });

  test("an unknown client is not_found; neither id given is invalid_input", async () => {
    const db = () => fakeDb(fixture());
    const missing = await log_activity.run(
      { caller: MEMBER, db: db(), runParse: stubRunner(COVENTRY_REPLY).run },
      { clientId: "44444444-4444-4444-8444-444444444444", text: "hi" },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "not_found");

    const neither = await log_activity.run(
      { caller: MEMBER, db: db(), runParse: stubRunner(COVENTRY_REPLY).run },
      { text: "hi" },
    );
    assert.equal(neither.ok, false);
    assert.equal(neither.error.code, "invalid_input");
  });
});

/* ======================================== the write path, after approval == */

describe("log_activity's write path", () => {
  test("writes exactly one row with occurred_at, outcome, and the CALLER's email", async () => {
    const tables = fixture();
    const before = tables.account_activity.length;
    const when = instantFor("2026-08-18", 14, 0, LA).toISOString();
    const r = await log_activity.run(
      { caller: MEMBER, db: fakeDb(tables), now: at(LA_EVENING) },
      {
        accountId: ACCT,
        kind: "call",
        note: "Spoke to Mike about the quote",
        outcome: "wants a quote",
        occurredAt: when,
        // A forged author in the payload must be ignored entirely.
        actorEmail: "boss@bcn-services.com",
      },
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.account_activity.length, before + 1);
    const row = tables.account_activity.find((a) => a.note === "Spoke to Mike about the quote");
    assert.ok(row, "the row was not written");
    assert.equal(row.kind, "call");
    assert.equal(row.account_id, ACCT);
    assert.equal(row.outcome, "wants a quote");
    assert.equal(row.occurred_at, when);
    assert.equal(row.actor_email, MEMBER.email, "actor_email was not the authenticated caller");
  });

  test("an unparseable occurredAt is refused rather than written as now", async () => {
    const tables = fixture();
    const r = await log_activity.run(
      { caller: MEMBER, db: fakeDb(tables) },
      { accountId: ACCT, kind: "call", note: "n", occurredAt: "last thursday" },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_input");
    assert.equal(tables.account_activity.length, 1);
  });
});

/* ================================= the confirmation step, as pure state == */

describe("the capture box's confirmation step", () => {
  const target = { accountId: ACCT };
  const proposal = {
    kind: "call",
    outcome: "wants a quote",
    occurredAt: instantFor("2026-08-18", 14, 0, LA).toISOString(),
    note: "Called Mike at Coventry; he wants a quote by Friday.",
  };

  const composed = (text) => captureReducer(emptyCapture(), { type: "type", text });

  test("compose alone can produce NO commit payload — confirmation is the only path", () => {
    assert.equal(commitPayload(emptyCapture(), target), null);
    assert.equal(commitPayload(composed("called Mike"), target), null);
  });

  test("a parse moves to confirm and seeds every field from the proposal", () => {
    const s = captureReducer(composed("called Mike"), { type: "parsed", proposal });
    assert.equal(s.step, "confirm");
    assert.equal(s.draft.kind, "call");
    assert.equal(s.draft.outcome, "wants a quote");
    assert.equal(s.draft.note, proposal.note);
    assert.equal(draftDateLocal(s.draft, LA), "2026-08-18");
  });

  test("what is submitted is the EDITED draft, not the parsed proposal", () => {
    let s = captureReducer(composed("called Mike"), { type: "parsed", proposal });
    s = captureReducer(s, { type: "edit", field: "kind", value: "meeting" });
    s = captureReducer(s, { type: "edit", field: "note", value: "Met Mike on site; quote by Friday." });
    s = captureReducer(s, { type: "edit", field: "outcome", value: "site visit booked" });
    s = captureReducer(s, { type: "edit_date", value: "2026-08-17", timeZone: LA });

    const payload = commitPayload(s, target);
    assert.equal(payload.kind, "meeting");
    assert.equal(payload.note, "Met Mike on site; quote by Friday.");
    assert.equal(payload.outcome, "site visit booked");
    assert.equal(payload.accountId, ACCT);
    // The edited DAY, in the submitter's zone...
    assert.equal(localDate(new Date(payload.occurredAt), LA), "2026-08-17");
    // ...and the time of day the parse found survived the day change.
    assert.equal(payload.occurredAt, instantFor("2026-08-17", 14, 0, LA).toISOString());
    // Nothing of the proposal leaked through.
    assert.notEqual(payload.kind, proposal.kind);
    assert.notEqual(payload.note, proposal.note);
    assert.notEqual(payload.occurredAt, proposal.occurredAt);
  });

  test("the edited payload is what actually reaches the database", async () => {
    let s = captureReducer(composed("called Mike"), { type: "parsed", proposal });
    s = captureReducer(s, { type: "edit", field: "kind", value: "meeting" });
    s = captureReducer(s, { type: "edit", field: "note", value: "Met Mike on site." });
    const payload = commitPayload(s, target);

    const tables = fixture();
    const before = tables.account_activity.length;
    const r = await log_activity.run({ caller: MEMBER, db: fakeDb(tables) }, payload);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(tables.account_activity.length, before + 1, "not exactly one row");
    const row = tables.account_activity.find((a) => a.note === "Met Mike on site.");
    assert.ok(row, "the edited note is not what was written");
    assert.equal(row.kind, "meeting");
    assert.equal(row.actor_email, MEMBER.email);
    // The parsed values are nowhere in the table.
    assert.equal(tables.account_activity.filter((a) => a.note === proposal.note).length, 0);
  });

  test("a parse failure keeps the raw text for manual entry — it is never dropped", () => {
    const raw = "swung by, told them we'd call back";
    const s = captureReducer(composed(raw), {
      type: "parse_failed",
      message: "no contact event was described in that text",
      now: new Date(LA_EVENING),
    });
    assert.equal(s.step, "confirm", "a failure must still offer manual entry");
    assert.equal(s.draft.note, raw, "the person's own words were dropped");
    assert.match(s.message, /no contact event/);
    // And it is still committable by hand, with whatever they correct.
    const payload = commitPayload(captureReducer(s, { type: "edit", field: "kind", value: "call" }), target);
    assert.equal(payload.kind, "call");
    assert.equal(payload.note, raw);
  });

  test("manualDraft never invents a kind other than 'note'", () => {
    const d = manualDraft("  hi  ", new Date(LA_EVENING));
    assert.equal(d.kind, "note");
    assert.equal(d.note, "hi");
    assert.equal(d.outcome, "");
  });

  test("cancel returns to compose with the text intact and no draft", () => {
    let s = captureReducer(composed("called Mike"), { type: "parsed", proposal });
    s = captureReducer(s, { type: "cancel" });
    assert.equal(s.step, "compose");
    assert.equal(s.text, "called Mike");
    assert.equal(s.draft, null);
    assert.equal(commitPayload(s, target), null);
  });

  test("a successful commit clears the box, so the same call cannot be logged twice", () => {
    let s = captureReducer(composed("called Mike"), { type: "parsed", proposal });
    s = captureReducer(s, { type: "committed" });
    assert.equal(s.step, "compose");
    assert.equal(s.text, "");
    assert.equal(commitPayload(s, target), null);
  });

  test("a failed commit keeps the draft so nothing typed is lost", () => {
    let s = captureReducer(composed("called Mike"), { type: "parsed", proposal });
    s = captureReducer(s, { type: "committing" });
    s = captureReducer(s, { type: "commit_failed", message: "You do not have permission." });
    assert.equal(s.step, "confirm");
    assert.equal(s.busy, false);
    assert.equal(s.draft.note, proposal.note);
    assert.match(s.message, /permission/);
  });

  test("a half-typed date is ignored rather than corrupting the instant", () => {
    let s = captureReducer(composed("called Mike"), { type: "parsed", proposal });
    for (const bad of ["", "2026-0", "not-a-date"]) {
      s = captureReducer(s, { type: "edit_date", value: bad, timeZone: LA });
      assert.equal(s.draft.occurredAt, proposal.occurredAt, bad);
    }
  });
});

/* ------------------------------------------------------ prompt building -- */

describe("buildParsePrompt", () => {
  test("names every kind a person may log and none a person may not", () => {
    const p = buildParsePrompt({ text: "x", timeZone: LA, todayLocal: "2026-08-18" });
    for (const k of ["call", "email", "meeting", "note", "status_change"]) {
      assert.ok(p.includes(k), `prompt omits ${k}`);
    }
    for (const k of ["ai_email_sent", "ai_email_reply", "agent_run"]) {
      assert.ok(!p.includes(k), `prompt offers the reserved kind ${k}`);
    }
  });

  test("withLocalDate keeps the time of day when the day changes", () => {
    const iso = instantFor("2026-08-18", 14, 30, LA).toISOString();
    assert.equal(withLocalDate(iso, "2026-08-11", LA), instantFor("2026-08-11", 14, 30, LA).toISOString());
  });
});
