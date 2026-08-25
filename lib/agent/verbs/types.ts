/**
 * verbs/types.ts — the one shared spine every verb hangs off.
 *
 * WHY A VERB LAYER AT ALL. The runner (lib/agent/runner.ts) deliberately gives
 * a headless agent no Bash. That means an agent cannot reach the database by
 * shelling out — which is the point. This directory is the replacement surface:
 * a fixed set of typed calls, each of which decides for itself whether THIS
 * caller may make it, before it touches data.
 *
 * FOUR THINGS LIVE HERE AND NOWHERE ELSE, on purpose:
 *
 *  1. `VerbResult` — every verb returns a discriminated result, never throws.
 *     A model calling a tool has to be TOLD it was denied; an exception that
 *     unwinds into a route handler tells it nothing. `defineVerb` catches an
 *     escaped throw and converts it, so even a bug downstream is a typed error.
 *
 *  2. The role gate — `defineVerb` checks it. No verb re-implements it, and no
 *     verb has a default caller: a missing or malformed `caller` is
 *     `invalid_input`, never "assume admin".
 *
 *  3. Money stripping — ONE recursive redactor applied by `defineVerb` to every
 *     verb's success payload. Per-verb stripping is how one gets missed, and
 *     the fields (`clients.monthly_rate_cents`, `accounts.deal_value_cents`)
 *     turn up embedded inside joins as well as at the top level.
 *
 *  4. The JSON schema — built by `defineVerb` from one shape, so the tool
 *     descriptions handed to a model cannot drift verb to verb.
 *
 * SECRETS. `SUPABASE_SERVICE_ROLE_KEY` never appears in a result: the verb
 * layer takes an already-built client by injection and never reads env for a
 * key, and `fail()` scrubs the key out of any message that somehow carries it
 * (a PostgREST/undici error can quote a request URL).
 */

/** The only two roles the JWT carries — see supabase/migrations/0002_rls_policies.sql. */
export const CALLER_ROLES = ["admin", "member"] as const;
export type CallerRole = (typeof CALLER_ROLES)[number];

/**
 * Who is asking. Every verb requires one; there is no ambient identity.
 * `profileId` is `profiles.id`, which IS `auth.users.id`.
 */
export interface Caller {
  profileId: string;
  email: string;
  role: CallerRole;
}

export type VerbErrorCode =
  | "forbidden"
  | "invalid_input"
  | "not_found"
  | "not_configured"
  | "not_implemented"
  // The free-text parser could not turn a person's words into a row. Its own
  // code, not `invalid_input`: the input was fine, the reading of it failed,
  // and the UI answers the two differently — a parse failure keeps the raw
  // text on screen for manual entry rather than blaming the typist.
  | "parse_failure"
  // The runner refused the work: every slot is in flight. A capacity answer,
  // distinct from `parse_failure` so the UI can say "try again in a moment"
  // rather than telling someone their words could not be read.
  | "busy"
  | "db_error"
  | "timeout"
  | "network_error"
  | "too_large"
  | "internal";

export interface VerbError {
  code: VerbErrorCode;
  message: string;
}

export type VerbResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: VerbError };

export const ok = <T>(data: T): VerbResult<T> => ({ ok: true, data });

/**
 * Build a failure. Scrubs the service-role key defensively — this is the last
 * place a message passes through before a caller (possibly a model, possibly a
 * browser) sees it.
 */
export function fail(code: VerbErrorCode, message: string): { ok: false; error: VerbError } {
  return { ok: false, error: { code, message: scrub(message) } };
}

/** Remove any literal occurrence of a server-side secret from a message. */
export function scrub(message: string): string {
  let out = message;
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "AGENT_TOKEN_KEY", "ANTHROPIC_API_KEY"]) {
    const secret = process.env[name]?.trim();
    // A short/blank value would match everywhere; only redact a real-looking one.
    if (secret && secret.length >= 8) out = out.split(secret).join(`[${name} redacted]`);
  }
  return out;
}

/* ------------------------------------------------------------------ money -- */

/**
 * Fields a non-admin caller must never receive. Named by COLUMN, so an embed
 * (`client:clients(monthly_rate_cents)`) is caught by the same list as a
 * top-level select.
 */
export const MONEY_FIELDS: readonly string[] = ["monthly_rate_cents", "deal_value_cents"];

/**
 * Delete money fields from a payload for a non-admin. The key is REMOVED, not
 * nulled: `null` is already meaningful on `monthly_rate_cents` ("never
 * recorded"), so nulling would forge a fact rather than withhold one.
 */
export function stripMoney<T>(value: T, role: CallerRole): T {
  return role === "admin" ? value : (redact(value) as T);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (MONEY_FIELDS.includes(k)) continue;
    out[k] = redact(v);
  }
  return out;
}

/* ----------------------------------------------------------------- schema -- */

export interface JsonSchemaProp {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: readonly string[];
  items?: { type: string };
}

export interface VerbInputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required: string[];
  additionalProperties: false;
}

/** The Anthropic tool shape. One builder, so 14 verbs cannot describe themselves 14 ways. */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: VerbInputSchema;
}

/* ---------------------------------------------------------------- context -- */

/**
 * Structural shape of an injected supabase-js client. Same trick as
 * lib/accounts.ts: this module builds no client and reads no key, so a fake in
 * a test and the real thing are interchangeable.
 */
export interface DbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

/**
 * Everything a verb is allowed to reach for. All of it is INJECTED — nothing
 * in this directory constructs a client, opens a socket, or resolves a path
 * from ambient state, so every seam here is the seam a test mocks.
 */
