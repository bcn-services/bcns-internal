/**
 * admin.ts — the data layer behind /admin's four configuration panels.
 *
 * Same contract as lib/profiles.ts and lib/accounts.ts: every function takes an
 * INJECTED Supabase client, reads no env, imports no `server-only`, and
 * constructs nothing. That is what lets tests/admin-surface.test.mjs drive the
 * real code paths with a fake db and with real Postgres.
 *
 * AUTHORIZATION IS NOT HERE, AND THAT IS DELIBERATE — but it IS in two places.
 * The route is gated by lib/auth.ts (`/admin` forbids a non-admin, and the
 * middleware turns that into a 403, not a redirect). The database is gated by
 * 0009's `lead_targets_admin_all` and 0004's `profiles_admin_all`, so every
 * write below goes through the VIEWER'S OWN cookie-bound client and a member
 * who reached this code anyway is refused by Postgres. Nothing here uses the
 * service role. The one exception is the token panel, which reads
 * `agent_tokens` through lib/agent/tokens.ts because that table has no
 * policies at all — and that read never selects `sealed`.
 *
 * DEACTIVATION IS A FLAG FLIP. There is no delete in this file, of anything,
 * ever. A target that pointed the machine at Rye last spring is evidence about
 * where the leads in the database came from; deleting it would destroy that
 * without touching a single lead, which is the worst of both.
 */

import { InvalidInputError, isUuid } from "./accounts";
// The leaf, not lib/agent/tokens.ts — that file imports `server-only`, which
// throws under plain node and would make this whole module untestable.
import { EXPIRY_WARNING_DAYS } from "./agent/tokens-expiry";

export { EXPIRY_WARNING_DAYS };

/** Structural shape of the query builder used here — see lib/accounts.ts. */
interface Result<T> {
  data: T | null;
  error: { message: string } | null;
}
type Client_ = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
};

/* -------------------------------------------------------- lead targets -- */

export interface LeadTargetRow {
  id: string;
  trade: string;
  town: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
}

const TARGET_COLUMNS = "id, trade, town, active, created_by, created_at";

/**
 * Every target, active first, then newest.
 *
 * Deactivated ones are LISTED, not hidden: the whole reason `active` is a flag
 * rather than a delete is so somebody can see that a market was tried, and a
 * list that hides them is a delete with extra steps.
 */
export async function listLeadTargets(db: Client_): Promise<LeadTargetRow[]> {
  const res: Result<LeadTargetRow[]> = await db
    .from("lead_targets")
    .select(TARGET_COLUMNS)
    .order("active", { ascending: false })
    .order("created_at", { ascending: false });
  if (res.error) throw new Error(`listLeadTargets: ${res.error.message}`);
  return res.data ?? [];
}

/**
 * Trim and reject an empty trade or town.
 *
 * The column is `not null` but not `not empty`, so " " would satisfy the
 * schema and give the sweep a target it can never search. This is a trust
 * boundary — the values come from a form — so it validates rather than
 * assuming.
 */
function required(label: string, raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new InvalidInputError(`${label} is required.`);
  if (value.length > 120) throw new InvalidInputError(`${label} is too long.`);
  return value;
}

export async function addLeadTarget(
  db: Client_,
  input: { trade: unknown; town: unknown; createdBy?: string | null },
): Promise<LeadTargetRow> {
  const trade = required("Trade", input.trade);
  const town = required("Town", input.town);
  const createdBy = input.createdBy ?? null;
  if (createdBy !== null && !isUuid(createdBy)) {
    throw new InvalidInputError(`bad profile id: ${createdBy}`);
  }

  const res: Result<LeadTargetRow> = await db
    .from("lead_targets")
    .insert({ trade, town, active: true, created_by: createdBy })
    .select(TARGET_COLUMNS)
    .single();
  if (res.error) throw new Error(`addLeadTarget: ${res.error.message}`);
  return res.data as LeadTargetRow;
}

