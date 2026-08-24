/**
 * agent-runner.test.mjs — the sandbox and the identity of one agent spawn.
 *
 * Nothing here spawns a process. What is tested is the two pure builders that
 * decide what a spawn IS, because every security property of the runner is a
 * property of their output:
 *
 *   buildArgs — the sandbox. One builder for every caller, so a rule cannot go
 *               missing from one path only.
 *   buildEnv  — the identity. Built from nothing rather than inherited, so a
 *               run is one employee and can be nothing else.
 *
 * These are the assertions that would fail loudly if someone "simplified" the
 * runner back toward what project-dashboard did on a single laptop, which is
 * exactly the regression worth catching: there, `env: process.env` and a
 * keychain login were correct; here they would hand every employee's run the
 * service-role key and somebody else's credentials.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildArgs, buildEnv, model, timeoutMs, SESSION_ID_RE } from "../lib/agent/runner.ts";

/** The flag list as a string, for "does it contain" checks. */
const flags = (args) => args.join(" ");

describe("buildArgs — the sandbox", () => {
  test("runs headless with a JSON envelope", () => {
    const args = buildArgs({});
    assert.ok(args.includes("-p"));
    assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), [
      "--output-format",
      "json",
    ]);
  });

  test("is NOT --bare", () => {
    // Bare mode never reads CLAUDE_CODE_OAUTH_TOKEN, so it cannot run as a
    // specific employee. This single fact is why the runner is the CLI at all;
    // adding --bare would silently collapse every run to one identity.
    assert.ok(!flags(buildArgs({})).includes("--bare"));
  });

  test("refuses every settings.json", () => {
    // Where hooks (arbitrary commands) and inherited allow-rules live. The
    // value is the empty string, so the assertion is positional, not a substring
    // match that an empty value would satisfy by accident.
    const args = buildArgs({});
    const i = args.indexOf("--setting-sources");
    assert.notEqual(i, -1);
    assert.equal(args[i + 1], "");
  });

  test("loads bcns-os as a plugin, relative to cwd", () => {
    // --setting-sources '' switches off skill discovery, which rides on the
    // user setting source. A plugin directory is read independently of it, so
    // this pair is what gives a run every os skill and no settings.json.
    // Relative, because cwd is already the os clone — an absolute path here
    // would be a second spelling of OS_DIR.
    const args = buildArgs({});
    const i = args.indexOf("--plugin-dir");
    assert.notEqual(i, -1);
    assert.equal(args[i + 1], ".");
  });

  test("carries CLAUDE.md in as system prompt text, and omits the flag when empty", () => {
    // `--setting-sources ''` suppresses project instructions along with
    // settings.json, so without this a run has the skills but none of the
    // house rules that tell it how to use them.
    const withIt = buildArgs({ instructions: "# bcns-os\nrule" });
    assert.equal(withIt[withIt.indexOf("--append-system-prompt") + 1], "# bcns-os\nrule");
    assert.ok(!buildArgs({}).includes("--append-system-prompt"));
    assert.ok(!buildArgs({ instructions: "   " }).includes("--append-system-prompt"));
  });

  test("fixes the tool set and does not include Bash", () => {
    const args = buildArgs({});
    const tools = args[args.indexOf("--tools") + 1].split(",");
    // Skill is what makes a skill button possible; the rest is file access.
    assert.deepEqual(tools, ["Read", "Edit", "Write", "Glob", "Grep", "Skill"]);
    assert.ok(!tools.includes("Bash"));
    assert.ok(!tools.includes("WebFetch"));
  });

  test("denies writes to every surface that auto-loads into a later session", () => {
    const settings = JSON.parse(buildArgs({})[buildArgs({}).indexOf("--settings") + 1]);
    const deny = settings.permissions.deny;
    for (const path of [
      "CLAUDE.md",
      "CLAUDE.local.md",
      "skills/**",
      "agents/**",
      ".claude/**",
      ".claude-plugin/**",
    ]) {
      assert.ok(deny.includes(`Write(${path})`), `missing Write(${path})`);
      assert.ok(deny.includes(`Edit(${path})`), `missing Edit(${path})`);
    }
  });

  test("the deny patterns are relative, never rebuilt from OS_DIR", () => {
    // An absolute pattern would be a second spelling of the same rule, and the
    // two spellings drift. cwd is already the os clone.
    const settings = JSON.parse(buildArgs({})[buildArgs({}).indexOf("--settings") + 1]);
    for (const rule of settings.permissions.deny) assert.ok(!rule.includes("/Users/"));
    for (const rule of settings.permissions.deny) assert.ok(!/\(\//.test(rule));
  });

  test("the prompt is never an argument", () => {
    // It goes on stdin. A prompt starting with `-` as argv would be parsed as
    // a flag, and the prompt is the one input a user composes freely.
    const args = buildArgs({ sessionId: undefined });
    assert.ok(!args.some((a) => a.includes("ask about")));
  });

  test("a session id is passed to --resume when given, and absent when not", () => {
    const id = "0f9a6c3e-1111-4222-8333-444455556666";
    const args = buildArgs({ sessionId: id });
    assert.equal(args[args.indexOf("--resume") + 1], id);
    assert.ok(!buildArgs({}).includes("--resume"));
  });

  test("the session id shape refuses a value that would parse as a flag", () => {
    // `--resume [value]` takes an OPTIONAL argument, so a `-`-prefixed value is
    // read as the CLI's own flag. `--dangerously-skip-permissions` there would
    // switch off everything above.
    assert.ok(!SESSION_ID_RE.test("--dangerously-skip-permissions"));
    assert.ok(!SESSION_ID_RE.test("../../etc/passwd"));
    assert.ok(SESSION_ID_RE.test("0f9a6c3e-1111-4222-8333-444455556666"));
  });
});

