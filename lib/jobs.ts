/**
 * jobs.ts — the scheduled-job framework and the three jobs that need no data
 * this database does not already have.
 *
 * A JOB IS A SCRIPT SOMEBODY ELSE CALLS. There is no timer in this file, no
 * `setInterval`, no self-scheduling and no "next run at" column. `scripts/run-job.mjs`
 * is a plain entry point; cron (or systemd, or GitHub Actions) decides when.
 * The cron lines a human would install are in docs/JOBS.md and are installed by
 * a human, because there is no droplet yet. This matters beyond tidiness: a
 * process that schedules itself has to stay alive to keep its promise, and a
 * Next server restarts on every deploy.
 *
 * FOUR PROPERTIES, AND EACH ONE IS A SEAM SOMEBODY COULD GET WRONG.
 *
 * 1. IDEMPOTENT BY CONSTRAINT, NOT BY CONVENTION. `runJob` opens its
 *    `job_runs` row through `claimRun` with a WINDOW KEY — '2026-08-24' for a
 *    daily job, 'w2951' for a weekly one. `job_runs_window_idx` (0014) is
 *    unique on (job, window_key), so a scheduler retry, a catch-up cron and a
 *    human running the script by hand inside the same day all collide on the
 *    index and exactly one of them proceeds. The losers return `ran: false`
 *    and notify nobody. There is no read-then-write anywhere in this file.
 *
 * 2. THE ROW ALWAYS CLOSES. `def.run` is wrapped in a try/catch INSIDE a
 *    timeout race, and `closeRun` is called after it on every path — a throw, a
 *    rejected promise, a hang. A `job_runs` row left `running` with a null
 *    `finished_at` is what `job_runs_unfinished_idx` exists to make visible,
 *    and this framework's job is to never produce one.
 *
 * 3. A FINDING IS `attention`, NOT `failed` — CORRECTED FROM ITEM 9. A sweep
 *    that ran perfectly and found a client's site down did not fail: the
 *    automation is fine and the world is not. Item 9 wrote `failed` for both
 *    because the only lever the rule table gave it was its own status, and
 *    said so in this comment; the fix is the seventh event kind it declined to
 *    add (`job_run_attention`, lib/notify.ts), which emails the admin exactly
 *    as `job_run_failed` does while letting the row say which happened. `failed`
 *    now means only "did not come back" — a throw, a timeout, or a run row that
 *    could never be opened, where the findings are UNKNOWN rather than empty.
 *    A clean run still posts its inbox item, because everything reaches the
 *    inbox.
 *
 * 4. NOTHING REACHES A NETWORK EXCEPT THROUGH AN INJECTED FUNCTION. The health
 *    sweep takes a `SiteFetcher`; the quiet detector takes a `CommitReader`.
 *    Defaults exist for production and are never constructed by a test, which
 *    is why no test in this repo can hit a real client's site.
 *
 * HOW A JOB'S SERVICE-ROLE ACCESS IS BOUNDED. lib/inbox-badge.ts and
 * lib/service-client-mark.ts take a verified VIEWER and build the loader
 * internally, so a caller can never point a service-role read at somebody
 * else's id. A job has no viewer at all, so that pattern does not transfer —
 * and the bound here is a different one, stated plainly:
 *
 *   - A job takes NO id, NO filter and NO profile from any caller. The only
 *     inputs `runJob` accepts are a clock and injected readers. There is no
 *     route, no request body and no query string anywhere in this file, and
 *     `scripts/run-job.mjs` accepts exactly one argument: a job name matched
 *     against the registry below.
 *   - Every read is a WHOLE-TABLE read of internal operational data —
 *     `clients`, `tasks`, `account_activity`, and `agent_tokens`' expiry
 *     metadata. Not one of them is scoped by an argument, so there is no id to
 *     confuse and nothing a caller could widen.
 *   - `agent_tokens` is read for `profile_id, expires_at` and NEVER `sealed`.
 *     The credential job cannot print a token because it never has one.
 *   - Nothing a job reads leaves the server except through
 *     `deliverNotification`, whose recipient is the admin resolved by
 *     lib/notify.ts from configuration — never an address a caller supplied.
 *     Money is never selected in the first place, so `defineVerb`'s stripper
 *     has nothing to remove and no second stripper is written here.
 */

