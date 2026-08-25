/**
 * POST /api/skills/run — the first caller of `runAsEmployee`.
 *
 * Deliberately thin. Everything decidable lives in lib/agent/skill-run.ts,
 * which is importable under plain node and therefore testable; this file only
 * gathers the three things that are not — the cookie-bound viewer, the
 * service-role client, and the real runner.
 *
 * A route rather than a server action because the run has to be CANCELLABLE:
 * a server action call is not something a browser can abort, and `fetch` with
 * an AbortController is. Aborting closes the connection, which fires
 * `request.signal` on this side.
 */
import { getViewer } from "@/lib/supabase-server";
import { getServiceClient } from "@/lib/supabase-admin";
import { runAsEmployee } from "@/lib/agent/tokens";
import { handleSkillRun } from "@/lib/agent/skill-run";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { role, userId, email, client } = await getViewer();
  return handleSkillRun(request, {
    viewer: { role, userId, email, db: client },
    serviceDb: getServiceClient(),
    // Default tools, NOT NO_TOOLS: a skill run needs Read/Edit/Write/Glob/
    // Grep/Skill to do anything at all. `NO_TOOLS` belongs to the activity
    // parser, whose input is untrusted free text; this prompt is built
    // server-side from a registry name and a database row.
    run: (profileId, prompt) => runAsEmployee(profileId, prompt),
  });
}