describe("buildEnv — the identity", () => {
  const TOKEN = "sk-ant-oat01-fake";

  test("the token is the only credential", () => {
    const env = buildEnv(TOKEN);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.deepEqual(Object.keys(env).sort(), ["CI", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"]);
  });

  test("nothing from the server's environment leaks into the child", () => {
    // The regression this exists to catch: project-dashboard passed
    // `env: process.env`, which here would hand a run the service-role key, the
    // sealing key, the database URL — and whichever token happened to be set.
    const before = { ...process.env };
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_leak_me";
    process.env.AGENT_TOKEN_KEY = "key_leak_me";
    process.env.DATABASE_URL = "postgres://leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-leak";
    try {
      const values = Object.values(buildEnv(TOKEN)).join(" ");
      assert.ok(!values.includes("leak"));
      const env = buildEnv(TOKEN);
      for (const name of [
        "SUPABASE_SERVICE_ROLE_KEY",
        "AGENT_TOKEN_KEY",
        "DATABASE_URL",
        "ANTHROPIC_API_KEY",
      ]) {
        assert.equal(env[name], undefined, `${name} reached the child`);
      }
    } finally {
      process.env = before;
    }
  });

  test("a different employee's spawn carries a different token", () => {
    assert.notEqual(buildEnv("token-a").CLAUDE_CODE_OAUTH_TOKEN, buildEnv("token-b").CLAUDE_CODE_OAUTH_TOKEN);
  });
});

describe("wall clock and model", () => {
  test("the default is the interactive budget", () => {
    assert.equal(timeoutMs(), 55_000);
    assert.equal(timeoutMs(0), 55_000);
    assert.equal(timeoutMs(NaN), 55_000);
  });

  test("a background job may ask for longer, up to the host ceiling", () => {
    assert.equal(timeoutMs(120_000), 120_000);
    assert.equal(timeoutMs(60 * 60_000), 10 * 60_000);
  });

  test("the model is overridable per call, then by env, then defaults", () => {
    const saved = process.env.CHAT_MODEL;
    try {
      delete process.env.CHAT_MODEL;
      assert.equal(model(), "sonnet");
      process.env.CHAT_MODEL = "opus";
      assert.equal(model(), "opus");
      assert.equal(model("haiku"), "haiku");
    } finally {
      if (saved === undefined) delete process.env.CHAT_MODEL;
      else process.env.CHAT_MODEL = saved;
    }
  });
});