import { claimRun, closeRun, type JobRunStatus } from "./agent/skill-run";
// Item 10's two jobs. This import used to be half of a module cycle, because
// lib/outreach.ts imported `dailyWindow` back out of this file; the windows now
// live in the leaf module below, so the arrow points one way and no reference
// across the boundary depends on being deferred to call time.
import { leadSweepJob, outreachJob, type Evaluator, type SiteReader } from "./outreach";
import { dailyWindow, weeklyWindow, type WindowKey } from "./job-windows";
import { readmeExportJob, type ReadmeExportDeps } from "./os/readme-export";
import { timeoutFetch } from "./fetch-timeout";
import { notifyJobRun, resolveAdmin, type NotifyOutcome, type Recipient } from "./notify";
import { scrub, type Caller, type DbClient } from "./agent/verbs/types";

/* ----------------------------------------------------------------- windows -- */

// Defined in lib/job-windows.ts and re-exported here, which is where every
// caller already imports them from. See that file for why they moved.
export { dailyWindow, weeklyWindow, type WindowKey };

/* -------------------------------------------------------------- definition -- */

/** What a job is handed. No request, no viewer, no caller-supplied anything. */
export interface JobContext {
  /** Service-role. See the bounding note in this file's header. */
  db: DbClient;
  /** Injected, so the 29/31-day tests are deterministic. Never `new Date()`. */
  now: Date;
}

/**
 * What a job hands back.
 *
 * `findings` is the load-bearing half: one line per thing a human has to look
 * at. Empty means clean, which means `job_run_ok`, which means no email. The
 * job does not decide its own status — `runJob` derives it, so no job can
 * report a finding and quietly succeed.
 */
export interface JobResult {
  findings: string[];
  /** Everything the run saw, findings or not. Lands in `job_runs.log`. */
  log: string;
  /** Structured extras for the notification body. Rendered by lib/notify.ts. */
  facts?: Record<string, unknown>;
}

export interface JobDefinition {
  /** `job_runs.job`, `source_job`, and the argument to scripts/run-job.mjs. */
  name: string;
  window: WindowKey;
  /** Human-readable schedule. Documentation only — nothing reads it to act. */
  schedule: string;
  run: (ctx: JobContext) => Promise<JobResult>;
}

/** The default ceiling on a single run. A hung job must fail, not hang. */
export const JOB_TIMEOUT_MS = 5 * 60_000;

/** `job_runs.actor` for a run nobody pressed a button for. */
export const JOB_ACTOR = "scheduler";

export interface JobRunDeps {
  /** Service-role client. Null means the job cannot be idempotent; it refuses. */
  db: DbClient | null;
  now?: () => Date;
  /** Overridable so a test never reads the profile directory. */
  admin?: () => Promise<Recipient>;
  /** Overridable so a test never constructs a mailer. */
  mailer?: Parameters<typeof notifyJobRun>[0]["mailer"];
  timeoutMs?: number;
  actor?: string;
}

export interface JobOutcome {
  job: string;
  windowKey: string;
  /** False when another invocation already owns this window. Not an error. */
  ran: boolean;
  /** Null only when the run row could not be opened at all. */
  runId: string | null;
  status: JobRunStatus | null;
  findings: string[];
  log: string;
  notification: NotifyOutcome | null;
}

/** A promise that rejects rather than one that hangs. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  // Both branches are handled by the race, so a late rejection from `work` is
  // never an unhandled rejection.
  return Promise.race([work, bell]).finally(() => clearTimeout(timer));
}

/**
 * Run one job once, if this window is still free.
 *
 * The order is fixed and the reason for each step is in the header: claim,
 * run under a timeout, close the row whatever happened, then notify. Notifying
 * last means a broken mailer can never leave a row open, and claiming first
 * means a crash between the claim and the close leaves a visibly UNFINISHED
 * row rather than no evidence that the job ran.
 */
