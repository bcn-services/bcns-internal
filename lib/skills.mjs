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
      ['-p', command, '--model', model, '--output-format', 'json'],
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    ))
  } catch (err) {
    throw new Error(`skill run failed for ${JSON.stringify(command)}: ${err.message}`)
  }

  // `--output-format json` wraps the text in an envelope; the skill's lines
  // live in `result`. A plain-text stdout is accepted too, so a CLI that ever
  // stops wrapping does not silently return nothing.
  let text = String(stdout ?? '')
  try {
    const envelope = JSON.parse(text)
    text = typeof envelope?.result === 'string' ? envelope.result : text
  } catch {
    // not JSON — read the raw text
  }

  const out = { wrote: [], repo: undefined, dryrun: [] }
  for (const line of text.split('\n')) {
    const m = PREFIX.exec(line.trim())
    if (!m) continue
    if (m[1] === 'WROTE') out.wrote.push(m[2])
    else if (m[1] === 'REPO') out.repo = m[2]
    else out.dryrun.push(m[2])
  }
  return out
}
