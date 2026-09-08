import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseAlert, resolveRepo, loadClientMap } from '../lib/alerts.mjs'

test('github: run-failed mail on a branch', () => {
  const from = 'notifications@github.com'
  const subject = '[bcn-services/bcns-internal] Run failed: clock - main (45e294b)'
  const text = '[bcn-services/bcns-internal] clock workflow run\n\nclock: All jobs have failed\n\nView workflow run\n'
  const html = '<a href="https://github.com/bcn-services/bcns-internal/actions/runs/987654321">View workflow run</a>'

  const parsed = parseAlert({ from, subject, text, html })

  assert.equal(parsed.source, 'github')
  assert.equal(parsed.repo, 'bcn-services/bcns-internal')
  assert.equal(parsed.refs.workflow, 'clock')
  assert.equal(parsed.refs.branch, 'main')
  assert.equal(parsed.refs.sha, '45e294b')
  assert.equal(parsed.refs.runId, '987654321')
  assert.equal(parsed.refs.runUrl, 'https://github.com/bcn-services/bcns-internal/actions/runs/987654321')
  assert.equal(parsed.fingerprintSeed, 'github:bcn-services/bcns-internal:clock:main')
  assert.ok(parsed.summary.length <= 600)
})

test('github: PR run failed mail dedupes across shas by workflow+branch', () => {
  const parsed = parseAlert({
    from: 'notifications@github.com',
    subject: '[org/repo] PR run failed: build - Fix the thing',
    text: 'PR run failed',
    html: '',
  })

  assert.equal(parsed.source, 'github')
  assert.equal(parsed.repo, 'org/repo')
  assert.equal(parsed.refs.workflow, 'build')
  // No branch in this subject form — seed still forms, just with an empty branch slot.
  assert.equal(parsed.fingerprintSeed, 'github:org/repo:build:')
})

test('sentry: [Sentry] [project] subject with an issue link', () => {
  const parsed = parseAlert({
    from: 'alerts@sentry.io',
    subject: '[Sentry] [my-project] TypeError: Cannot read properties of undefined',
    text: 'TypeError: Cannot read properties of undefined\n\nlib/handler.js in processRequest\n',
    html: '<a href="https://my-org.sentry.io/issues/4552112233/">View Issue</a>',
  })

  assert.equal(parsed.source, 'sentry')
  assert.equal(parsed.repo, null)
  assert.equal(parsed.refs.project, 'my-project')
  assert.equal(parsed.refs.issueUrl, 'https://my-org.sentry.io/issues/4552112233/')
  assert.equal(parsed.fingerprintSeed, 'sentry:4552112233')
  assert.match(parsed.title, /TypeError/)
})

test('sentry: "New alert from <project>" subject with no issue link falls back to project+title seed', () => {
  const parsed = parseAlert({
    from: 'noreply@md.getsentry.com',
    subject: 'New alert from backend-api: 3 events in the last hour',
    text: 'Alert triggered',
    html: '',
  })

  assert.equal(parsed.source, 'sentry')
  assert.equal(parsed.refs.project, 'backend-api')
  assert.equal(parsed.fingerprintSeed, 'sentry:backend-api:3 events in the last hour')
})

test('uptimerobot: DOWN mail', () => {
  const parsed = parseAlert({
    from: 'alert@uptimerobot.com',
    subject: 'Monitor is DOWN: bcns site ( https://bcn-services.com )',
    text: 'Your monitor bcns site is currently down.',
  })

  assert.equal(parsed.source, 'uptimerobot')
  assert.equal(parsed.resolved, false)
  assert.equal(parsed.refs.monitorName, 'bcns site')
  assert.equal(parsed.refs.monitorUrl, 'https://bcn-services.com')
  assert.equal(parsed.refs.host, 'bcn-services.com')
  assert.equal(parsed.fingerprintSeed, 'uptimerobot:bcn-services.com')
  assert.match(parsed.title, /^DOWN:/)
})

test('uptimerobot: UP mail is resolved and ignorable by title', () => {
  const parsed = parseAlert({
    from: 'alert@uptimerobot.com',
    subject: 'Monitor is UP: bcns site ( https://bcn-services.com )',
    text: 'Your monitor bcns site is back up.',
  })

  assert.equal(parsed.resolved, true)
  assert.match(parsed.title, /^UP:/)
  assert.equal(parsed.fingerprintSeed, 'uptimerobot:bcn-services.com')
})

test('unknown: anything else passes through as source unknown', () => {
  const parsed = parseAlert({ from: 'someone@example.com', subject: 'hello', text: 'x'.repeat(1000) })

  assert.equal(parsed.source, 'unknown')
  assert.equal(parsed.repo, null)
  assert.equal(parsed.title, 'hello')
  assert.equal(parsed.fingerprintSeed, null)
  assert.equal(parsed.summary.length, 600)
})