export async function runJob(def: JobDefinition, deps: JobRunDeps): Promise<JobOutcome> {
  const now = deps.now?.() ?? new Date();
  const windowKey = def.window(now);
  const base = { job: def.name, windowKey, runId: null, notification: null };

  if (!deps.db) {
    // Without the service client there is no unique index to arbitrate on, so
    // running would mean running unguarded. Refusing is the safe direction.
    return {
      ...base,
      ran: false,
      status: null,
      findings: [],
      log: "no service client: refusing to run unguarded",
    };
  }

  const claim = await claimRun(deps.db, def.name, deps.actor ?? JOB_ACTOR, windowKey);
  if (!claim.claimed) {
    if (claim.taken) {
      // THE IDEMPOTENCY EXIT. Somebody else owns this window: no work, no row,
      // no notice. This is the branch that turns two invocations into one
      // notification.
      return { ...base, ran: false, status: null, findings: [], log: `already ran in ${windowKey}` };
    }
    // A real fault. There is no row to close, but somebody still has to hear
    // that the automation did not run at all, so it is reported as a failure.
    const log = `could not open a job_runs row: ${claim.error}`;
    const notification = await notify(def, deps, "failed", log);
    return { ...base, ran: false, status: "failed", findings: [log], log, notification };
  }

  let status: JobRunStatus = "ok";
  let findings: string[] = [];
  let log = "";
  let facts: Record<string, unknown> | undefined;

  try {
    const result = await withTimeout(
      def.run({ db: deps.db, now }),
      deps.timeoutMs ?? JOB_TIMEOUT_MS,
      def.name,
    );
    findings = result.findings;
    log = result.log;
    facts = result.facts;
    // The job never sets its own status. A finding is `attention`, always —
    // the run came back, so its findings are known and complete.
    if (findings.length > 0) status = "attention";
  } catch (err) {
    // It did NOT come back. Whatever it had found is lost with it, which is
    // why this is a different word from the branch above.
    status = "failed";
    log = err instanceof Error ? err.message : String(err);
    findings = [log];
  }

  // The structured summary rides in the log rather than in a second channel:
  // `notifyJobRun` renders the log as the notice body, so one string is both
  // what a human reads in their inbox and what `job_runs.log` keeps.
  const summary = Object.entries({ window: windowKey, ...facts })
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  log = log ? `${log}\n\n${summary}` : summary;

  // ALWAYS. A throw, a timeout and a rejected promise all arrive here.
  await closeRun(deps.db, claim.id, status, log);

  const notification = await notify(def, deps, status, log);

  return { ...base, runId: claim.id, ran: true, status, findings, log, notification };
}

/**
 * Route the finished run through item 7 and nothing else.
 *
 * The caller identity is the ADMIN, because a scheduled run has no person
 * behind it: `job_runs.actor` is a cron name, and `notifyJobRun` posts into the
 * admin's inbox by default. Resolving the admin here rather than letting
 * `notifyJobRun` do it means the same profile is used for the identity and the
 * destination, so a job cannot post into a third person's inbox.
 *
 * Best effort, like every other notice in this codebase: bookkeeping must never
 * be able to fail a run that already happened. The `job_runs` row is already
 * closed by the time this runs.
 */
async function notify(
  def: JobDefinition,
  deps: JobRunDeps,
  status: JobRunStatus,
  log: string,
): Promise<NotifyOutcome | null> {
  try {
    const admin = await (deps.admin?.() ?? resolveAdmin(deps.db ?? undefined));
    const caller: Caller = {
      profileId: admin.profileId ?? "",
      email: admin.email,
      role: "admin",
    };
    return await notifyJobRun(
      { serviceDb: deps.db ?? undefined, caller, admin: async () => admin, mailer: deps.mailer },
      { job: def.name, status, actor: deps.actor ?? JOB_ACTOR, log: scrub(log) },
      admin.profileId ?? undefined,
    );
  } catch (err) {
    console.warn(`[jobs] ${def.name}: could not notify:`, err);
    return null;
  }
}

