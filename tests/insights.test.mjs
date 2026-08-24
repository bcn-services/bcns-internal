/**
 * insights.test.mjs — lib/insights.ts against literals.
 *
 * Every function here is pure, so there is no database fake: the inputs are
 * written out and the boundaries are the whole point. The date maths must land
 * exactly on its edges, and money must never become a float on the way to the
 * screen.
 *
 * Split out of the former manual-layer.test.mjs when the project-manual layer
 * was removed with the /projects, /notes and /insights routes. lib/insights.ts
 * survived that cut because /chat still uses funnelCounts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayWindow, activityByDay, funnelCounts, buildKpis, centsToWholeDollars, WINDOW_DAYS,
} from "../lib/insights.ts";

test("dayWindow is the last N days, oldest first, inclusive of today", () => {
  const days = dayWindow("2026-03-02", 4);
  assert.deepEqual(days, ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  assert.equal(dayWindow("2026-08-19").length, WINDOW_DAYS);
  assert.throws(() => dayWindow("19/08/2026"), /not a YYYY-MM-DD date/);
});

test("activity outside the window is dropped, not folded into the first day", () => {
  const series = activityByDay([
    { occurred_at: "2026-03-02T10:00:00Z" },
    { occurred_at: "2026-03-02T18:00:00Z" },
    { occurred_at: "2026-02-27T09:00:00Z" },
    // Older than the window: clamping this into day one would draw a spike
    // that never happened.
    { occurred_at: "2025-01-01T09:00:00Z" },
  ], "2026-03-02", 4);
  assert.deepEqual(series, [
    { day: "2026-02-27", count: 1 },
    { day: "2026-02-28", count: 0 },
    { day: "2026-03-01", count: 0 },
    { day: "2026-03-02", count: 2 },
  ]);
});

test("funnelCounts reports every stage, including the empty ones", () => {
  const counts = funnelCounts(
    [{ status: "won" }, { status: "won" }, { status: "new" }, { status: "bogus" }],
    ["new", "won", "lost"]);
  assert.deepEqual(counts, [
    { stage: "new", count: 1 }, { stage: "won", count: 2 }, { stage: "lost", count: 0 },
  ]);
});

test("MRR counts active clients only", () => {
  const kpis = buildKpis({
    accounts: [],
    clients: [
      { status: "active", monthly_rate_cents: 15000 },
      { status: "onboarding", monthly_rate_cents: 20000 },
      { status: "paused", monthly_rate_cents: 30000 },
    ],
    activity: [], today: "2026-08-19", overdueProjects: 0, activeProjects: 0,
  });
  const clientsKpi = kpis.find((k) => k.label === "Active clients");
  assert.equal(clientsKpi.value, "1", "onboarding and paused are not paying");
  assert.equal(clientsKpi.detail, "$150 per month");
});

test("a pipeline with no deal values says so instead of showing $0", () => {
  const kpis = buildKpis({
    accounts: [{ status: "reached", deal_value_cents: null, created_at: "2026-08-01" }],
    clients: [], activity: [], today: "2026-08-19", overdueProjects: 0, activeProjects: 0,
  });
  const pipeline = kpis.find((k) => k.label === "Open pipeline");
  assert.equal(pipeline.value, "1");
  assert.match(pipeline.detail, /no deal values recorded/);
});

test("money never becomes a float on the way to the screen", () => {
  assert.equal(centsToWholeDollars(150000), "$1,500");
  assert.equal(centsToWholeDollars(0), "$0");
});
