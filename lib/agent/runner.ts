/**
 * runner.ts — spawns one headless Claude agent as that employee.
 *
 * Ported from project-dashboard/src/lib/chat.ts, which had the parts that
 * matter already right: the prompt on stdin, a SIGKILL timeout, a stdout cap,
 * and one argv builder shared by every caller. Three things changed in the
 * move to a server that more than one person uses.
 *
 * 1. THE ENVIRONMENT IS BUILT, NOT INHERITED. project-dashboard passed
 *    `env: process.env`, which was correct there — one laptop, one person, the
 *    CLI's own keychain login. Here it would hand every employee's run the
 *    server's whole environment: SUPABASE_SERVICE_ROLE_KEY, AGENT_TOKEN_KEY,
 *    DATABASE_URL, and whichever employee's token happened to be set. The
 *    child gets an allowlist and its own token, so a run is that person and
 *    can be nothing else.
 *
 * 2. NOT `--bare`. Bare mode never reads CLAUDE_CODE_OAUTH_TOKEN, so it cannot
 *    run as a specific employee at all. This single fact is why the runner is
 *    the CLI rather than the Agent SDK, and it is why no flag here may become
 *    `--bare` later without the per-employee model going with it.
 *
 * 3. NOT `--safe-mode`. project-dashboard used it to switch off skills, MCP
 *    servers and hooks wholesale. The command center's entire point is running
 *    skills, so the sandbox is drawn with the narrower flags instead:
 *    `--setting-sources ''` still refuses every settings.json (which is where
 *    hooks and broad allow-rules live), `--tools` still fixes the tool set, and
 *    `--settings` still denies the write paths below.
 *
 * The sandbox boundary lives in the CLI's own permission layer, configured
 * here and nowhere else. Do not add a second path check in this file: two
 * rules deciding one thing is how the lister-vs-guard drift in lib/os/osFiles.ts
 * shipped four times.
 */

/*
 * No `server-only` import here, deliberately, and it is not an oversight. This
 * module holds no secret — the token arrives as a parameter — and its own
 * `node:child_process` import already makes a client bundle impossible. What
 * the import would cost is real: it throws under plain node, so it would put
 * buildArgs() and buildEnv() out of reach of the test suite, and those two
 * functions are where every security property of a spawn actually lives.
 * lib/agent/tokens.ts, which does hold secrets, keeps its `server-only`.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { osDir } from "../os/paths";

const execFileAsync = promisify(execFile);

/**
 * The tools a run may use. `Skill` is what makes a skill button possible;
 * everything else is file access inside the os clone.
 *
 * Bash is deliberately absent. A skill that shells out will fail rather than
 * run, and that is the intended failure — the developer skills (dev-team, the
 * dt-* agents, lane, ship) need a worktree and a real shell and stay
 * laptop-side by design. Adding Bash here would quietly move them server-side
 * with none of the isolation they assume.
 */
const AGENT_TOOLS = "Read,Edit,Write,Glob,Grep,Skill";

/**
 * The CLI's own spelling for "no tools at all" (`--tools ""`). For a run that
 * is a pure text→JSON transformation of somebody's free text: the text is
 * untrusted, so an injected instruction inside it must not reach a tool-capable
 * agent sitting in a writable clone of the os. NO_TOOLS is what that caller
 * passes, and it is enforced by the argv builder below rather than by trust.
 */
export const NO_TOOLS = "";

/**
 * Write paths denied inside the os clone. Each one auto-loads into future
 * Claude Code sessions, so a write there escapes the sandbox in TIME rather
 * than in space: the run ends, the instruction stays, and the next session
 * reads it. The same run can read `knowledge/` — which on the droplet includes
 * content nobody at bcns wrote — so this is not hypothetical.
 *
 *   CLAUDE.md, CLAUDE.local.md  → project instructions, every future session
 *   skills/**                   → the skills the buttons run
 *   agents/**                   → subagent definitions
 *   .claude/**                  → settings.json hooks are arbitrary commands
 *   .claude-plugin/**           → the plugin manifest can declare hooks too
 *   scripts/**                  → what a hook command would point AT
 *
 * Patterns are RELATIVE to cwd, which is already the os clone. `Write(X)` and
 * `Edit(X)` match at any depth, so a nested `projects/x/CLAUDE.md` is covered
 * by the bare pattern.
 */
const DENY_PATHS = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "skills/**",
  "agents/**",
  ".claude/**",
  ".claude-plugin/**",
  "scripts/**",
];
const DENY_SETTINGS = JSON.stringify({
  permissions: { deny: DENY_PATHS.flatMap((p) => [`Write(${p})`, `Edit(${p})`]) },
});

const DEFAULT_MODEL = "sonnet";

