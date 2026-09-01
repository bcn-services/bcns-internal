# Engineer Report
**Task:** item 15 — headless-skill runner (`lib/skills.mjs`), os push helper (`lib/osrepo.mjs`), clock.yml wiring, buildDeps injection
**Branch:** item/0015-skills
**Date:** 2026-09-01

## Design Decisions
- `runSkill` parses the `result` field of the `--output-format json` envelope, falling back to raw stdout if it is not JSON; the test fake produces the real envelope shape.
- Return shape is LANE's `{ wrote: [], repo, dryrun }`; `dryrun` is an array (parallel to `wrote`) since a skill can print several DRYRUN lines. `repo` is the last REPO line.
- Invocation is claudeClient's verbatim (`-p`, `--model sonnet`, `--output-format json`) plus `cwd`; a test asserts `--bare` is absent, per the known failure mode.
- `commitAndPush` takes an explicit `dryRun` parameter (defaulting to `true`, i.e. safe) — no `process.env` read inside the module; `buildDeps` binds it to `deps.dryRun`.
- Only three exact line prefixes are matched by one regex; every other output line is ignored and nothing from Claude's output is executed.
- `runSkill`/`commitAndPush`/`osDir` are gated on `OS_DIR`, matching the existing `readVoiceRules` rule, so a run with no clone has no capability rather than a broken one.

## Files Changed
- `lib/claude.mjs` — exported the module-local `run = promisify(execFile)` so skills.mjs wraps it and tests inject a fake.
- `lib/skills.mjs` — new; `runSkill({ command, cwd, run, model, timeout })`, prefix parsing, non-zero exit rethrown naming the command.
- `lib/osrepo.mjs` — new; `commitAndPush({ exec, dir, paths, message, dryRun })`, add → commit → pull --rebase → push, returns `{ dryRun, commands }`.
- `jobs/run.mjs` — `buildDeps` injects `osDir`, `runSkill` (cwd bound to OS_DIR), `commitAndPush` (dir + dryRun bound) under `if (env.OS_DIR)`.
- `.github/workflows/clock.yml` — new "Wire ~/os skills and git identity" step between the os checkout and Authenticate/Run job: symlinks `$OS_DIR/skills` → `~/.claude/skills`, sets `git -C "$OS_DIR" config user.name/email`.
- `package.json` — `tests/skills.test.mjs` appended to the `test` script list.
- `tests/skills.test.mjs` — new; 7 tests covering all four `done when:` criteria.

## Deferred / Out of Scope
- No job calls `runSkill`/`commitAndPush` yet — item 15 builds the capability only.
- No retry on a rejected push: a non-fast-forward propagates, since force-push is forbidden and a human should look.

## Flags for Reviewer
- **Live-path risk:** the `Check out ~/os` step sets `persist-credentials: false`, so `git push` inside `$OS_DIR` has no credentials — a live (`DRY_RUN=false`) `commitAndPush` will fail at push. Fixing it means either flipping that flag or setting a credential-bearing remote; out of scope for this item but it will bite whoever wires the first pushing job.
- `runSkill` timeout defaults to 600s (a skill run is far slower than an `ask`), which exceeds clock.yml's `timeout-minutes: 10` job budget — the workflow will kill the run first.
- `maxBuffer` is 8MB, same as claudeClient; a very chatty skill run could exceed it and reject.

## Guardrails Reasoned About
- "never runs at all when DRY_RUN is on" — implemented as an injected `dryRun` defaulting to `true`, so an omitted flag cannot push; asserted by a test.
- "never touches main of this repo" — the git identity is set with `git -C "$OS_DIR"` only, and a test asserts every `git config` line in the step carries `-C`.