test('resolveRepo: a repo named by the mail is only used when it is a known repo', () => {
  const parsed = { repo: 'bcn-services/bcns-internal', refs: { project: 'other' } }
  const known = {
    fallback: 'bcn-services/bcns-internal',
    map: { other: 'wrong/repo' },
    clients: [{ name: 'other', github: 'https://github.com/wrong/repo2' }],
  }
  assert.equal(resolveRepo(parsed, known), 'bcn-services/bcns-internal')
  // Forged subject naming a repo nobody configured: falls through to the map,
  // never to the attacker's repo.
  assert.equal(resolveRepo({ repo: 'evil/repo', refs: { project: 'other' } }, known), 'wrong/repo')
  assert.equal(resolveRepo({ repo: 'evil/repo', refs: {} }, { fallback: 'bcn-services/bcns-internal' }), null)
  // Known via map value or client README, any case.
  assert.equal(resolveRepo({ repo: 'Wrong/Repo2', refs: {} }, known), 'Wrong/Repo2')
})

test('parseAlert: a forwarded GitHub failure is recognised by subject alone', () => {
  const parsed = parseAlert({
    from: 'Nate <nseluga@bcn-services.com>',
    subject: 'Fwd: [bcn-services/bcns-internal] Run failed: clock - main (45e294b)',
    text: 'forwarded\nhttps://github.com/bcn-services/bcns-internal/actions/runs/34190000000',
  })
  assert.equal(parsed.source, 'github')
  assert.equal(parsed.repo, 'bcn-services/bcns-internal')
  assert.equal(parsed.refs.runId, '34190000000')
  assert.equal(parsed.fingerprintSeed, 'github:bcn-services/bcns-internal:clock:main')
  assert.equal(parsed.title, 'Run failed: clock - main (45e294b)')
})

test('resolveRepo: map hit is case-insensitive against refs.project/monitorName/host', () => {
  const parsed = { repo: null, refs: { project: 'My-Project' } }
  const repo = resolveRepo(parsed, { map: { 'my-project': 'org/repo' } })
  assert.equal(repo, 'org/repo')
})

test('resolveRepo: clients hit by site host, and by project/monitorName equal to client name', () => {
  const byHost = resolveRepo(
    { repo: null, refs: { host: 'l2details.com' } },
    { clients: [{ name: 'l2detailz', github: 'https://github.com/bcn-services/bcns-client-l2detailz', site: 'https://l2details.com' }] },
  )
  assert.equal(byHost, 'bcn-services/bcns-client-l2detailz')

  const byName = resolveRepo(
    { repo: null, refs: { monitorName: 'l2detailz' } },
    { clients: [{ name: 'l2detailz', github: 'https://github.com/bcn-services/bcns-client-l2detailz' }] },
  )
  assert.equal(byName, 'bcn-services/bcns-client-l2detailz')
})

test('resolveRepo: no match anywhere returns null', () => {
  const repo = resolveRepo(
    { repo: null, refs: { project: 'nope' } },
    { map: { other: 'org/repo' }, clients: [{ name: 'someone-else', github: 'https://github.com/a/b' }] },
  )
  assert.equal(repo, null)
})

test('loadClientMap: reads github: and repo:-only frontmatter, and returns [] for a missing dir', async () => {
  const osDir = await mkdtemp(join(tmpdir(), 'alerts-os-'))
  try {
    await mkdir(join(osDir, 'clients', 'has-github'), { recursive: true })
    await writeFile(
      join(osDir, 'clients', 'has-github', 'README.md'),
      '---\nname: Has Github\nstatus: active\nrepo: ~/has-github\ngithub: https://github.com/org/has-github\nsummary: "x"\n---\n\nbody\n',
    )

    await mkdir(join(osDir, 'clients', 'repo-only'), { recursive: true })
    await writeFile(
      join(osDir, 'clients', 'repo-only', 'README.md'),
      '---\nname: Repo Only\nstatus: lead\nrepo: ~/repo-only\ngithub: null\nsummary: "y"\n---\n\nbody\n',
    )

    const clients = loadClientMap(osDir)
    assert.equal(clients.length, 2)

    const hasGithub = clients.find((c) => c.name === 'Has Github')
    assert.equal(hasGithub.github, 'https://github.com/org/has-github')
    assert.equal(hasGithub.repo, '~/has-github')

    const repoOnly = clients.find((c) => c.name === 'Repo Only')
    assert.equal(repoOnly.github, null)
    assert.equal(repoOnly.repo, '~/repo-only')

    assert.deepEqual(loadClientMap(join(osDir, 'does-not-exist')), [])
  } finally {
    await rm(osDir, { recursive: true, force: true })
  }
})

test('resolveRepo: a README github: given as bare org/repo resolves like a URL', () => {
  const clients = [{ name: 'coventry', github: 'nseluga/bcns-client-coventry' }]
  assert.equal(resolveRepo({ repo: null, refs: { project: 'Coventry' } }, { clients }), 'nseluga/bcns-client-coventry')
  assert.equal(resolveRepo({ repo: 'nseluga/bcns-client-coventry', refs: {} }, { clients }), 'nseluga/bcns-client-coventry')
})