/**
 * Turn a target on or off. THE ONLY WRITE THE DEACTIVATE CONTROL MAKES.
 *
 * `lib/outreach.ts`'s sweep already reads `.eq("active", true)`, so flipping
 * this flag is the whole of "the sweep skips it" — there is no second list to
 * keep in step. And no account references `lead_targets` at all: there is no
 * foreign key, so there is no cascade to get wrong and the leads a target
 * produced are untouched by construction, not by care.
 */
export async function setLeadTargetActive(
  db: Client_,
  id: string,
  active: boolean,
): Promise<void> {
  if (!isUuid(id)) throw new InvalidInputError(`bad lead target id: ${id}`);
  const res: Result<unknown> = await db
    .from("lead_targets")
    .update({ active })
    .eq("id", id);
  if (res.error) throw new Error(`setLeadTargetActive: ${res.error.message}`);
}

/* -------------------------------------------------------- job function -- */

/** 0009's CHECK, in TypeScript. Null is a value: "nobody has decided yet". */
export const JOB_FUNCTIONS = ["developer", "sales", "ops"] as const;
export type JobFunction = (typeof JOB_FUNCTIONS)[number];

/**
 * Narrow a form field to a job function, or null.
 *
 * "" is what an unselected <select> posts, and it means null — the same thing
 * 0009 means by a null column, and the thing lib/agent/skills.ts reads as "no
 * function, so no member-gated buttons". Anything else is rejected rather than
 * coerced, because coercing an unknown value to a real function would GRANT
 * buttons on bad input.
 */
export function asJobFunctionInput(raw: unknown): JobFunction | null {
  if (raw === "" || raw === null || raw === undefined) return null;
  if (typeof raw === "string" && (JOB_FUNCTIONS as readonly string[]).includes(raw)) {
    return raw as JobFunction;
  }
  throw new InvalidInputError(`Unknown job function: ${String(raw)}`);
}

/**
 * Set (or clear) what kind of work somebody does.
 *
 * job_function IS NOT A ROLE and this write does not touch one. Role lives in
 * `app_metadata` on the JWT and is settable only through the service-role
 * Admin API; this column decides which skill buttons a page bothers to render
 * and nothing else. It is deliberately absent from every RLS policy and from
 * every claim, which is the only reason it is safe for it to be an
 * API-writable column at all — see 0004's note on why `role` is not.
 */
export async function setJobFunction(
  db: Client_,
  profileId: string,
  jobFunction: JobFunction | null,
): Promise<void> {
  if (!isUuid(profileId)) throw new InvalidInputError(`bad profile id: ${profileId}`);
  const res: Result<unknown> = await db
    .from("profiles")
    .update({ job_function: jobFunction })
    .eq("id", profileId);
  if (res.error) throw new Error(`setJobFunction: ${res.error.message}`);
}

/* --------------------------------------------------------- job history -- */

export interface JobRunRecord {
  id: string;
  job: string;
  status: string;
  actor: string | null;
  log: string | null;
  window_key: string | null;
  started_at: string;
  finished_at: string | null;
}

const RUN_COLUMNS = "id, job, status, actor, log, window_key, started_at, finished_at";

/** The most recent runs across every job, newest first. */
export async function listJobRuns(db: Client_, limit = 50): Promise<JobRunRecord[]> {
  const res: Result<JobRunRecord[]> = await db
    .from("job_runs")
    .select(RUN_COLUMNS)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (res.error) throw new Error(`listJobRuns: ${res.error.message}`);
  return res.data ?? [];
}

/**
 * How a run should READ, which is not the same as what it is called.
 *
 * This is the panel-side half of the fix to item 9's conflation. `attention`
 * exists now (lib/agent/skill-run.ts), so the panel does not have to guess
 * from the log whether a `failed` row was a broken job or a healthy one that
 * found a site down — but a `failed` row written BEFORE that change is still
 * in the table and is still ambiguous, and this function does not pretend
 * otherwise. It reports what the row says.
 */
