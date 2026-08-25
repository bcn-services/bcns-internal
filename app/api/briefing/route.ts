/**
 * /api/briefing — start a briefing, or ask whether one has landed.
 *
 * Thin, for the same reason app/api/skills/run/route.ts is thin: everything
 * decidable lives in lib/briefing.ts, which imports no `server-only` and is
 * therefore testable under plain node. This file gathers the three things that
 * are not — the cookie-bound viewer, the service-role client, and the real
 * runner.
 *
 * A route rather than a server action because the trigger is fired from a
 * client component on mount and polled afterwards; a server action would give
 * the poll no cheap answer and would tie the trigger to a form.
 *
 * The run gets BRIEFING_TIMEOUT_MS, not the interactive 55 seconds: nothing is
 * holding an HTTP response open waiting for it. The POST has already answered
 * by the time the child starts.
 */
import { getViewer } from "@/lib/supabase-server";
import { getServiceClient } from "@/lib/supabase-admin";
import { runAsEmployee } from "@/lib/agent/tokens";
import { BRIEFING_TIMEOUT_MS, handleBriefingRequest, type BriefingDeps } from "@/lib/briefing";

export const dynamic = "force-dynamic";

async function deps(): Promise<BriefingDeps> {
  const { role, userId, email, client } = await getViewer();
  return {
    viewer: { role, userId, email, db: client },
    serviceDb: getServiceClient(),
    run: (profileId, prompt) =>
      runAsEmployee(profileId, prompt, { timeoutMs: BRIEFING_TIMEOUT_MS }),
  };
}

export async function GET(request: Request): Promise<Response> {
  return handleBriefingRequest(request, await deps());
}

export async function POST(request: Request): Promise<Response> {
  return handleBriefingRequest(request, await deps());
}
