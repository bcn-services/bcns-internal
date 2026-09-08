import { test } from 'node:test'
import assert from 'node:assert/strict'

import { childEnv, createFixer, buildPrompt, TRIAGE_FILE } from '../lib/fixer.mjs'

const ALERT = {
  source: 'github',
  title: 'Run failed: clock - main (45e294b)',
  summary: 'clock failed',
  refs: { runId: '123', workflow: 'clock', branch: 'main' },
}

// Records every command; `porcelain` is what `git status --porcelain` says
// after Claude ran, so a test picks "fix" or "no change".
function harness({ porcelain = ' M jobs/run.mjs', claudeThrows = false } = {}) {
  const calls = []
  const files = {}
  const exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args])
    if (cmd === 'git' && args[0] === 'status') return { stdout: porcelain }
    if (cmd === 'gh' && args[0] === 'run') return { stdout: 'step X failed\nError: boom' }
    if (cmd === 'claude') {
      if (claudeThrows) throw Object.assign(new Error('exit 1'), { stdout: '{"result":"gave up"}' })
      return { stdout: JSON.stringify({ result: 'root cause: heartbeat missing' }) }
    }
    return { stdout: '' }
  }
  const removed = []
  const fixer = createFixer({
    exec,
    dryRun: false,
    workdir: '/work',
    now: () => 7,
    writeFile: async (path, body) => {
      files[path] = body
    },
    rm: async (path) => removed.push(path),
  })
  return { fixer, calls, files, removed }
}

const DIR = '/work/alert-alert-abc123def456-7'

test('a fix runs clone → branch → failed log → claude → commit → push, in that order, and never merges', async () => {
  const { fixer, calls, files, removed } = harness()
  const out = await fixer({ repo: 'bcn-services/bcns-internal', branch: 'alert/abc123def456', alert: ALERT })

  assert.deepEqual(
    calls.map((c) => c.slice(0, 2).join(' ')),
    ['gh repo', 'git config', 'git config', 'git checkout', 'gh run', 'claude -p', 'git status', 'git add', 'git commit', 'git push']
  )
  assert.deepEqual(calls[0], ['gh', 'repo', 'clone', 'bcn-services/bcns-internal', DIR, '--', '--depth', '50'])
  assert.deepEqual(calls[3], ['git', 'checkout', '-b', 'alert/abc123def456'])
  assert.deepEqual(calls[4], ['gh', 'run', 'view', '123', '--repo', 'bcn-services/bcns-internal', '--log-failed'])
  const claude = calls[5]
  assert.match(claude[2], /Error: boom/, 'the failed log reaches the prompt')
  assert.match(claude[2], /Do NOT commit/)
  assert.ok(claude.includes('--dangerously-skip-permissions'))
  assert.ok(claude.includes('--max-turns'))
  assert.deepEqual(calls[8], ['git', 'commit', '-m', 'fix: Run failed: clock - main (45e294b)'])
  assert.deepEqual(calls[9], ['git', 'push', '-u', 'origin', 'alert/abc123def456'])
  assert.ok(!calls.some((c) => c[1] === 'merge' || (c[1] === 'pr' && c[2] === 'merge')), 'no git merge, no gh pr merge')
  assert.ok(!calls.some((c) => c[1] === 'push' && c.includes('main')), 'no push to main')
  assert.deepEqual(Object.keys(files), [], 'a real fix writes no TRIAGE.md')
  assert.equal(out.triageOnly, false)
  assert.match(out.report, /heartbeat missing/)
  assert.deepEqual(removed, [DIR], 'the clone is removed afterwards')
})

test('no change from claude commits TRIAGE.md with the diagnosis instead, and a claude crash still triages', async () => {
  const a = harness({ porcelain: '' })
  const out = await a.fixer({ repo: 'acme/x', branch: 'alert/000000000000', alert: ALERT })
  assert.equal(out.triageOnly, true)
  assert.deepEqual(Object.keys(a.files), ['/work/alert-alert-000000000000-7/' + TRIAGE_FILE])
  assert.match(Object.values(a.files)[0], /heartbeat missing/)
  assert.ok(a.calls.some((c) => c[1] === 'commit' && c[3].startsWith('triage:')))
  assert.ok(a.calls.some((c) => c[1] === 'push'))

  const b = harness({ porcelain: '', claudeThrows: true })
  const crashed = await b.fixer({ repo: 'acme/x', branch: 'alert/000000000000', alert: ALERT })
  assert.equal(crashed.triageOnly, true)
  assert.match(Object.values(b.files)[0], /Claude run failed.*exit 1[\s\S]*gave up/)
})

test('dry run executes nothing; a non-github alert fetches no run log', async () => {
  let ran = 0
  const dry = createFixer({ exec: async () => ran++, dryRun: true })
  assert.deepEqual(await dry({ repo: 'a/b', branch: 'alert/x', alert: ALERT }), { dryRun: true, repo: 'a/b', branch: 'alert/x' })
  assert.equal(ran, 0)

  const { fixer, calls } = harness()
  await fixer({ repo: 'a/b', branch: 'alert/x', alert: { source: 'sentry', title: 'TypeError', refs: {} } })
  assert.ok(!calls.some((c) => c[0] === 'gh' && c[1] === 'run'))
  assert.match(buildPrompt({ alert: { source: 'sentry', title: 'TypeError', refs: {} }, log: '' }), /ALERT \(sentry\): TypeError/)
})

test('the claude child sees no DB, mail or GitHub secrets — only its own token', () => {
  const env = childEnv({
    PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'keep', GH_TOKEN: 'x', GITHUB_TOKEN: 'x',
    DATABASE_URL: 'x', SMTP_PASS: 'x', IMAP_PASS: 'x', SUPABASE_SERVICE_KEY: 'x', OS_SECRET: 'x',
  })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'keep' })
})
