// Turns one parsed alert into a pushed branch: clone the repo, let Claude
// reproduce and fix it headlessly, commit whatever changed, push. If Claude
// changed nothing, a TRIAGE.md carrying its diagnosis is committed instead so
// the draft PR still opens with something to read. Never merges, never
// touches main: the only push is `-u origin alert/<fp>`.
//
// `exec` and `claudeRun` are injected (same shape as lib/claude.mjs's `run`),
// so a test asserts the exact command sequence without git, gh or the CLI.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile as fsWriteFile, rm as fsRm } from 'node:fs/promises'

export const TRIAGE_FILE = 'TRIAGE.md'
const LOG_CLIP = 6000
const TEXT_CLIP = 4000

// The whole instruction. Fixed on purpose: the alert is data, the job is not
// up for negotiation, and "do not commit" is what lets the caller tell a fix
// from a no-op by looking at the working tree.
export function buildPrompt({ alert, log }) {
  return [
    `You are fixing a production alert in this repository. Read CLAUDE.md first if it exists.`,
    ``,
    `ALERT (${alert.source}): ${alert.title}`,
    alert.summary ? `\n${alert.summary}` : '',
    Object.keys(alert.refs ?? {}).length ? `\nrefs: ${JSON.stringify(alert.refs)}` : '',
    log ? `\nFAILED LOG (tail):\n${log}` : '',
    ``,
    `Do exactly this, in order:`,
    `1. Reproduce or locate the failure from the evidence above and the code.`,
    `2. Find the root cause — grep every caller before touching a shared function.`,
    `3. Make the minimal fix. Add or adjust ONE test that fails without it.`,
    `4. Run the repo's test command and make sure it passes.`,
    `5. Do NOT commit, push, merge, or open a PR — the caller commits.`,
    `If you cannot find a confident fix, change nothing and instead write your diagnosis.`,
    `Finish with a short plain-text report: root cause, what you changed (or "no change"), how you verified it.`,
  ].join('\n')
}

function envelopeText(stdout) {
  const raw = String(stdout ?? '')
  try {
    const env = JSON.parse(raw)
    return typeof env?.result === 'string' ? env.result : raw
  } catch {
    return raw
  }
}

export function createFixer({
  exec,
  claudeRun = exec,
  dryRun = true,
  model = 'opus',
  maxTurns = 40,
  timeout = 15 * 60_000,
  setupGit = false,
  workdir = tmpdir(),
  writeFile = fsWriteFile,
  rm = fsRm,
  now = () => Date.now(),
} = {}) {
  return async function fix({ repo, branch, alert }) {
    if (dryRun) return { dryRun: true, repo, branch }
    if (typeof exec !== 'function') throw new Error('createFixer needs an exec — none was wired in')

    const dir = join(workdir, `alert-${branch.replace(/[^\w.-]+/g, '-')}-${now()}`)
    const git = (args) => exec('git', args, { cwd: dir })

    try {
      // On a runner `gh` holds the token and git does not; locally the ssh
      // key already covers both, and setup-git would rewrite ~/.gitconfig.
      if (setupGit) await exec('gh', ['auth', 'setup-git'])
      await exec('gh', ['repo', 'clone', repo, dir, '--', '--depth', '50'])
      await git(['config', 'user.name', 'bcns bot'])
      await git(['config', 'user.email', 'bot@bcn-services.com'])
      await git(['checkout', '-b', branch])

      let log = ''
      if (alert.source === 'github' && alert.refs?.runId) {
        try {
          const { stdout } = await exec('gh', ['run', 'view', alert.refs.runId, '--repo', repo, '--log-failed'])
          log = String(stdout ?? '').slice(-LOG_CLIP)
        } catch (err) {
          log = `(could not fetch run log: ${err.message})`
        }
      }

      let report
      try {
        const { stdout } = await claudeRun(
          'claude',
          ['-p', buildPrompt({ alert, log }), '--model', model, '--output-format', 'json',
            '--dangerously-skip-permissions', '--max-turns', String(maxTurns)],
          { cwd: dir, timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        report = envelopeText(stdout).slice(0, TEXT_CLIP)
      } catch (err) {
        report = `Claude run failed: ${err.message}\n${envelopeText(err.stdout).slice(0, 1000)}`.trim()
      }

      const { stdout: status } = await git(['status', '--porcelain'])
      const triageOnly = !String(status ?? '').trim()
      if (triageOnly) {
        await writeFile(join(dir, TRIAGE_FILE), `# Triage: ${alert.title}\n\nSource: ${alert.source}\n\n${report}\n`)
      }
      await git(['add', '-A'])
      await git(['commit', '-m', `${triageOnly ? 'triage' : 'fix'}: ${alert.title}`.slice(0, 200)])
      await git(['push', '-u', 'origin', branch])

      return { dryRun: false, repo, branch, triageOnly, report }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