/* ------------------------------------------------------------ health sweep -- */

/** The columns the sweep reads. Money is deliberately not among them. */
export interface HealthClientRow {
  slug: string;
  domain: string | null;
  droplet_host: string | null;
  droplet_port: number | null;
}

/**
 * The result of looking at one client, as a DISCRIMINATED UNION rather than a
 * status string with a branch in front of it.
 *
 * FOUR OF FIVE REAL CLIENTS HAVE NEITHER A DOMAIN NOR A DROPLET HOST, and the
 * guardrail is that those are `unmonitorable` and never `healthy`. A boolean
 * `ok` with a `checked` flag beside it makes "unmonitorable rolled into
 * healthy" a one-character mistake. Here the `unmonitorable` member has no
 * `url` and no `status` FIELD AT ALL, so code that wants to report a check
 * result cannot even name one without narrowing first, and there is no value
 * of `state` that both a healthy and an unmonitorable client can hold.
 */
export type SiteHealth =
  | { state: "healthy"; slug: string; url: string; status: number }
  | { state: "down"; slug: string; url: string; detail: string }
  | { state: "unmonitorable"; slug: string; reason: string };

/**
 * The injected HTTP check. The ONLY thing in the sweep that touches a network,
 * and no test ever supplies the real one.
 */
export type SiteFetcher = (url: string) => Promise<{ status: number }>;

/** Production's fetcher. Bounded, because a hung host must not hang the job. */
export const realSiteFetcher: SiteFetcher = async (url) => {
  const res = await timeoutFetch(url, { method: "GET", redirect: "follow" }, 10_000);
  return { status: res.status };
};

/**
 * Where to look, or null when there is nowhere to look.
 *
 * A domain is a public site and is checked over https at its root. A droplet
 * host is an app server, so it is asked for `/api/health` — the endpoint
 * lib/health.ts serves and UptimeRobot already polls. Returning null is what
 * makes a client unmonitorable, and it is the ONLY thing that does.
 */
export function healthTarget(client: HealthClientRow): string | null {
  const domain = client.domain?.trim();
  if (domain) return `https://${domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
  const host = client.droplet_host?.trim();
  if (host) return `http://${host}${client.droplet_port ? `:${client.droplet_port}` : ""}/api/health`;
  return null;
}

