import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

import { jobName, jobNames, SCHEDULES, buildDeps, createFetchPage } from '../jobs/run.mjs'
import { run as heartbeat } from '../jobs/heartbeat.mjs'

const clock = parse(readFileSync(new URL('../.github/workflows/clock.yml', import.meta.url), 'utf8'))
// `on:` is YAML 1.1's boolean true, which is why it parses to a `true` key.
const triggers = clock.on ?? clock[true]

// The drift test. clock.yml is the only thing that fires this repo and
// SCHEDULES is the only thing that maps a cron to a job: a cell in one and not
// the other is either a tick that throws or a job that never runs. `personalize`
// having no cron for weeks is exactly that bug, so this is table-driven both
// ways rather than a pinned list.
test('every cron in clock.yml has a job, and every job in SCHEDULES has a cron', () => {
  const crons = triggers.schedule.map((s) => s.cron)
  for (const cron of crons) {
    assert.ok(cron in SCHEDULES, `clock.yml fires ${cron} and SCHEDULES has no entry for it`)
  }
  for (const cron of Object.keys(SCHEDULES)) {
    assert.ok(crons.includes(cron), `SCHEDULES maps ${cron} and no cron in clock.yml fires it`)
  }
  assert.equal(crons.length, new Set(crons).size, 'a cron is declared twice')
})

test('clock.yml has a workflow_dispatch trigger and a concurrency block', () => {
  assert.ok('workflow_dispatch' in triggers)
  assert.ok(triggers.workflow_dispatch.inputs.job)
  assert.ok(clock.concurrency?.group)
  assert.equal(clock.concurrency['cancel-in-progress'], false)
})

test('no cron is more frequent than every twenty minutes', () => {
  for (const { cron } of triggers.schedule) {
    const minute = cron.split(' ')[0]
    if (!minute.startsWith('*/')) continue
    assert.ok(Number(minute.slice(2)) >= 20, `${cron} fires too often`)
  }
})

test('every job runs under a thirty-minute timeout', () => {
  for (const job of Object.values(clock.jobs)) {
    assert.equal(job['timeout-minutes'], 30)
  }
})

test('clock.yml references no secret that does not yet exist', () => {
  const src = readFileSync(new URL('../.github/workflows/clock.yml', import.meta.url), 'utf8')
  const named = [...src.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])
  const existing = ['DATABASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_PACKAGES_TOKEN', 'IMAP_PASS', 'MAIL_FROM', 'OS_TOKEN', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_USER', 'SMTP_AUTH_USER', 'SMTP_MAILBOX_OUTREACH_TRYBCNS_COM_USER', 'SMTP_MAILBOX_OUTREACH_TRYBCNS_COM_PASS']
  for (const s of named) assert.ok(existing.includes(s), `secret ${s} is not set on the repo`)
})

test('the dispatcher maps each cron to its job', () => {
  assert.equal(jobName({ schedule: '*/20 8-20 * * 1-5' }), 'poll')
  assert.equal(jobName({ schedule: '0 14 * * 1-5' }), 'touch')
  assert.equal(jobName({ schedule: '0 13 * * 1' }), 'source')
  assert.equal(jobName({ schedule: '30 13 * * 1-5' }), 'personalize')
  assert.equal(Object.keys(SCHEDULES).length, 4)
  // The 20-minute tick is a chain: poll reads the inbox, pitch/quote/onboard
  // work what it wrote, and notify reports on what they left behind — in that
  // order. quote and onboard need not exist yet; main() skips a missing module.
  assert.deepEqual(jobNames({ schedule: '*/20 8-20 * * 1-5' }), [
    'poll',
    'pitch',
    'quote',
    'onboard',
    'notify',
  ])
})

test('a dispatch input overrides the schedule, and an unknown name throws', () => {
  assert.equal(jobName({ schedule: '0 13 * * 1', job: 'heartbeat' }), 'heartbeat')
  assert.throws(() => jobName({ schedule: 'not-a-cron' }), /no job for schedule/)
  assert.throws(() => jobName({}), /no job for schedule/)
})

test('the dispatcher never swallows a job error', async () => {
  const { main } = await import('../jobs/run.mjs')
  await assert.rejects(
    main({ JOB: 'boom' }, async () => ({ run: async () => { throw new Error('job blew up') } })),
    /job blew up/
  )
})

