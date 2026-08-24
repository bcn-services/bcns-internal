/**
 * insights.ts — the numbers the dashboard reports.
 *
 * NOT a faithful port of project-dashboard's src/lib/insights.ts. That file
 * built its KPIs from git commit dates, Claude session logs and a token ledger,
 * all read off one laptop. This is a company application on a server: it has no
 * laptop to read, and Claude token accounting is not a bcns metric.
 *
 * So the shape is kept — KPIs, a rolling window, a momentum series — and the
 * inputs are changed to what this system actually owns: the funnel in Postgres,
 * the contact history, and the project board.
 *
 * Every function here is pure and takes its data and its clock as arguments, so
 * a boundary (a deal closed exactly 14 days ago) is testable.
 */

import type { Stage } from "./accounts";

/** The rolling window every rate and series below is computed over. */
export const WINDOW_DAYS = 14;

/** Stages that mean the deal is still live. Anything else has left the funnel. */
export const OPEN_STAGES: readonly Stage[] = [
  "new", "attempted", "reached", "consult_scheduled", "consult_done",
];

export interface ActivityPoint {
  /** ISO timestamp of the contact. */
  occurred_at: string;
}

export interface AccountPoint {
  status: string;
  deal_value_cents: number | null;
  created_at: string;
}

export interface ClientPoint {
  status: string;
  monthly_rate_cents: number | null;
}

export interface Kpi {
  label: string;
  value: string;
  /** Plain-language sub-line. Never a fabricated trend. */
  detail: string;
}

export interface InsightsData {
  kpis: Kpi[];
  /** One count per day, oldest first, `WINDOW_DAYS` long. */
  activityByDay: { day: string; count: number }[];
  funnel: { stage: string; count: number }[];
}

/**
 * The last `n` calendar days ending on `today`, oldest first, as YYYY-MM-DD.
 *
 * Built by subtracting whole days from a UTC midnight, so a run during a
 * daylight-saving shift cannot produce a duplicated or missing day.
 */
export function dayWindow(today: string, n: number = WINDOW_DAYS): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(end)) throw new Error(`dayWindow: not a YYYY-MM-DD date: ${today}`);
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

/** Integer cents → a whole-dollar display string. Money never becomes a float. */
export function centsToWholeDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * Count contacts per day across the window.
 *
 * Activity outside the window is dropped rather than clamped into the first
 * bucket, which would draw a spike that never happened.
 */
export function activityByDay(
  activity: ActivityPoint[],
  today: string,
  n: number = WINDOW_DAYS,
): { day: string; count: number }[] {
  const days = dayWindow(today, n);
  const counts = new Map(days.map((d) => [d, 0]));
  for (const a of activity) {
    const day = a.occurred_at.slice(0, 10);
    const seen = counts.get(day);
    if (seen !== undefined) counts.set(day, seen + 1);
  }
  return days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}

/** How many accounts sit in each stage, in funnel order. */
export function funnelCounts(
  accounts: AccountPoint[],
  stages: readonly string[],
): { stage: string; count: number }[] {
  const counts = new Map(stages.map((s) => [s, 0]));
  for (const a of accounts) {
    const seen = counts.get(a.status);
    if (seen !== undefined) counts.set(a.status, seen + 1);
  }
  return stages.map((stage) => ({ stage, count: counts.get(stage) ?? 0 }));
}

/**
 * The headline numbers.
 *
 * Monthly recurring revenue counts ACTIVE clients only. An onboarding client is
 * not yet paying and a paused one has stopped, so folding either in overstates
 * revenue — the one number nobody should have to caveat.
 */
export function buildKpis(input: {
  accounts: AccountPoint[];
  clients: ClientPoint[];
  activity: ActivityPoint[];
  today: string;
  overdueProjects: number;
  activeProjects: number;
}): Kpi[] {
  const open = input.accounts.filter((a) => (OPEN_STAGES as readonly string[]).includes(a.status));
  const openValue = open.reduce((sum, a) => sum + (a.deal_value_cents ?? 0), 0);

  const activeClients = input.clients.filter((c) => c.status === "active");
  const mrr = activeClients.reduce((sum, c) => sum + (c.monthly_rate_cents ?? 0), 0);

  const window = new Set(dayWindow(input.today));
  const recent = input.activity.filter((a) => window.has(a.occurred_at.slice(0, 10))).length;

  return [
    {
      label: "Open pipeline",
      value: String(open.length),
      detail: openValue > 0
        ? `${centsToWholeDollars(openValue)} of named deal value`
        : "no deal values recorded yet",
    },
    {
      label: "Active clients",
      value: String(activeClients.length),
      detail: mrr > 0 ? `${centsToWholeDollars(mrr)} per month` : "no monthly rates recorded yet",
    },
    {
      label: `Contacts, ${WINDOW_DAYS}d`,
      value: String(recent),
      detail: recent === 0 ? "nobody has been contacted in this window" : "calls, emails and meetings logged",
    },
    {
      label: "Projects",
      value: String(input.activeProjects),
      detail: input.overdueProjects > 0
        ? `${input.overdueProjects} past their due date`
        : "none past their due date",
    },
  ];
}