export type RunTone = "ok" | "attention" | "bad" | "neutral";

export function runTone(status: string): RunTone {
  if (status === "ok") return "ok";
  if (status === "attention") return "attention";
  if (status === "failed" || status === "error") return "bad";
  return "neutral"; // running, cancelled, and anything a future job invents.
}

/** The sentence under the status word. One line, no jargon. */
export function runMeaning(status: string): string {
  switch (status) {
    case "ok":
      return "Ran and found nothing to report.";
    case "attention":
      return "Ran fine, and found something worth a look.";
    case "failed":
      return "Did not come back — it threw, hung, or never opened its row.";
    case "error":
      return "Somebody pressed a button and the run was refused.";
    case "cancelled":
      return "Stopped by the person who started it.";
    case "running":
      return "Still going, or died without writing back.";
    default:
      return status;
  }
}

/* -------------------------------------------------------- token status -- */

/**
 * What the token panel is allowed to know. THERE IS NO TOKEN FIELD HERE AND
 * THERE NEVER WILL BE — not the sealed value, not the key id, not a prefix,
 * not a length. Status and expiry date only, per the item's guardrail.
 *
 * `tokenPanelRows` below builds one of these FIELD BY FIELD from whatever it
 * is handed. It never spreads a row, so a caller that hands it an enrollment
 * object carrying extra columns cannot leak them into a prop, a data
 * attribute, or the JSON a server component ships to the client.
 */
export interface TokenPanelRow {
  profileId: string;
  name: string;
  email: string;
  state: "none" | "expired" | "expiring" | "ok";
  /** Days until expiry; negative once past. Null when not enrolled. */
  days: number | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/**
 * Join the staff directory to the enrollment list.
 *
 * Driven by PROFILES, not by enrollments: the interesting row is the employee
 * who has NOT connected a seat, and an enrollment-driven list cannot contain
 * them. `days` is floored the same way lib/agent/tokens.ts floors it, so the
 * two surfaces never disagree by a day.
 */
export function tokenPanelRows(
  profiles: readonly { id: string; display_name: string; email: string }[],
  enrollments: readonly { profileId: string; expiresAt: string; lastUsedAt: string | null }[],
  now: Date = new Date(),
): TokenPanelRow[] {
  const byProfile = new Map(enrollments.map((e) => [e.profileId, e]));

  return profiles.map((p) => {
    const seat = byProfile.get(p.id);
    if (!seat) {
      return {
        profileId: p.id,
        name: p.display_name,
        email: p.email,
        state: "none" as const,
        days: null,
        expiresAt: null,
        lastUsedAt: null,
      };
    }
    const days = Math.floor((Date.parse(seat.expiresAt) - now.getTime()) / 86_400_000);
    return {
      profileId: p.id,
      name: p.display_name,
      email: p.email,
      state: days < 0 ? ("expired" as const) : days <= EXPIRY_WARNING_DAYS ? ("expiring" as const) : ("ok" as const),
      days,
      expiresAt: seat.expiresAt,
      lastUsedAt: seat.lastUsedAt,
    };
  });
}

/**
 * The words for a token state. Blunt on purpose.
 *
 * EXPIRY FAILS LOUDLY AND THERE IS NO FALLBACK. When somebody's token lapses,
 * their jobs stop — the server does not quietly run their work under an
 * admin's seat, because a run attributed to a person that an admin's
 * credential actually paid for is a lie in the audit trail and a standing
 * privilege escalation. The only fix is that person re-enrolling, which only
 * they can do.
 */
export function tokenSummary(row: TokenPanelRow): string {
  switch (row.state) {
    case "none":
      return "No seat connected — their jobs and skill buttons do not run.";
    case "expired":
      return `Expired ${Math.abs(row.days ?? 0)} days ago — their jobs are stopped until they re-enroll.`;
    case "expiring":
      return `Expires in ${row.days} days — their jobs stop that day unless they re-enroll.`;
    case "ok":
      return `Good for ${row.days} more days.`;
  }
}
