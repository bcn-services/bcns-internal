/**
 * os_publish — commit and push whatever a run left in the os clone.
 *
 * The os clone is how anything an agent writes (a memory file, a client index
 * bump) reaches the other machines. Without this verb a run's output lives on
 * one droplet until someone notices.
 *
 * THE TARGET IS INJECTED, ALWAYS. `ctx.osDir`, else `OS_DIR`. There is no
 * hard-coded `~/os` fallback here on purpose: a verb that defaults to a real
 * repo is a verb whose test suite eventually commits to it. No directory
 * configured is `not_configured`, not "guess".
 *
 * NEVER FORCE. The push is a plain `git push`; the argv is built from a fixed
 * array so nothing from an input can become a flag. A rejected push is a
 * reported failure, and the recovery is to rebase and try again — never to
 * overwrite whatever the other machine pushed.
 *
 * PULL-REBASE FIRST, and merge is switched off explicitly (`--rebase`,
 * `--no-autostash` omitted deliberately so a dirty tree is stashed rather than
 * refused). A merge commit here would mean an agent authoring a merge
 * resolution unsupervised.
 *
 * GIT_TERMINAL_PROMPT=0. Unattended git that hits a credential prompt does not
 * fail — it BLOCKS forever holding the run open. This turns that into an error.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineVerb, fail, ok, type VerbResult } from "./types";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_CHARS = 500;

export interface OsPublishInput {
  message: string;
  /** Skip the network half — commit locally only. */
  push?: boolean;
}

export interface OsPublishResult {
  dir: string;
  committed: boolean;
  pushed: boolean;
  /** Paths in the commit, so a caller can see what actually went out. */
  files: string[];
  message: string;
}

/** Minimal environment for git: enough to run, nothing that is a secret. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    // Never prompt. An unattended prompt is an unbounded hang, not a failure.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    // Identity, so a bare droplet clone with no user.email can still commit.
    GIT_AUTHOR_NAME: "bcns agent",
    GIT_AUTHOR_EMAIL: "agent@bcn-services.com",
    GIT_COMMITTER_NAME: "bcns agent",
    GIT_COMMITTER_EMAIL: "agent@bcn-services.com",
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

async function git(dir: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
      // Cast as in lib/agent/runner.ts: next-env.d.ts augments ProcessEnv with a
      // required NODE_ENV, which a built-from-scratch env deliberately omits.
      env: gitEnv() as NodeJS.ProcessEnv,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, error: (e.stderr || e.stdout || e.message || String(err)).trim() };
  }
}

export const os_publish = defineVerb<OsPublishInput, OsPublishResult>({
  name: "os_publish",
  description:
    "Admin only. Commit every change in the os clone and push it, pull-rebasing first. " +
    "Returns which files went out. Does nothing and reports committed:false when the tree is clean.",
  roles: ["admin"],
  properties: {
    message: { type: "string", description: "Commit message — say what changed and why." },
    push: { type: "boolean", description: "Push after committing. Default true." },
  },
  required: ["message"],
  async handler(ctx, input): Promise<VerbResult<OsPublishResult>> {
    const dir = (ctx.osDir ?? process.env.OS_DIR ?? "").trim();
    if (!dir) {
      return fail("not_configured", "os_publish: no os directory configured (set OS_DIR or ctx.osDir)");
    }
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message) return fail("invalid_input", "os_publish needs a commit message");
    if (message.length > MAX_MESSAGE_CHARS) {
      return fail("invalid_input", `commit message is longer than ${MAX_MESSAGE_CHARS} characters`);
    }

    const isRepo = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    if (!isRepo.ok) return fail("not_configured", `os_publish: ${dir} is not a git work tree`);

    const staged = await git(dir, ["add", "-A"]);
    if (!staged.ok) return fail("internal", `os_publish (add): ${staged.error}`);

    const status = await git(dir, ["status", "--porcelain"]);
    if (!status.ok) return fail("internal", `os_publish (status): ${status.error}`);
    if (status.out === "") {
      return ok({ dir, committed: false, pushed: false, files: [], message });
    }
    // Parsed BEFORE the commit — afterwards the tree is clean and there is
    // nothing left to list.
    const files = status.out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    // `--` ends option parsing so a message beginning with a dash is a message.
    const committed = await git(dir, ["commit", "-m", message, "--"]);
    if (!committed.ok) return fail("internal", `os_publish (commit): ${committed.error}`);

    if (input.push === false) return ok({ dir, committed: true, pushed: false, files, message });

    // No remote is a legitimate local-only clone, not a failure: the commit
    // happened, and saying so is more useful than inventing an error.
    const remotes = await git(dir, ["remote"]);
    if (!remotes.ok || remotes.out === "") {
      return ok({ dir, committed: true, pushed: false, files, message });
    }

    const rebased = await git(dir, ["pull", "--rebase"]);
    if (!rebased.ok) {
      return fail(
        "internal",
        `os_publish (pull --rebase): ${rebased.error}. The commit is local; resolve by hand — nothing was force-pushed.`,
      );
    }
    const pushed = await git(dir, ["push"]);
    if (!pushed.ok) return fail("internal", `os_publish (push): ${pushed.error}`);

    return ok({ dir, committed: true, pushed: true, files, message });
  },
});