/**
 * Two timeouts, because this runner serves two callers with different
 * contracts. A button click is inside an HTTP response and has to answer;
 * a cron job at 4am does not, and a briefing that reads twenty files is not
 * a 55-second job.
 */
const INTERACTIVE_TIMEOUT_MS = 55_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

/** The JSON envelope is a few KB, but `result` can be long. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Keeps a runaway stderr dump out of an HTTP response body. */
const MAX_ERROR_SNIPPET = 400;
/** The reply becomes a response body too — cap it the way errors are capped. */
const MAX_REPLY_CHARS = 100_000;

/**
 * Blast-radius cap, not load control: each run is a process plus paid
 * inference against a write-capable tree, so a retry loop must not fan out.
 * Global rather than per-employee, because the limit being protected is the
 * droplet's, and the droplet is shared.
 *
 * ponytail: a counter, not a queue — a busy answer is honest at five people.
 * Add a queue when someone actually waits behind it.
 */
const DEFAULT_MAX_CONCURRENT = 2;

let inFlight = 0;
let loggedBin: string | null = null;

/**
 * `sessionId` becomes an argv element, so its shape is pinned next to the argv
 * builder that owns the rule.
 *
 * `--resume [value]` takes an OPTIONAL argument, so a `-`-prefixed value is not
 * consumed as the resume value — the CLI parses it as its own flag. A
 * sessionId of `--dangerously-skip-permissions` would therefore switch off
 * every protection above.
 */
export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentResult =
  | { ok: true; reply: string; sessionId: string | null }
  | { ok: false; error: string; timedOut?: boolean; busy?: boolean };

export interface AgentRunOptions {
  /** The employee's own CLAUDE_CODE_OAUTH_TOKEN, from lib/agent/tokens.ts. */
  token: string;
  /** Resume a prior run. Must be a UUID; see SESSION_ID_RE. */
  sessionId?: string;
  /** Raise the wall clock for a background job. Clamped to MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Model slug override; falls back to CHAT_MODEL then `sonnet`. */
  model?: string;
  /** Tool set for this run. `NO_TOOLS` disables every tool; omitted = AGENT_TOOLS. */
  tools?: string;
}

/** Model slug, tunable without a redeploy. */
export function model(override?: string): string {
  return override?.trim() || process.env.CHAT_MODEL?.trim() || DEFAULT_MODEL;
}

export function maxConcurrent(): number {
  const raw = Number(process.env.AGENT_MAX_CONCURRENT?.trim());
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_CONCURRENT;
}

/** Wall clock for one run: the caller's ask, clamped to what the host allows. */
export function timeoutMs(requested?: number): number {
  if (!Number.isFinite(requested) || (requested ?? 0) <= 0) return INTERACTIVE_TIMEOUT_MS;
  return Math.min(requested as number, MAX_TIMEOUT_MS);
}

/**
 * THE argv builder — every caller goes through this one. A second call site
 * assembling these flags itself is how a sandbox rule goes missing from one
 * path only, so the options here are the only knobs.
 */
export function buildArgs(opts: {
  sessionId?: string;
  model?: string;
  /** The os CLAUDE.md, read by the caller. See instructions(). */
  instructions?: string;
  /** See AgentRunOptions.tools. `""` is a real value here, not "unset". */
  tools?: string;
}): string[] {
  const args = [
    "-p",
    "--tools",
    opts.tools ?? AGENT_TOOLS,
    "--permission-mode",
    "acceptEdits",
    // Refuse every settings.json — user, project and local alike. This is what
    // keeps hooks (arbitrary commands) and inherited allow-rules out of a run.
    "--setting-sources",
    "",
    // ...and then load the skills back, from the os clone itself. Skill
    // discovery normally rides on the USER setting source, so the line above
    // would leave a run with only the CLI's bundled skills. A plugin directory
    // is read independently of setting sources, so this is the one way to have
    // all of bcns-os and none of anyone's settings.json. Skills arrive
    // namespaced: `bcns-os:pitch`, not `pitch`.
    //
    // "." because cwd IS the os clone (see runAgent). The manifest at
    // <os>/.claude-plugin/plugin.json is what makes the directory loadable, and
    // DENY_PATHS above keeps a run from editing it.
    //
    // CLAUDE.md does not travel inside a plugin — it loads because it sits at
    // cwd, which `--setting-sources ''` does not suppress.
    "--plugin-dir",
    ".",
    "--settings",
    DENY_SETTINGS,
    "--output-format",
    "json",
    "--model",
    model(opts.model),
  ];
  // CLAUDE.md is suppressed by `--setting-sources ''` — project instructions
  // load through the project setting source, and `--add-dir` does not bring
  // them back (both checked against the live CLI). It goes in as system prompt
  // text instead, which keeps the no-settings.json rule whole. The file is
  // write-denied above, so this is the same content a laptop session reads and
  // a run cannot edit what its next run will be told.
  if (opts.instructions?.trim()) args.push("--append-system-prompt", opts.instructions);
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  return args;
}

