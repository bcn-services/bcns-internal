import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

import { jobName, SCHEDULES } from '../jobs/run.mjs'
import { run as heartbeat } from '../jobs/heartbeat.mjs'

const clock = parse(readFileSync(new URL('../.github/workflows/clock.yml', import.meta.url), 'utf8'))
// `on:` is YAML 1.1's boolean true, which is why it parses to a `true` key.
const triggers = clock.on ?? clock[true]

test('clock.yml declares exactly the three crons', () => {
  const crons = triggers.schedule.map((s) => s.cron)
  assert.deepEqual(crons, ['*/20 8-20 * * 1-5', '0 14 * * 1-5', '0 13 * * 1'])
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

test('every job runs under a ten-minute timeout', () => {
  for (const job of Object.values(clock.jobs)) {
    assert.equal(job['timeout-minutes'], 10)
  }
})

test('clock.yml references no secret that does not yet exist', () => {
  const src = readFileSync(new URL('../.github/workflows/clock.yml', import.meta.url), 'utf8')
  const named = [...src.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])
  const existing = ['DATABASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_PACKAGES_TOKEN', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_USER']
  for (const s of named) assert.ok(existing.includes(s), `secret ${s} is not set on the repo`)
})

test('the dispatcher maps each cron to its job', () => {
  assert.equal(jobName({ schedule: '*/20 8-20 * * 1-5' }), 'poll')
  assert.equal(jobName({ schedule: '0 14 * * 1-5' }), 'touch')
  assert.equal(jobName({ schedule: '0 13 * * 1' }), 'source')
  assert.equal(Object.keys(SCHEDULES).length, 3)
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