/** One client, one verdict. A throw from the fetcher is `down`, never healthy. */
export async function checkSite(
  client: HealthClientRow,
  fetcher: SiteFetcher,
): Promise<SiteHealth> {
  const url = healthTarget(client);
  if (url === null) {
    return { state: "unmonitorable", slug: client.slug, reason: "no domain and no droplet_host" };
  }
  try {
    const { status } = await fetcher(url);
    return status < 400
      ? { state: "healthy", slug: client.slug, url, status }
      : { state: "down", slug: client.slug, url, detail: `HTTP ${status}` };
  } catch (err) {
    return {
      state: "down",
      slug: client.slug,
      url,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function siteHealthJob(fetcher: SiteFetcher = realSiteFetcher): JobDefinition {
  return {
    name: "site_health",
    schedule: "daily",
    window: dailyWindow,
    async run({ db }) {
      const { data, error } = await db
        .from("clients")
        .select("slug, domain, droplet_host, droplet_port")
        .order("slug");
      if (error) throw new Error(`clients read failed: ${error.message}`);
      const clients = (data ?? []) as HealthClientRow[];

      const results = await Promise.all(clients.map((c) => checkSite(c, fetcher)));
      const of = (s: SiteHealth["state"]) => results.filter((r) => r.state === s);

      // Only `down` is a finding. An unmonitorable client is a gap in the
      // monitoring, not an outage, and emailing about the same four rows every
      // morning until somebody fills in a domain would train the admin to
      // ignore this job. It is counted in the log instead.
      const findings = of("down").map((r) =>
        r.state === "down" ? `${r.slug} is DOWN (${r.url}): ${r.detail}` : "",
      );

      return {
        findings,
        log: results
          .map((r) =>
            r.state === "unmonitorable"
              ? `${r.slug}: unmonitorable — ${r.reason}`
              : r.state === "healthy"
                ? `${r.slug}: healthy (${r.status}) ${r.url}`
                : `${r.slug}: DOWN ${r.url} — ${r.detail}`,
          )
          .join("\n"),
        facts: {
          healthy: of("healthy").length,
          down: of("down").length,
          unmonitorable: of("unmonitorable").length,
        },
      };
    },
  };
}

/* -------------------------------------------------------- credential expiry -- */

/**
 * When the GitHub PAT the CI uses stops working.
 *
 * A DATE, and only a date. This is a known operational fact (it is in the
 * bcns CI notes and in three places on disk that a human rotates), not a
 * secret — and nothing in this file reads, prints, or has access to the token
 * VALUE. The same is true of `agent_tokens`: the query below selects
 * `profile_id, expires_at` and never `sealed`.
 */
export const GITHUB_PAT_EXPIRES_AT = "2026-10-31T00:00:00.000Z";

/** How far ahead to shout. The item's number: warn 30 days out. */
export const WARN_WITHIN_DAYS = 30;

/** Fractional days from `now` to `when`. Negative once it has expired. */
export const daysUntil = (when: string, now: Date): number =>
  (Date.parse(when) - now.getTime()) / 86_400_000;

/** 29 days warns, 31 days does not. An already-expired credential always does. */
export const expiringSoon = (when: string, now: Date, within = WARN_WITHIN_DAYS): boolean =>
  daysUntil(when, now) <= within;

export function credentialExpiryJob(): JobDefinition {
  return {
    name: "credential_expiry",
    schedule: "weekly",
    window: weeklyWindow,
    async run({ db, now }) {
      // NEVER `sealed`. Two columns, and one of them is an id.
      const { data, error } = await db.from("agent_tokens").select("profile_id, expires_at");
      if (error) throw new Error(`agent_tokens read failed: ${error.message}`);
      const tokens = (data ?? []) as { profile_id: string; expires_at: string }[];

      // Names, so the notice says who has to re-enroll. A directory that
      // cannot answer costs a name, not the warning.
      const names = new Map<string, string>();
      const dir = await db.from("profiles").select("id, display_name");
      for (const p of (dir?.data ?? []) as { id: string; display_name: string }[]) {
        names.set(p.id, p.display_name);
      }

      const lines: string[] = [];
      const findings: string[] = [];
      const note = (soon: boolean, text: string) => {
        lines.push(`${soon ? "WARN" : "ok"}  ${text}`);
        if (soon) findings.push(text);
      };

      for (const t of tokens) {
        const days = Math.floor(daysUntil(t.expires_at, now));
        const who = names.get(t.profile_id) ?? t.profile_id;
        note(
          expiringSoon(t.expires_at, now),
          days < 0
            ? `${who}'s Claude Code token EXPIRED ${-days}d ago (${t.expires_at}) — re-enrol at /account`
            : `${who}'s Claude Code token expires in ${days}d (${t.expires_at}) — re-enrol at /account`,
        );
      }

      const patDays = Math.floor(daysUntil(GITHUB_PAT_EXPIRES_AT, now));
      note(
        expiringSoon(GITHUB_PAT_EXPIRES_AT, now),
        `the GitHub PAT expires in ${patDays}d (${GITHUB_PAT_EXPIRES_AT.slice(0, 10)}) — rotate it in all three places`,
      );

      return {
        findings,
        log: lines.join("\n"),
        facts: { credentials: tokens.length + 1, expiring: findings.length },
      };
    },
  };
}

/* --------------------------------------------------------- quiet detector -- */

/** How long an onboarding client may go quiet before somebody is told. */
export const QUIET_DAYS = 7;

export interface QuietClientRow {
  id: string;
  slug: string;
  account_id: string;
  repo: string | null;
  domain: string | null;
  droplet_host: string | null;
  droplet_port: number | null;
}

/**
 * The last commit on a repo, as an ISO timestamp, or null when unknown.
 *
 * INJECTED and defaulting to "unknown" rather than to a GitHub call. Reading
 * commits needs a token this job does not have and a network this run may not
 * touch, so the honest default is silence — and silence on one Tier 1 signal
 * is safe, because the detector treats an absent signal as absent, never as
 * evidence of quiet. See the deferral note in docs/JOBS.md.
 */
export type CommitReader = (repo: string) => Promise<string | null>;

export const noCommitReader: CommitReader = async () => null;

/** The evidence for one client, gathered before any of it is judged. */
export interface QuietSignals {
  /** Tier 1. A repo nobody has pushed to is the strongest signal there is. */
  lastCommitAt: string | null;
  /** Tier 1. A site that answers right now says the build is real. */
  siteHealthy: boolean;
  /** Tier 2. Somebody logged a call, an email or a note. */
  lastContactAt: string | null;
  /** Tier 2. An open task that somebody has actually touched. */
  lastTaskAt: string | null;
}

export interface QuietVerdict {
  slug: string;
  quiet: boolean;
  /** The most recent Tier 1 or Tier 2 timestamp, or null if there is none. */
  lastSignalAt: string | null;
  /** Whole days since `lastSignalAt`, or null when nothing has ever happened. */
  quietDays: number | null;
  /** Why it is not quiet, for the log. */
  reason: string;
}

/**
 * Judge one client from its signals. Pure, so the 6-day / 8-day boundary is a
 * unit test and not a fixture.
 *
 * A HEALTHY SITE OUTRANKS EVERY DATE. If the thing being built is up and
 * answering, the client is not quiet, whatever the timestamps say — that is
 * what makes site health a Tier 1 signal rather than another date to compare.
 *
 * Otherwise the newest signal of any tier wins, and MORE THAN `QUIET_DAYS`
 * since it is quiet. Strictly more: at exactly seven days a client is inside
 * the threshold, so six days is loud and eight days is quiet.
 *
 * ponytail: there is no per-client health HISTORY table, so `siteHealthy` is
 * liveness now, not "the site came up on Tuesday" — upgrade to a health-history
 * table when the sweep needs to answer "since when".
 */
export function judgeQuiet(slug: string, s: QuietSignals, now: Date): QuietVerdict {
  if (s.siteHealthy) {
    return { slug, quiet: false, lastSignalAt: null, quietDays: null, reason: "site is up" };
  }
  const stamps = [s.lastCommitAt, s.lastContactAt, s.lastTaskAt].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const lastSignalAt = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
  if (lastSignalAt === null) {
    return { slug, quiet: true, lastSignalAt: null, quietDays: null, reason: "no signal ever" };
  }
  const days = -daysUntil(lastSignalAt, now);
  return {
    slug,
    quiet: days > QUIET_DAYS,
    lastSignalAt,
    quietDays: Math.floor(days),
    reason: `last signal ${Math.floor(days)}d ago`,
  };
}

/** Newest `occurred_at` per account, from rows already read. */
function newestBy<T extends Record<string, unknown>>(
  rows: readonly T[],
  key: keyof T,
  stamp: keyof T,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const id = row[key];
    const at = row[stamp];
    if (typeof id !== "string" || typeof at !== "string") continue;
    const seen = out.get(id);
    if (seen === undefined || at > seen) out.set(id, at);
  }
  return out;
}

export function quietClientJob(
  fetcher: SiteFetcher = realSiteFetcher,
  commits: CommitReader = noCommitReader,
): JobDefinition {
  return {
    name: "quiet_clients",
    schedule: "daily",
    window: dailyWindow,
    async run({ db, now }) {
      // ONBOARDING ONLY, and the filter is in the query rather than in a later
      // branch: `active` and `churned` clients are never read, so no amount of
      // downstream logic can flag one. An active client going quiet is normal
      // and a churned one going quiet is the definition of churned.
      const { data, error } = await db
        .from("clients")
        .select("id, slug, account_id, repo, domain, droplet_host, droplet_port")
        .eq("status", "onboarding")
        .order("slug");
      if (error) throw new Error(`clients read failed: ${error.message}`);
      const clients = (data ?? []) as QuietClientRow[];
      if (clients.length === 0) {
        return { findings: [], log: "no onboarding clients", facts: { onboarding: 0 } };
      }

      const accountIds = clients.map((c) => c.account_id);
      const [activity, tasks] = await Promise.all([
        db.from("account_activity").select("account_id, occurred_at").in("account_id", accountIds),
        db
          .from("tasks")
          .select("account_id, updated_at")
          .in("account_id", accountIds)
          .in("status", ["todo", "doing"]),
      ]);
      if (activity?.error) throw new Error(`activity read failed: ${activity.error.message}`);
      if (tasks?.error) throw new Error(`tasks read failed: ${tasks.error.message}`);

      const contact = newestBy((activity.data ?? []) as Record<string, unknown>[], "account_id", "occurred_at");
      const touched = newestBy((tasks.data ?? []) as Record<string, unknown>[], "account_id", "updated_at");

      const verdicts = await Promise.all(
        clients.map(async (c) => {
          const health = await checkSite(c, fetcher);
          return judgeQuiet(
            c.slug,
            {
              lastCommitAt: c.repo ? await commits(c.repo).catch(() => null) : null,
              siteHealthy: health.state === "healthy",
              lastContactAt: contact.get(c.account_id) ?? null,
              lastTaskAt: touched.get(c.account_id) ?? null,
            },
            now,
          );
        }),
      );

      const quiet = verdicts.filter((v) => v.quiet);
      return {
        findings: quiet.map((v) =>
          v.quietDays === null
            ? `${v.slug} (onboarding) has never shown a signal`
            : `${v.slug} (onboarding) has been quiet for ${v.quietDays}d`,
        ),
        log: verdicts.map((v) => `${v.slug}: ${v.quiet ? "QUIET" : "ok"} — ${v.reason}`).join("\n"),
        facts: { onboarding: clients.length, quiet: quiet.length },
      };
    },
  };
}

/* ---------------------------------------------------------------- registry -- */

/**
 * Every job, by name. The registry is what `scripts/run-job.mjs` matches its
 * one argument against — so an unknown name is a usage error rather than
 * something that reaches a database.
 *
 * Built by a function rather than held as a constant so the injected readers
 * are visible at the seam: production passes nothing and gets the real fetcher,
 * a test passes a fake and nothing leaves the process.
 */
export function jobRegistry(
  deps: {
    fetcher?: SiteFetcher;
    commits?: CommitReader;
    readSite?: SiteReader;
    evaluate?: Evaluator;
    /** Item 11. Injected so a test exports into a temp fixture, never ~/os. */
    readme?: ReadmeExportDeps;
  } = {},
): Record<string, JobDefinition> {
  const fetcher = deps.fetcher ?? realSiteFetcher;
  const commits = deps.commits ?? noCommitReader;
  return Object.fromEntries(
    [
      siteHealthJob(fetcher),
      credentialExpiryJob(),
      quietClientJob(fetcher, commits),
      outreachJob({ readSite: deps.readSite, evaluate: deps.evaluate }),
      leadSweepJob(),
      readmeExportJob(deps.readme),
    ].map((j) => [j.name, j]),
  );
}

export const JOB_NAMES = [
  "site_health",
  "credential_expiry",
  "quiet_clients",
  "lead_outreach",
  "lead_sweep",
  "readme_export",
] as const;