/**
 * The two files a laptop session starts with, concatenated. Both are suppressed
 * here for the same reason — `--setting-sources ''` — but by different settings:
 * CLAUDE.md by the project source, MEMORY.md by `autoMemoryDirectory`.
 *
 * MEMORY.md is the INDEX, not the facts. Each of its lines names a file, and a
 * run can already Read those files out of the same clone. On a laptop a
 * UserPromptSubmit hook keyword-matches this index per prompt; that hook is
 * doing a job the model does better once the index is simply in context, so it
 * is deliberately not carried over. Declaring it as a plugin hook would work —
 * plugin hooks do fire under `--setting-sources ''`, which is checked — but it
 * would reopen the arbitrary-command channel the flag exists to close.
 *
 * A missing file is not fatal: the run degrades to no house rules and no
 * memory rather than failing, because failing a request over a doc is worse.
 */
const CONTEXT_FILES = ["CLAUDE.md", "knowledge/memory/MEMORY.md"];

export async function instructions(dir: string): Promise<string> {
  const parts = await Promise.all(
    CONTEXT_FILES.map(async (rel) => {
      try {
        return await readFile(join(dir, rel), "utf-8");
      } catch (err) {
        console.warn("[agent] missing context file:", rel, "in", dir, err);
        return "";
      }
    }),
  );
  return parts.filter((p) => p.trim()).join("\n\n");
}

/**
 * The child's whole environment, built from nothing.
 *
 * PATH and HOME are here because the CLI needs to find node and its own config
 * directory. Everything else on the server — the service-role key, the sealing
 * key, the database URL — is absent by construction rather than by a denylist,
 * which is the difference between "we removed the secrets we thought of" and
 * "there are no secrets to remove".
 *
 * The token is the last key set, and it is the only credential the child has.
 *
 * Typed as a plain Record rather than NodeJS.ProcessEnv: Next augments that
 * type to require NODE_ENV, and a build-time constant has no business being
 * one of the four things this child is allowed to know.
 */
export function buildEnv(token: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    // Keeps a run's own output free of the colour codes and spinners that a
    // TTY-detecting CLI would otherwise embed in the JSON envelope.
    CI: "1",
    CLAUDE_CODE_OAUTH_TOKEN: token,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function snippet(value: unknown): string {
  return truncate(typeof value === "string" ? value.trim() : "", MAX_ERROR_SNIPPET);
}

/**
 * Resolves a bare command through PATH the way execFile will — for LOGGING
 * only, never for spawning. A service's PATH differs from an interactive
 * shell's, so `claude` there can be a different build than the one every check
 * was run against; this makes which one observable.
 */
export function resolveBin(bin: string): string {
  if (bin.includes("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here — keep walking PATH */
    }
  }
  return `${bin} (not found on PATH)`;
}

/** The binary to spawn, logged once per distinct value. */
function claudeBin(): string {
  const bin = process.env.CLAUDE_BIN?.trim() || "claude";
  if (bin !== loggedBin) {
    loggedBin = bin;
    console.info("[agent] claude binary:", resolveBin(bin));
  }
  return bin;
}

/** The agent's cwd must exist, or the CLI fails opaquely much later. */
async function checkOsDir(dir: string): Promise<string | null> {
  try {
    if (!(await stat(dir)).isDirectory()) return `OS_DIR is not a directory: ${dir}`;
    return null;
  } catch (err) {
    console.warn("[agent] checkOsDir failed:", dir, err);
    return `OS_DIR is not readable: ${dir}`;
  }
}

/** The ok/error decision for a terminal `result` envelope. */
function resultError(envelope: Record<string, unknown>): string | null {
  const { result, is_error, subtype } = envelope;
  if (is_error === true || (typeof subtype === "string" && subtype !== "success")) {
    return `agent errored (${subtype ?? "unknown"}): ${snippet(result) || "no detail"}`;
  }
  return null;
}

/**
 * The audit trail for one completed run. A write-capable agent mutating the
 * company's source of truth leaves a record, and a permission denial is the
 * only signal that a run probed the sandbox boundary.
 */
function logResult(envelope: Record<string, unknown>, profileId: string, ok: boolean): void {
  const { session_id, num_turns, total_cost_usd, permission_denials } = envelope;

  if (Array.isArray(permission_denials) && permission_denials.length > 0) {
    // Identity only, never the raw array: `tool_input` is the whole tool
    // payload, so a denied Write carries its `content` and would spill os file
    // text into the service log.
    const denials = permission_denials.map((d) => {
      const { tool_name, tool_input } = (d ?? {}) as {
        tool_name?: unknown;
        tool_input?: { file_path?: unknown };
      };
      return { tool_name, file_path: tool_input?.file_path };
    });
    console.warn("[agent] permission denials:", { profileId, sessionId: session_id, denials });
  }

  if (ok) {
    console.info("[agent] run:", {
      profileId,
      sessionId: session_id,
      num_turns,
      total_cost_usd,
    });
  }
}

function spawnFailure(
  err: NodeJS.ErrnoException & { killed?: boolean; stderr?: string },
  bin: string,
  timeout: number,
): AgentResult {
  if (err.code === "ENOENT") {
    return { ok: false, error: `claude CLI not found (tried "${bin}") — set CLAUDE_BIN to its absolute path` };
  }
  // node sets this code (and leaves `killed` undefined) when stdout/stderr
  // overflow maxBuffer — distinct from a timeout, and the CLI's stderr noise
  // would otherwise mask the real cause in the generic branch below.
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { ok: false, error: `agent output exceeded ${MAX_BUFFER_BYTES} bytes and was cut off` };
  }
  if (err.killed) {
    return { ok: false, error: `agent timed out after ${timeout}ms and was killed`, timedOut: true };
  }
  const detail = snippet(err.stderr) || snippet(err.message) || "unknown error";
  return { ok: false, error: `claude CLI failed: ${detail}` };
}

