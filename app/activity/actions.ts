/**
 * activity/actions.ts — the two calls the capture box makes.
 *
 * `parseActivity` reads text and PROPOSES a row. `commitActivity` writes one.
 * They are separate endpoints rather than one with a flag, so the write path
 * is a thing a reviewer can find: there is exactly one function in this app a
 * browser can call that puts a row in `account_activity`, and it takes an
 * explicit kind.
 *
 * Same trust boundary as leads/actions.ts and tasks/actions.ts: the viewer is
 * re-read from the session cookie on every call, and `actor_email` is taken
 * from it inside the verb. Nothing here reads an identity out of the payload.
 *
 * This directory holds no page.tsx and therefore adds no route.
 */
"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/supabase-server";
import { getServiceClient } from "@/lib/supabase-admin";
import { runAsEmployee } from "@/lib/agent/tokens";
import { log_activity, type LogActivityInput, type LogActivityResult } from "@/lib/agent/verbs/log_activity";
import type { VerbContext, VerbResult } from "@/lib/agent/verbs/types";

/** A model call sits inside an HTTP response, so it gets less than the runner's default. */
const PARSE_TIMEOUT_MS = 45_000;

/** Free text is capped before it becomes a prompt. */
const MAX_TEXT_CHARS = 2000;

export interface CaptureTarget {
  accountId?: string;
  clientId?: string;
}

async function context(): Promise<VerbContext | { error: string }> {
  const { role, email, userId, client } = await getViewer();
  if (!client) return { error: "Supabase is not configured." };
  if (role === null || !email || !userId) return { error: "Your account is not provisioned." };
  return {
    caller: { profileId: userId, email, role },
    db: client,
    serviceDb: getServiceClient() ?? undefined,
    // The parse runs as THIS employee, on their own seat. `runAsEmployee`
    // fetches and drops the token itself; nothing here ever holds one.
    runParse: async (prompt: string) => {
      const res = await runAsEmployee(userId, prompt, { timeoutMs: PARSE_TIMEOUT_MS });
      return res.ok ? { ok: true as const, reply: res.reply } : { ok: false as const, error: res.error };
    },
  };
}

async function call(input: LogActivityInput): Promise<VerbResult<LogActivityResult>> {
  const ctx = await context();
  if ("error" in ctx) return { ok: false, error: { code: "not_configured", message: ctx.error } };
  return log_activity.run(ctx, input);
}

/** Read the text. Returns a PROPOSED row; writes nothing. */
export async function parseActivity(
  target: CaptureTarget,
  text: string,
  timeZone: string,
): Promise<VerbResult<LogActivityResult>> {
  return call({ ...target, text: String(text ?? "").slice(0, MAX_TEXT_CHARS), timeZone });
}

/** Write the row the person confirmed. `kind` is present, so this is the write path. */
export async function commitActivity(
  input: CaptureTarget & {
    kind: LogActivityInput["kind"];
    note: string;
    outcome: string | null;
    occurredAt: string;
  },
): Promise<VerbResult<LogActivityResult>> {
  const res = await call({
    accountId: input.accountId,
    clientId: input.clientId,
    kind: input.kind,
    note: String(input.note ?? "").slice(0, MAX_TEXT_CHARS),
    outcome: input.outcome,
    occurredAt: input.occurredAt,
  });
  if (res.ok) {
    revalidatePath("/leads");
    revalidatePath("/clients");
  }
  return res;
}
