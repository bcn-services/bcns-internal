/**
 * skill-run.ts — the `job_runs` bookkeeping every agent run shares.
 *
 * ONE COPY, because "every run leaves a `job_runs` row, opened `running`
 * before the agent starts" is a property of runs, not of any one caller. The
 * scheduler (lib/jobs.ts) and the daily briefing (lib/briefing.ts) both open
 * and close their rows through here, so there is only ever one thing that has
 * to keep matching `job_runs_unfinished_idx`.
 *
 * The row is written through the SERVICE client, because 0009 gives
 * `job_runs` an admin-only write policy and most runs are a member's.
 *
 * Bookkeeping must never fail a run that already happened and already cost
 * money — every function here swallows its own errors and says so in its
 * return value rather than throwing into the caller.
 *
 * The file kept its name deliberately: tests/admin-surface.test.mjs reads
 * `export type JobRunStatus` out of it by path.
 */
import type { DbClient } from "./verbs/types";
import { scrub } from "./verbs/types";

/**
 * Terminal states written into `job_runs.status`. `running` is the opening
 * value.
 *
 * FOUR OUTCOMES, AND `attention` IS THE ONE ITEM 9 GOT WRONG. Item 9 wrote
 * `failed` for two different things — the job threw, and the job ran perfectly
 * but found a client's site down — because the only lever the notification
 * rule table gave it was its own status. That made a healthy nightly sweep
 * read as a broken one on every surface that shows the status, which is
 * exactly what item 12's job-history panel is. The two are now separate
 * values, and the extra lever is a seventh notification kind
 * (`job_run_attention` in lib/notify.ts) rather than an `if` at a call site:
 *
 *   ok        — ran, found nothing. Nobody has to do anything.
 *   attention — RAN FINE. Found something a human must look at (a site down,
 *               a token lapsing). The automation is healthy; the world is not.
 *   failed    — did not come back. It threw, hung, or could not open its row.
 *               The automation itself is broken and its findings are unknown.
 *   error     — a run started FOR one person that the runner refused. Someone
 *               is waiting on it. Kept distinct from `failed` because "this
 *               person's briefing did not come" is not "the 6am sweep is down".
 *   cancelled — stopped by the person who started it. Not an outcome.
 *
 * `attention` and `failed` both still email the admin: something is wrong
 * either way. What changed is that the row no longer lies about which.
 */
export type JobRunStatus = "ok" | "attention" | "error" | "failed" | "cancelled";

/**
 * The outcome of trying to open a WINDOWED run — see 0014_job_windows.sql.
 *
 * `taken` is the only benign failure: another process already owns this job's
 * window and the caller must do nothing at all, notification included. Every
 * other failure is a real fault and must not be mistaken for "already done",
 * or a broken database would look exactly like a job that had nothing to do.
 */
export type RunClaim =
  | { claimed: true; id: string }
  | { claimed: false; taken: boolean; error: string };

/** The runner, narrowed to what one button needs. See VerbContext.runParse. */
export type SkillRunner = (
  profileId: string,
  prompt: string,
) => Promise<
  | { ok: true; reply: string }
  | { ok: false; error: string; notEnrolled?: boolean; busy?: boolean; timedOut?: boolean }
>;

/**
 * Bookkeeping must never fail a run that already happened and already cost money.
 *
 * Exported because the daily briefing (lib/briefing.ts) is a skill run too, and
 * "every run leaves a `job_runs` row, opened `running` before the agent starts"
 * is a property of runs, not of this route. A second copy would be a second
 * thing that can stop matching `job_runs_unfinished_idx`.
 */
export async function openRun(
  db: DbClient | null,
  skill: string,
  actor: string,
): Promise<string | null> {
  if (!db) return null;
  // windowKey null: an interactive press is meant to run every time it is
  // pressed. The partial unique index in 0014 ignores nulls entirely.
  const claim = await claimRun(db, skill, actor, null);
  return claim.claimed ? claim.id : null;
}

/**
 * THE ONLY INSERT INTO `job_runs` IN THIS CODEBASE.
 *
 * With a `windowKey` this is also the idempotency primitive for every
 * scheduled job: `job_runs_window_idx` (0014) is unique on (job, window_key),
 * so two invocations of the same daily sweep on the same day race on the index
 * and exactly one of them gets a row back. The loser gets SQLSTATE 23505 and
 * is told `taken`, which lib/jobs.ts turns into "do nothing, notify nobody".
 *
 * This is the same shape as lib/briefing.ts's claim and for the same reason: a
 * `select` to check whether today's run exists, followed by an `insert`, lets
 * both callers pass the check. The check and the write have to be one
 * statement, and here the database supplies the check.
 */
export async function claimRun(
  db: DbClient,
  job: string,
  actor: string,
  windowKey: string | null,
): Promise<RunClaim> {
  try {
    const { data, error } = await db
      .from("job_runs")
      .insert({ job, actor, status: "running", window_key: windowKey })
      .select("id")
      .single();
    if (error) {
      const taken = (error as { code?: string }).code === UNIQUE_VIOLATION;
      if (!taken) console.warn("[skills] could not open job_runs row:", error.message);
      return { claimed: false, taken, error: error.message };
    }
    const id = (data as { id: string } | null)?.id ?? null;
    if (id) return { claimed: true, id };
    return { claimed: false, taken: false, error: "job_runs insert returned no id" };
  } catch (err) {
    console.warn("[skills] could not open job_runs row:", err);
    return { claimed: false, taken: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Postgres' `unique_violation`. The one error that means "already claimed". */
export const UNIQUE_VIOLATION = "23505";

export async function closeRun(
  db: DbClient | null,
  id: string | null,
  status: JobRunStatus,
  log: string,
): Promise<void> {
  if (!db || !id) return;
  try {
    const { error } = await db
      .from("job_runs")
      .update({ status, finished_at: new Date().toISOString(), log: scrub(log) })
      .eq("id", id);
    if (error) console.warn("[skills] could not close job_runs row:", error.message);
  } catch (err) {
    console.warn("[skills] could not close job_runs row:", err);
  }
}