/** Pulls the reply out of the `--output-format json` envelope. */
function parseEnvelope(stdout: string, profileId: string): AgentResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    // Empty or non-JSON stdout at exit 0. Fail closed: a future CLI printing a
    // banner instead of an envelope must not read as a successful empty run.
    return { ok: false, error: `agent returned non-JSON output: ${snippet(stdout) || "(empty)"}` };
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return { ok: false, error: "agent returned a non-object JSON envelope" };
  }

  const record = envelope as Record<string, unknown>;
  const { result, session_id } = record;
  const reply = typeof result === "string" ? result : "";

  // Errors are decided BEFORE logging, so a denial warning still fires on a
  // failed run while the success-only run line does not.
  const error =
    resultError(record) ?? (reply.trim() === "" ? "agent returned no result text" : null);
  logResult(record, profileId, error === null);
  if (error) return { ok: false, error };

  return {
    ok: true,
    reply: truncate(reply, MAX_REPLY_CHARS),
    sessionId: typeof session_id === "string" ? session_id : null,
  };
}

/**
 * Run one prompt as `profileId`, using their token. Never throws — every
 * failure comes back as `{ ok: false, error }`, because every caller of this
 * is rendering a page or answering a request and has to say something.
 *
 * The prompt goes in on STDIN, never as an argv element: a prompt starting
 * with `-` would otherwise be parsed as a CLI flag, and the prompt is the one
 * input here that a user composes freely.
 */
export async function runAgent(
  profileId: string,
  prompt: string,
  opts: AgentRunOptions,
): Promise<AgentResult> {
  const { sessionId, token } = opts;
  if (!token.trim()) return { ok: false, error: "No agent token for this employee" };
  if (sessionId !== undefined && !SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: "sessionId must be a UUID" };
  }
  if (!prompt.trim()) return { ok: false, error: "Nothing to ask" };

  const cwd = osDir();
  const dirError = await checkOsDir(cwd);
  if (dirError) return { ok: false, error: dirError };

  if (inFlight >= maxConcurrent()) {
    return {
      ok: false,
      error: `the agent is busy — ${maxConcurrent()} runs already in flight`,
      busy: true,
    };
  }

  const bin = claudeBin();
  const args = buildArgs({
    sessionId,
    model: opts.model,
    tools: opts.tools,
    instructions: await instructions(cwd),
  });
  const timeout = timeoutMs(opts.timeoutMs);

  inFlight++;
  try {
    const pending = execFileAsync(bin, args, {
      cwd,
      // The cast is the same NODE_ENV augmentation as in buildEnv: node's own
      // typing accepts a partial environment, Next's augmented one does not.
      env: buildEnv(token) as NodeJS.ProcessEnv,
      encoding: "utf-8",
      timeout,
      // SIGTERM can be ignored; SIGKILL cannot, so a timed-out child dies.
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER_BYTES,
    });
    // A spawn failure (ENOENT) makes this write EPIPE — swallow it so the real
    // error surfaces from the awaited promise rather than as an unhandled
    // 'error' event that takes the server down.
    pending.child.stdin?.on("error", () => {});
    pending.child.stdin?.end(prompt);

    const { stdout } = await pending;
    return parseEnvelope(stdout, profileId);
  } catch (err) {
    // profileId, never the token, and never the environment that carried it.
    console.warn("[agent] run failed:", { bin, cwd, profileId, sessionId: sessionId ?? null }, err);
    return spawnFailure(err as NodeJS.ErrnoException, bin, timeout);
  } finally {
    inFlight--;
  }
}
