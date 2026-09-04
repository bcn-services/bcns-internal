import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

import { runSkill, normalizeDashes } from '../lib/skills.mjs'
import { commitAndPush } from '../lib/osrepo.mjs'
import { buildDeps } from '../jobs/run.mjs'

// The real CLI wraps the text in a `--output-format json` envelope, so the
// fake does too — a fake that returned bare text would prove nothing.
const envelope = (result) => ({ stdout: JSON.stringify({ result }) })

test('runSkill returns the parsed WROTE paths, and only the three prefixes', async () => {
  const calls = []
  const out = await runSkill({
    command: '/quote acme',
    cwd: '/w/os',
    run: async (...args) => {
      calls.push(args)
      return envelope(
        [
          "I'll write the quote now.",
          'WROTE: /w/os/outputs/acme-quote.html',
          'WROTE: /w/os/outputs/acme-scope.md',
          'REPO: https://github.com/bcn-services/acme',
          'DRYRUN: gh repo create acme --private',
          'rm -rf / # not a declared prefix, ignored',
          '  WROTE: /w/os/outputs/trailing.md  ',
        ].join('\n')
      )
    },
  })

  assert.deepEqual(out.wrote, [
    '/w/os/outputs/acme-quote.html',
    '/w/os/outputs/acme-scope.md',
    '/w/os/outputs/trailing.md',
  ])
  assert.equal(out.repo, 'https://github.com/bcn-services/acme')
  assert.deepEqual(out.dryrun, ['gh repo create acme --private'])

  // Same invocation as claudeClient, plus cwd. Never --bare: that strips the
  // Skill tool from the model's tools and the skill silently does nothing.
  const [bin, argv, opts] = calls[0]
  assert.equal(bin, 'claude')
  assert.deepEqual(argv, ['-p', '/quote acme', '--model', 'sonnet', '--output-format', 'json', '--dangerously-skip-permissions'])
  assert.equal(argv.includes('--bare'), false)
  assert.equal(opts.cwd, '/w/os')
})

test('runSkill throws, naming the command, when the CLI exits non-zero', async () => {
  await assert.rejects(
    runSkill({
      command: '/pitch bolt',
      cwd: '/w/os',
      run: async () => {
        throw Object.assign(new Error('Command failed: claude'), { code: 1 })
      },
    }),
    /skill run failed for "\/pitch bolt"/
  )
})

test('commitAndPush runs add, commit, pull --rebase, push, in that order', async () => {
  const calls = []
  const out = await commitAndPush({
    exec: async (bin, args, opts) => calls.push([bin, args, opts]),
    dir: '/w/os',
    paths: ['outputs/acme-quote.html'],
    message: 'chore: acme quote',
    dryRun: false,
  })

  assert.deepEqual(
    calls.map((c) => c[1]),
    [
      ['add', 'outputs/acme-quote.html'],
      ['commit', '-m', 'chore: acme quote'],
      ['pull', '--rebase'],
      ['push'],
    ]
  )
  assert.ok(calls.every((c) => c[0] === 'git' && c[2].cwd === '/w/os'))
  assert.equal(out.dryRun, false)
  // No force push exists on any path.
  assert.equal(JSON.stringify(calls).includes('--force'), false)
})

test('a throw from push propagates, with no further exec calls', async () => {
  const calls = []
  await assert.rejects(
    commitAndPush({
      exec: async (_bin, args) => {
        calls.push(args[0])
        if (args[0] === 'push') throw new Error('rejected: non-fast-forward')
      },
      dir: '/w/os',
      paths: ['a.md'],
      message: 'm',
      dryRun: false,
    }),
    /non-fast-forward/
  )
  assert.deepEqual(calls, ['add', 'commit', 'pull', 'push'])
})

test('commitAndPush under dry run makes zero exec calls and returns the commands', async () => {
  let called = 0
  const out = await commitAndPush({
    exec: async () => called++,
    dir: '/w/os',
    paths: ['outputs/acme quote.html'],
    message: 'chore: acme quote',
    dryRun: true,
  })
  assert.equal(called, 0)
  assert.equal(out.dryRun, true)
  assert.deepEqual(out.commands, [
    "git add 'outputs/acme quote.html'",
    "git commit -m 'chore: acme quote'",
    'git pull --rebase',
    'git push',
  ])
  // Dry run is the default: an omitted flag must never push.
  assert.equal((await commitAndPush({ exec: async () => called++, dir: '/w/os' })).dryRun, true)
  assert.equal(called, 0)
})