test('heartbeat writes a dated file, and twice in one day leaves one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'))
  try {
    const now = new Date('2026-08-30T09:00:00Z')
    const first = await heartbeat({ now, dir })
    assert.equal(readdirSync(dir).length, 1)
    assert.match(readFileSync(first.file, 'utf8'), /2026-08-30/)
    assert.equal(first.already, false)

    const second = await heartbeat({ now: new Date('2026-08-30T23:00:00Z'), dir })
    assert.equal(readdirSync(dir).length, 1)
    assert.equal(second.already, true)
    assert.equal(second.file, first.file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('heartbeat logs an event when a client is supplied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'))
  try {
    const logged = []
    await heartbeat({
      sql: {}, logEvent: (_sql, job, kind, detail) => logged.push([job, kind, detail]),
      now: new Date('2026-08-30T09:00:00Z'), dir,
    })
    assert.equal(logged.length, 1)
    assert.equal(logged[0][0], 'heartbeat')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('authcheck fails loudly when the identity exchange did not run', async () => {
  const { run } = await import('../jobs/authcheck.mjs')
  await assert.rejects(run({ env: {} }), /workload identity/)
  assert.equal((await run({ env: { CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.x' } })).ok, true)
})

test('authcheck reports the os clone without depending on it', async () => {
  const { run } = await import('../jobs/authcheck.mjs')
  const env = { CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.x', OS_DIR: '/w/os' }
  const seen = []
  const present = await run({ env, exists: (p) => (seen.push(p), true) })
  assert.deepEqual(present.os, { dir: '/w/os', cloned: true, voiceRules: true })
  assert.ok(seen.some((p) => p.endsWith('knowledge/library/bcns-voice/voice-rules.md')))

  // A run with no clone still succeeds — the clone is optional by design.
  const absent = await run({ env, exists: () => false })
  assert.deepEqual(absent.os, { dir: '/w/os', cloned: false, voiceRules: false })
  assert.equal(absent.ok, true)
})

test('a job that is not built yet is skipped, not a failure', async () => {
  const { main } = await import('../jobs/run.mjs')
  const notFound = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' })
  const out = await main({ JOB: 'poll' }, async () => { throw notFound })
  assert.deepEqual(out, { skipped: 'not-built', job: 'poll' })
})

test('a job that exists and throws still fails the run', async () => {
  const { main } = await import('../jobs/run.mjs')
  await assert.rejects(
    main({ JOB: 'source' }, async () => ({ run: async () => { throw new Error('real failure') } })),
    /real failure/
  )
})

test('an unrelated import error is never mistaken for an unbuilt job', async () => {
  const { main } = await import('../jobs/run.mjs')
  await assert.rejects(
    main({ JOB: 'source' }, async () => { throw new SyntaxError('bad module') }),
    /bad module/
  )
})

test('the Monday cron runs source then qualify, in that order', () => {
  assert.deepEqual(jobNames({ schedule: '0 13 * * 1' }), ['source', 'qualify'])
  // 13:30 is between qualify (13:00 Monday) and touch (14:00), so a row
  // qualified this morning is drafted before touch goes looking for it.
  assert.deepEqual(jobNames({ schedule: '30 13 * * 1-5' }), ['personalize'])
  assert.deepEqual(jobNames({ schedule: '0 14 * * 1-5' }), ['touch'])
  assert.deepEqual(jobNames({ schedule: '0 13 * * 1', job: 'heartbeat' }), ['heartbeat'])
  assert.throws(() => jobNames({ schedule: 'not-a-cron' }), /no job for schedule/)
})

test('main runs every job of a tick in order, on one deps object', async () => {
  const { main } = await import('../jobs/run.mjs')
  const ran = []
  const out = await main({ SCHEDULE: '0 13 * * 1' }, async (name) => ({
    run: async (deps) => { ran.push([name, deps]); return name },
  }))
  assert.deepEqual(ran.map((r) => r[0]), ['source', 'qualify'])
  assert.equal(ran[0][1], ran[1][1], 'the two jobs got different deps objects')
  assert.deepEqual(out, ['source', 'qualify'])
})

test('buildDeps hands qualify fetchPage always and claude only on the OAuth token', async () => {
  const bare = await buildDeps({})
  assert.equal(typeof bare.fetchPage, 'function')
  assert.equal('claude' in bare, false)
  assert.equal('verify' in bare, false)

  const full = await buildDeps({ CLAUDE_CODE_OAUTH_TOKEN: 'oat_x', MAIL_FROM: 'a@b.test' })
  assert.equal(typeof full.claude.ask, 'function')
  assert.equal(typeof full.verify, 'function')
})

test('the send list and the internal list are two independent variables', async () => {
  const both = await buildDeps({
    SEND_ALLOWED_RECIPIENTS: ' dana@acmeroofing.example , owner@boltroofing.example ,,',
    NOTIFY_ALLOWED_RECIPIENTS: 'nseluga@bcn-services.com',
  })
  assert.deepEqual(both.allowedRecipients, ['dana@acmeroofing.example', 'owner@boltroofing.example'])
  assert.deepEqual(both.internalRecipients, ['nseluga@bcn-services.com'])

  // Each unset independently: that path reaches nobody, the other still works.
  const noSend = await buildDeps({ NOTIFY_ALLOWED_RECIPIENTS: 'nseluga@bcn-services.com' })
  assert.deepEqual(noSend.allowedRecipients, [])
  assert.deepEqual(noSend.internalRecipients, ['nseluga@bcn-services.com'])

  const noInternal = await buildDeps({ SEND_ALLOWED_RECIPIENTS: 'dana@acmeroofing.example' })
  assert.deepEqual(noInternal.allowedRecipients, ['dana@acmeroofing.example'])
  assert.deepEqual(noInternal.internalRecipients, [])

  // Unset is nobody, never everybody.
  const bare = await buildDeps({})
  assert.deepEqual(bare.allowedRecipients, [])
  assert.deepEqual(bare.internalRecipients, [])
})

// Superseded by item 22's per-mailbox transport (jobs/run.mjs
// createMailboxTransport): the old design hardcoded a personal address
// ('nseluga@bcn-services.com') as the SMTP_AUTH_USER default so the outreach
// alias could authenticate. That guardrail explicitly forbids a hardcoded
// address default, so a no-mailbox transport() call now falls back to an
// EXPLICIT SMTP_USER/SMTP_PASS pair, and has no credentials at all without one.
test('SMTP transport with no mailbox uses an explicit account, no hardcoded default', async () => {
  const deps = await buildDeps({ SMTP_USER: 'nseluga@bcn-services.com', SMTP_PASS: 'x'.repeat(16) })
  const mailer = await deps.transport()
  assert.equal(mailer.options.auth.user, 'nseluga@bcn-services.com')
  assert.equal(deps.outreachAddress, 'nseluga@bcn-services.com')

  // An alias as SMTP_USER logs in as the seat SMTP_AUTH_USER names, and the
  // outreach address stays the alias.
  const alias = await buildDeps({
    SMTP_USER: 'outreach@send.bcn-services.com',
    SMTP_AUTH_USER: 'seat@bcn-services.com',
    SMTP_PASS: 'x'.repeat(16),
  })
  assert.equal((await alias.transport()).options.auth.user, 'seat@bcn-services.com')
  assert.equal(alias.outreachAddress, 'outreach@send.bcn-services.com')

  // No SMTP_USER: nothing to fall back to, so the internal-mail transport has
  // no credentials — never a hardcoded personal address.
  const noUser = await buildDeps({ SMTP_PASS: 'x'.repeat(16) })
  await assert.rejects(() => noUser.transport(), /no SMTP credentials configured/)
})

test('no API key ever reaches the Claude client', () => {
  const src = readFileSync(new URL('../lib/claude.mjs', import.meta.url), 'utf8')
  assert.ok(!/ANTHROPIC_API_KEY|api[_-]?key/i.test(src.replace(/^\s*\/\/.*$/gm, '')))
})

test('fetchPage caps the body it returns and fails loudly on a bad status', async () => {
  const huge = 'x'.repeat(200)
  const capped = createFetchPage({ maxBytes: 50, fetchImpl: async () => ({ ok: true, text: async () => huge }) })
  assert.equal((await capped('https://x.test')).length, 50)

  const bad = createFetchPage({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) })
  await assert.rejects(bad('https://x.test'), /returned 404/)
})


test('buildDeps injects a voice rules reader only when OS_DIR is set', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  // No clone, no reader: personalize already logs that and drafts without the
  // voice, so a missing OS_DIR must stay a degraded run and never a thrown one.
  const bare = await buildDeps({})
  assert.equal(bare.readVoiceRules, undefined)

  const os = mkdtempSync(join(tmpdir(), 'bcns-os-'))
  mkdirSync(join(os, 'knowledge/library/bcns-voice'), { recursive: true })
  writeFileSync(join(os, 'knowledge/library/bcns-voice/voice-rules.md'), 'no em dashes\n')

  const cloned = await buildDeps({ OS_DIR: os })
  assert.equal(typeof cloned.readVoiceRules, 'function')
  assert.equal(await cloned.readVoiceRules(), 'no em dashes\n')
})