export interface VerbContext {
  /** Required. There is no default caller and no default role. */
  caller: Caller;
  /** RLS-scoped client for most verbs; service-role for `inbox_post`. */
  db?: DbClient;
  /**
   * Service-role client, for the one write RLS deliberately has no policy for:
   * posting into somebody's `inbox_items`. Kept SEPARATE from `db` so a verb
   * has to name the escalation to get it — an RLS-scoped client that could be
   * quietly swapped for a service-role one is not a boundary.
   */
  serviceDb?: DbClient;
  /**
   * `log_activity`'s free-text path only. One call to lib/agent/runner.ts,
   * narrowed to prompt-in / reply-out. Injected for the same reason `db` is:
   * a test supplies a canned reply, and nothing in this directory spawns the
   * CLI or reaches the network.
   */
  runParse?: (
    prompt: string,
  ) => Promise<
    | { ok: true; reply: string }
    // `busy` and `timedOut` come straight off the runner. They are a CAPACITY
    // answer, not a reading of the person's words, and the UI has to be able to
    // say so instead of blaming the typist for a full queue.
    | { ok: false; error: string; busy?: boolean; timedOut?: boolean }
  >;
  /** `read_site` only. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * `read_site` only. Loopback and RFC1918 hosts are refused by default —
   * a URL reaching this verb may have come from a model, which makes an
   * unguarded fetcher an SSRF gadget pointed at the droplet's own metadata
   * and localhost services. Tests set this to reach their own fixture server.
   */
  allowPrivateHosts?: boolean;
  /** `os_publish` only. Which git repo to publish. Never defaults to a hard-coded path. */
  osDir?: string;
  /** `search_places` only — where the existing python script lives, and what runs it. */
  places?: { python?: string; script?: string };
  /** Injected clock, so a test never races a real one. */
  now?: () => Date;
}

/* ------------------------------------------------------------------- verb -- */

export interface Verb<I, O> {
  name: string;
  description: string;
  roles: readonly CallerRole[];
  schema: ToolSchema;
  run(ctx: VerbContext, input: I): Promise<VerbResult<O>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate the caller itself. A verb whose caller is absent, malformed, or
 * carries a role outside the two the JWT can hold is refused OUTRIGHT — it
 * does not fall back to `member` and certainly not to `admin`.
 */
export function checkCaller(caller: Caller | undefined): VerbError | null {
  if (!caller || typeof caller !== "object") {
    return { code: "invalid_input", message: "no caller identity supplied" };
  }
  if (!(CALLER_ROLES as readonly string[]).includes(caller.role)) {
    return { code: "invalid_input", message: `unknown caller role: ${String(caller.role)}` };
  }
  if (!UUID_RE.test(caller.profileId ?? "")) {
    return { code: "invalid_input", message: "caller profileId is not a uuid" };
  }
  if (typeof caller.email !== "string" || caller.email.trim() === "") {
    return { code: "invalid_input", message: "caller email is required" };
  }
  return null;
}

/** Pull the injected client, or say which verb had none rather than throwing. */
export function requireDb(ctx: VerbContext, verb: string): VerbResult<DbClient> {
  if (!ctx.db) return fail("not_configured", `${verb}: no database client was injected`);
  return ok(ctx.db);
}

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/**
 * Build a verb. The wrapper — not the handler — owns caller validation, the
 * role gate, throw-to-typed-error conversion, and money stripping, so all four
 * are impossible to forget in a new verb.
 */
export function defineVerb<I, O>(spec: {
  name: string;
  description: string;
  roles: readonly CallerRole[];
  properties: Record<string, JsonSchemaProp>;
  required?: readonly string[];
  handler: (ctx: VerbContext, input: I) => Promise<VerbResult<O>>;
}): Verb<I, O> {
  const schema: ToolSchema = {
    name: spec.name,
    description: spec.description,
    input_schema: {
      type: "object",
      properties: spec.properties,
      required: [...(spec.required ?? [])],
      additionalProperties: false,
    },
  };

  return {
    name: spec.name,
    description: spec.description,
    roles: spec.roles,
    schema,
    async run(ctx: VerbContext, input: I): Promise<VerbResult<O>> {
      const badCaller = checkCaller(ctx?.caller);
      if (badCaller) return fail(badCaller.code, badCaller.message);

      const role = ctx.caller.role;
      if (!spec.roles.includes(role)) {
        return fail(
          "forbidden",
          `${spec.name} requires role ${spec.roles.join(" or ")}; caller is ${role}`,
        );
      }

      let result: VerbResult<O>;
      try {
        result = await spec.handler(ctx, input ?? ({} as I));
      } catch (err) {
        // A verb must never throw at its caller. Anything that escapes a
        // handler — a bad fake, a PostgREST shape change — becomes typed here.
        const code = errorCodeFor(err);
        // An InvalidInputError is OUR text and is meant for the model. Anything
        // else is unknown provenance — a PostgREST/undici string that can quote
        // a constraint value, a row, or a request URL — so it is logged here and
        // NOT handed back. The code is the part the caller can act on.
        const raw = err instanceof Error ? err.message : String(err);
        if (code !== "invalid_input") console.error(`[verb ${spec.name}] ${scrub(raw)}`);
        const message =
          code === "invalid_input" ? raw : `${spec.name} failed (${code}); see the server log`;
        return fail(code, message);
      }
      if (!result.ok) return fail(result.error.code, result.error.message);
      return ok(stripMoney(result.data, role));
    },
  };
}

/** Map the few throw shapes the data layer actually produces onto codes. */
function errorCodeFor(err: unknown): VerbErrorCode {
  const name = err instanceof Error ? err.name : "";
  if (name === "InvalidInputError") return "invalid_input";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "internal";
}