test('buildDeps injects runSkill, commitAndPush and osDir only with OS_DIR', async () => {
  const bare = await buildDeps({})
  assert.equal(bare.runSkill, undefined)
  assert.equal(bare.commitAndPush, undefined)
  assert.equal(bare.osDir, undefined)

  // `exists` is injected so the test stays off the filesystem; the real
  // default is existsSync, and the directory — not the variable — is the gate.
  const yes = () => true
  const deps = await buildDeps({ OS_DIR: '/w/os' }, yes)
  assert.equal(deps.osDir, '/w/os')
  assert.equal(typeof deps.runSkill, 'function')
  assert.equal(typeof deps.commitAndPush, 'function')

  // DRY_RUN is on unless explicitly 'false', and the binding carries it.
  let called = 0
  const dry = await deps.commitAndPush({ exec: async () => called++, paths: ['a'], message: 'm' })
  assert.equal(called, 0)
  assert.equal(dry.dryRun, true)

  const live = await buildDeps({ OS_DIR: '/w/os', DRY_RUN: 'false' }, yes)
  await live.commitAndPush({ exec: async () => called++, paths: ['a'], message: 'm' })
  assert.equal(called, 4)

  // The injected cwd is the clone, so the CLI finds the skills.
  let seen
  await deps.runSkill({ command: '/pitch x', run: async (_b, _a, o) => ((seen = o), envelope('')) })
  assert.equal(seen.cwd, '/w/os')
})

// Fix 2 — clock.yml sets OS_DIR unconditionally, so the variable proves
// nothing. A set-but-missing directory must degrade to "no ~/os capability",
// which is what every job's `!osDir` skip already claims to handle.
test('OS_DIR pointing at a directory that is not there yields no ~/os capability', async () => {
  const probed = []
  const deps = await buildDeps({ OS_DIR: '/w/os' }, (p) => (probed.push(p), false))
  assert.deepEqual(probed, ['/w/os'])
  assert.equal(deps.osDir, undefined)
  assert.equal(deps.runSkill, undefined)
  assert.equal(deps.commitAndPush, undefined)
  // The voice rules live in the same clone and go the same way.
  assert.equal(deps.readVoiceRules, undefined)
})

test('clock.yml wires the skills symlink between the os checkout and the job', () => {
  const clock = parse(
    readFileSync(new URL('../.github/workflows/clock.yml', import.meta.url), 'utf8')
  )
  const steps = clock.jobs.run.steps
  const names = steps.map((s) => s.name ?? s.uses)
  const checkout = names.indexOf('Check out ~/os')
  const wire = names.indexOf('Wire ~/os skills and git identity')
  const job = names.indexOf('Run job')
  assert.ok(checkout >= 0 && wire > checkout && job > wire, names.join(', '))

  const run = steps[wire].run
  assert.match(run, /ln -sfn "\$OS_DIR\/skills" ~\/\.claude\/skills/)
  assert.match(run, /config user\.name 'bcns bot'/)
  assert.match(run, /config user\.email 'bot@bcn-services\.com'/)
  // The identity is set inside the clone, never on this repo.
  assert.ok(run.split('\n').filter((l) => l.includes('git config')).every((l) => l.includes('-C')))
})

test('normalizeDashes rewrites em and en dashes in written markdown, skips html and missing paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'))
  const md = join(dir, 'email.md')
  const html = join(dir, 'demo.html')
  writeFileSync(md, 'Hi Nate — quotes for Acme – phone only.\n')
  writeFileSync(html, '<title>Acme — Mock</title>')
  await normalizeDashes([md, html, join(dir, 'missing.md')])
  assert.equal(readFileSync(md, 'utf8'), 'Hi Nate, quotes for Acme, phone only.\n')
  assert.equal(readFileSync(html, 'utf8'), '<title>Acme — Mock</title>')
})
