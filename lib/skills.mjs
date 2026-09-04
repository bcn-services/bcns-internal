// Runs one ~/os skill headlessly and reads back only what the skill declared.
//
// Same CLI invocation as claudeClient — `-p`, `--model`, `--output-format
// json` — plus a `cwd` so the run happens inside $OS_DIR, where the skills
// live. Never `--bare`: that flag strips the Skill tool out of the model's
// tool list, so a skill run under it silently does nothing.
//
// Only three exact line prefixes are parsed out of the skill's output:
//
//   WROTE: <abs path>
//   REPO: <url>
//   DRYRUN: <cmd>
//
// Everything else Claude says is prose and is ignored. Nothing here executes
// anything the model wrote; the caller decides what to do with the paths.

import { readFile, writeFile } from 'node:fs/promises'
import { run as defaultRun } from './claude.mjs'

const PREFIX = /^(WROTE|REPO|DRYRUN):[ \t]*(.+?)[ \t]*$/

export async function runSkill({
  command,
  cwd,
  run = defaultRun,
  model = 'sonnet',
  timeout = 600_000,
} = {}) {
  let stdout
  try {
    ;({ stdout } = await run(
      'claude',
      // The skill writes files. Headless `-p` has no one to answer a
      // permission prompt, so every Write is denied without this flag and
      // the skill "succeeds" having written nothing (seen on the runner).
      ['-p', command, '--model', model, '--output-format', 'json', '--dangerously-skip-permissions'],
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    ))
  } catch (err) {
    throw new Error(`skill run failed for ${JSON.stringify(command)}: ${err.message}`)
  }

  // `--output-format json` wraps the text in an envelope; the skill's lines
  // live in `result`. A plain-text stdout is accepted too, so a CLI that ever
  // stops wrapping does not silently return nothing.
  let text = String(stdout ?? '')
  let denials = 0
  try {
    const envelope = JSON.parse(text)
    text = typeof envelope?.result === 'string' ? envelope.result : text
    denials = envelope?.permission_denials?.length ?? 0
  } catch {
    // not JSON — read the raw text
  }

  // `text`/`denials` are diagnostics for the "wrote nothing" event only.
  const out = { wrote: [], repo: undefined, dryrun: [], text: text.slice(0, 500), denials }
  for (const line of text.split('\n')) {
    const m = PREFIX.exec(line.trim())
    if (!m) continue
    if (m[1] === 'WROTE') out.wrote.push(m[2])
    else if (m[1] === 'REPO') out.repo = m[2]
    else out.dryrun.push(m[2])
  }
  return out
}

// Every ~/os voice rule bans em and en dashes, and the model keeps writing
// them anyway. Normalise the markdown the skill wrote, the same way
// personalize treats its one generated sentence, instead of failing the tick.
// A path that does not exist is left to `git add` to complain about.
export async function normalizeDashes(paths) {
  for (const path of paths) {
    if (!path.endsWith('.md')) continue
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') continue
      throw err
    }
    const fixed = text.replace(/ ?[—–] ?/g, ', ')
    if (fixed !== text) await writeFile(path, fixed)
  }
}
