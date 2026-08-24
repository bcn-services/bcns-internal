/**
 * tokens.ts — the enrollment record for one employee's Claude seat.
 *
 * Storage layer only: it seals, stores, opens and deletes. It decides nothing
 * about who may do those things — every function takes a profileId and trusts
 * it, so the caller must have established that identity from the session
 * first. That is the same contract lib/profiles.ts and lib/accounts.ts work
 * under, except that here the enforcement point is NOT RLS: `agent_tokens` has
 * no policies at all and is reachable only through the service-role client, so
 * the authorization check exists only in the calling route.
 *
 * The one asymmetry worth stating: `enrollmentFor` deliberately cannot return
 * the token. Reading a token is `tokenFor`, which is called by exactly one
 * caller — the runner, on its way to a child process's environment. Nothing
 * returns a token to a browser.
 */

import "server-only";
import { getServiceClient } from "../supabase-admin";
import { agentKey, agentKeyId, openToken, sealToken, AgentKeyError } from "./secrets";
import { runAgent, type AgentResult, type AgentRunOptions } from "./runner";

/** What a page may safely learn about an enrollment: that it exists, and when it dies. */
export interface AgentEnrollment {
  profileId: string;
  keyId: string;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row shape, kept next to the single query that selects it. */
const ENROLLMENT_COLUMNS =
  "profile_id, key_id, expires_at, last_used_at, created_at, updated_at";

type EnrollmentRow = {
  profile_id: string;
  key_id: string;
  expires_at: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * `claude setup-token` issues a token good for a year. The exact expiry is not
 * printed anywhere the employee can copy, so the app assumes a year from
 * enrollment and warns early rather than pretending to know the real date.
 */
const TOKEN_LIFETIME_DAYS = 365;

/** How long before expiry the account page starts nagging. */
export const EXPIRY_WARNING_DAYS = 30;

export class AgentTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTokenError";
  }
}

function db() {
  const client = getServiceClient();
  if (!client) throw new AgentTokenError("Supabase is not configured on this server");
  return client;
}

