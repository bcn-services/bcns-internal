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
import { mayRunSkill, skillPrompt } from "./skills";
import { inbox_post } from "./verbs/inbox_post";
import type { CallerRole, DbClient } from "./verbs/types";
import { scrub } from "./verbs/types";

/** Terminal states this route writes. `running` is the opening value. */
export type JobRunStatus = "ok" | "error" | "cancelled";

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

/** Bookkeeping must never fail a run that already happened and already cost money. */
async function openRun(
  db: DbClient | null,
  skill: string,
  actor: string,
): Promise<string | null> {
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("job_runs")
      .insert({ job: skill, actor, status: "running" })
      .select("id")
      .single();
    if (error) {
      console.warn("[skills] could not open job_runs row:", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.warn("[skills] could not open job_runs row:", err);
    return null;
  }
}

async function closeRun(
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
export const SKILL_RUN_FAILED_KIND = "skill_run_failed";

/**
 * Tell the person their run died.
 *
 * Only on FAILURE, and only to the person who started it. A run takes up to a
 * minute; the browser that started it may be closed or on another page by the
 * time it ends, and then the `job_runs` row is the only record — and job
 * history is admin-only (0009) and does not exist as a page until item 12. A
 * SUCCESSFUL run needs nothing here: its reply is in the response, on screen.
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
  const res = await inbox_post.run(
    { caller: { profileId: viewer.userId, email: viewer.email, role: viewer.role }, db: serviceDb },
    {
      profileId: viewer.userId,
      kind: SKILL_RUN_FAILED_KIND,
      title: `${skill} did not finish`,
      body: scrub(message),
      sourceJob: skill,
    },
  );
  if (!res.ok) console.warn("[skills] could not post the failure notice:", res.error.code);
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
