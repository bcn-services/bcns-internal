/**
 * skill-run.ts — everything POST /api/skills/run actually does.
 *
 * The route handler is a five-line adapter over this. The split is not
 * decoration: `lib/supabase-server.ts` and `lib/agent/tokens.ts` both import
 * `server-only`, which throws under plain node, so a route that reached for
 * them at module scope could not be imported by a test at all — and the 403 is
 * the thing most worth testing. Everything here takes its identity, its
 * database and its runner by INJECTION, exactly as `VerbContext` does, so the
 * test drives the real decision path and nothing spawns the claude CLI.
 *
 * THE GATE IS `mayRunSkill`, on role alone. job_function is not read here, is
 * not accepted from the body, and has no effect on the answer. Whatever the UI
 * showed or hid, a POST for `leads` from a member is a 403.
 *
 * THE SUBJECT IS READ FROM THE DATABASE, never from the body. The body carries
 * an account UUID; the business name that ends up in the prompt is whatever
 * that row says through the caller's own RLS-scoped client. A caller who
 * cannot see the account gets no subject, and a caller who invents a name gets
 * ignored — the runner's agent has Write access to a clone of the os, so its
 * prompt is not a place to interpolate browser text.
 *
 * EVERY RUN LEAVES A `job_runs` ROW, whatever the outcome, written through the
 * SERVICE client because 0009 gives `job_runs` an admin-only write policy and
 * most runs are a member's. The row is opened `running` before the agent
 * starts, so a run that dies without writing back is visible as an unfinished
 * row rather than as no row at all — which is precisely what
 * `job_runs_unfinished_idx` is for.
 */

import { getAccount, isUuid } from "../accounts";
import { deliverNotification } from "../notify";
import { mayRunSkill, skillPrompt } from "./skills";
import type { CallerRole, DbClient } from "./verbs/types";
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
 *   error     — an interactive skill run the runner refused. One press, one
 *               person waiting. Kept distinct from `failed` because "this
 *               button did not work" is not "the 6am sweep is down".
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

export interface SkillRunDeps {
  /** Re-read from the session cookie by the route. Never from the request body. */
  viewer: {
    role: CallerRole | null;
    userId: string | null;
    email: string | null;
    /** RLS-scoped, for reading the subject as this person. */
    db: DbClient | null;
  };
  /** Service-role client — the only way a member's run can log itself. */
  serviceDb: DbClient | null;
  run: SkillRunner;
}

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

const json = (body: unknown, status: number) => Response.json(body, { status });

/** The machine label on the notice a failed run leaves behind. */
export const SKILL_RUN_FAILED_KIND = "job_run_failed";

/**
 * Tell the person their run died — and tell the admin, by email.
 *
 * Only on FAILURE. A run takes up to a minute; the browser that started it may
 * be closed or on another page by the time it ends, and then the `job_runs` row
 * is the only record — and job history is admin-only (0009) and does not exist
 * as a page until item 12. A SUCCESSFUL run needs nothing here: its reply is in
 * the response, on screen.
 *
 * TWO RECIPIENTS, ONE EVENT. The inbox item goes to whoever started the run;
 * the email goes to the admin, because a failed run is somebody's job to fix
 * and that somebody is not necessarily the member who pressed the button.
 * lib/notify.ts owns that split — this file just says what happened.
 *
 * Best effort, like every other notice: bookkeeping must never fail a run that
 * already happened and already cost money.
 */
async function notifyRunFailed(
  deps: SkillRunDeps,
  skill: string,
  message: string,
): Promise<void> {
  const { viewer, serviceDb } = deps;
  if (!serviceDb || !viewer.userId || !viewer.email || viewer.role === null) return;
  await deliverNotification(
    {
      serviceDb,
      caller: { profileId: viewer.userId, email: viewer.email, role: viewer.role },
    },
    {
      kind: SKILL_RUN_FAILED_KIND,
      inboxProfileId: viewer.userId,
      title: `${skill} did not finish`,
      body: scrub(message),
      sourceJob: skill,
      facts: { job: skill, startedBy: viewer.email },
    },
  );
}

/**
 * What this run is about, in words, or null. A missing/unreadable account is
 * not an error: the skill still runs, just without a named subject.
 */
async function subjectFor(db: DbClient | null, accountId: unknown): Promise<string | null> {
  if (!db || !isUuid(accountId)) return null;
  try {
    return (await getAccount(db, accountId))?.business_name ?? null;
  } catch (err) {
    console.warn("[skills] could not read subject account:", err);
    return null;
  }
}

/**
 * Run one skill as the signed-in employee.
 *
 * CANCELLATION rides on `request.signal`, which Next aborts when the browser
 * closes the connection — which is what the button's Cancel does. There is
 * deliberately no second lifecycle: the child process keeps its own SIGKILL
 * timeout in lib/agent/runner.ts and dies on that clock. What cancel buys is
 * the two things asked for — the page stops waiting, and the run stops being
 * recorded as if it were still someone's problem: the `job_runs` row closes as
 * `cancelled`, which is honest about a child that may still be finishing.
 */
export async function handleSkillRun(request: Request, deps: SkillRunDeps): Promise<Response> {
  const { viewer, serviceDb, run } = deps;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON body." }, 400);
  }
  const { skill, accountId } = (body ?? {}) as { skill?: unknown; accountId?: unknown };

  // 401 before 403: "you are not signed in" and "you may not do this" are
  // different answers, and the middleware has already handled the first for
  // page routes only.
  if (!viewer.userId || !viewer.email) {
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  // THE GATE. Role only. Unknown skill and forbidden skill share an answer on
  // purpose — a probe should not learn which of the two it hit.
  if (!mayRunSkill(viewer.role, skill)) {
    return json({ ok: false, error: "You may not run that skill." }, 403);
  }
  const name = skill as string;

  if (request.signal.aborted) {
    return json({ ok: false, error: "Cancelled." }, 499);
  }

  const runId = await openRun(serviceDb, name, viewer.email);
  const prompt = skillPrompt(name, await subjectFor(viewer.db, accountId));

  // The abort is raced against the run rather than awaited after it: awaiting
  // first would hold the response for the runner's full 55s and defeat the
  // point of a cancel button.
  const cancelled = new Promise<"cancelled">((resolve) => {
    if (request.signal.aborted) return resolve("cancelled");
    request.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });

  const result = await Promise.race([run(viewer.userId, prompt), cancelled]);

  if (result === "cancelled") {
    await closeRun(serviceDb, runId, "cancelled", "cancelled by the person who started it");
    return json({ ok: false, error: "Cancelled." }, 499);
  }

  if (!result.ok) {
    await closeRun(serviceDb, runId, "error", result.error);
    // Two states are not failures and get no notice. Not-enrolled is the
    // new-hire state — the button already points them at /account. Busy is
    // backpressure: the runner is at capacity, the client will retry, and a
    // notice per retry fills an inbox with rows nobody can delete (there is no
    // DELETE policy on inbox_items).
    if (!result.notEnrolled && !result.busy) await notifyRunFailed(deps, name, result.error);
    // Not-enrolled is the new-hire state, not a fault: 409 so the button can
    // point at /account instead of showing a red error.
    const status = result.notEnrolled ? 409 : result.busy ? 503 : 502;
    return json({ ok: false, error: scrub(result.error), notEnrolled: !!result.notEnrolled }, status);
  }

  await closeRun(serviceDb, runId, "ok", result.reply);
  return json({ ok: true, skill: name, reply: result.reply }, 200);
}