function toEnrollment(row: EnrollmentRow): AgentEnrollment {
  return {
    profileId: row.profile_id,
    keyId: row.key_id,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Sanity-check a pasted token before sealing it. This is a paste-error filter,
 * not a validation: the only authority on whether a token works is Anthropic,
 * and the honest way to find out is to run something with it. Catching the
 * obvious cases here — an empty box, a whole terminal transcript, the command
 * instead of its output — saves the employee a confusing failure later.
 */
export function looksLikeSetupToken(raw: string): boolean {
  const t = raw.trim();
  return t.length >= 20 && !/\s/.test(t) && t.startsWith("sk-ant-");
}

/**
 * Store (or replace) an employee's token. Replacing is the re-enroll path, so
 * the upsert is the feature rather than a convenience: an employee whose token
 * expired pastes a new one over the old row and nothing else has to change.
 */
export async function enrollToken(profileId: string, rawToken: string): Promise<AgentEnrollment> {
  const token = rawToken.trim();
  if (!looksLikeSetupToken(token)) {
    throw new AgentTokenError(
      "That does not look like a setup token — run `claude setup-token` and paste the whole value it prints.",
    );
  }

  let sealed: string;
  let keyId: string;
  try {
    const key = agentKey();
    sealed = sealToken(token, key);
    keyId = agentKeyId(key);
  } catch (err) {
    // A missing or malformed AGENT_TOKEN_KEY is an operator problem, not the
    // employee's. Say which it is; never echo any part of the key or token.
    if (err instanceof AgentKeyError) {
      console.error("[agent] sealing failed:", err.message);
      throw new AgentTokenError("This server cannot store tokens — AGENT_TOKEN_KEY is missing or invalid.");
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_DAYS * 86_400_000).toISOString();
  const { data, error } = await db()
    .from("agent_tokens")
    .upsert(
      { profile_id: profileId, sealed, key_id: keyId, expires_at: expiresAt, last_used_at: null },
      { onConflict: "profile_id" },
    )
    .select(ENROLLMENT_COLUMNS)
    .single();

  if (error) throw new AgentTokenError(error.message);
  return toEnrollment(data as EnrollmentRow);
}

/** Whether this employee is enrolled, and when their token runs out. Never the token. */
export async function enrollmentFor(profileId: string): Promise<AgentEnrollment | null> {
  const { data, error } = await db()
    .from("agent_tokens")
    .select(ENROLLMENT_COLUMNS)
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) throw new AgentTokenError(error.message);
  return data ? toEnrollment(data as EnrollmentRow) : null;
}

/**
 * Every enrollment, for the admin page. Same columns — an admin gets to see
 * who is enrolled and whose token is about to lapse, and no more of a
 * colleague's credential than the colleague gets of their own.
 */
export async function allEnrollments(): Promise<AgentEnrollment[]> {
  const { data, error } = await db()
    .from("agent_tokens")
    .select(ENROLLMENT_COLUMNS)
    .order("created_at", { ascending: true });

  if (error) throw new AgentTokenError(error.message);
  return (data ?? []).map((row) => toEnrollment(row as EnrollmentRow));
}

/**
 * The revoke control. Deletes the row outright rather than flagging it: a
 * disabled credential still sitting in the database is a credential, and the
 * point of this button is that the employee can make the server stop being
 * able to act as them.
 *
 * It does NOT revoke the token at Anthropic — nothing here can. An employee
 * who believes their token leaked has to revoke it on their own account too,
 * and the account page says so.
 */
export async function revokeToken(profileId: string): Promise<void> {
  const { error } = await db().from("agent_tokens").delete().eq("profile_id", profileId);
  if (error) throw new AgentTokenError(error.message);
}

/**
 * The decrypted token for one employee, for the runner and nothing else.
 *
 * Returns null when they are not enrolled — a normal state with a normal UI
 * ("set up agent access"), not an error. Throws only when a row exists and
 * cannot be opened, because that is a real fault an operator must see: either
 * AGENT_TOKEN_KEY was rotated without re-sealing, or the row was tampered with.
 */
export async function tokenFor(profileId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("agent_tokens")
    .select("sealed, key_id")
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) throw new AgentTokenError(error.message);
  if (!data) return null;

  const row = data as { sealed: string; key_id: string };
  const key = agentKey();
  if (row.key_id !== agentKeyId(key)) {
    throw new AgentTokenError(
      "This token was sealed with a different AGENT_TOKEN_KEY — the employee has to enroll again.",
    );
  }
  return openToken(row.sealed, key);
}

/**
 * Stamp a successful run. Best-effort by design: a failed bookkeeping write
 * must not fail a run that already happened and already cost money, so this
 * logs and swallows rather than throwing.
 */
export async function markTokenUsed(profileId: string): Promise<void> {
  try {
    const { error } = await db()
      .from("agent_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("profile_id", profileId);
    if (error) console.warn("[agent] could not stamp last_used_at:", error.message);
  } catch (err) {
    console.warn("[agent] could not stamp last_used_at:", err);
  }
}

/** Days until this enrollment lapses; negative once it has. */
export function daysUntilExpiry(enrollment: AgentEnrollment, now: Date = new Date()): number {
  return Math.floor((Date.parse(enrollment.expiresAt) - now.getTime()) / 86_400_000);
}

/**
 * The one call a feature makes: run this prompt as this employee.
 *
 * It exists so no caller ever holds a decrypted token. The token is fetched,
 * handed to the child process, and dropped; a route that wanted to log the
 * result, retry, or branch on it has no variable to leak.
 *
 * Not-enrolled is a first-class answer rather than an error, because it is the
 * expected state for a new hire and the UI has somewhere to send them.
 */
export async function runAsEmployee(
  profileId: string,
  prompt: string,
  opts: Omit<AgentRunOptions, "token"> = {},
): Promise<AgentResult | { ok: false; error: string; notEnrolled: true }> {
  let token: string | null;
  try {
    token = await tokenFor(profileId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[agent] could not open token:", profileId, message);
    return { ok: false, error: message };
  }
  if (!token) {
    return {
      ok: false,
      notEnrolled: true,
      error: "No Claude seat is connected for this account yet.",
    };
  }

  const result = await runAgent(profileId, prompt, { ...opts, token });
  if (result.ok) await markTokenUsed(profileId);
  return result;
}
