import { test } from 'node:test'
import assert from 'node:assert/strict'

import { run as poll, TRIAGE_DAILY_CAP, alertFingerprint } from '../jobs/poll.mjs'

const NOW = new Date('2026-09-03T09:00:00Z')
const ALERTS = 'alerts@bcn-services.com'
const FALLBACK = 'bcn-services/bcns-internal'

function alertMsg(over = {}) {
  return {
    uid: over.uid ?? 1,
    messageId: `<alert-${over.uid ?? 1}@monitor.example>`,
    from: 'monitor@ops.example',
    deliveredTo: ALERTS,
    subject: 'disk usage above 90% on db-1',
    text: 'disk usage above 90% on db-1\n\nAlerting since 09:00 UTC',
    headers: {},
    ...over,
  }
}

// `alerts` is an in-memory stand-in for the real `alerts` table's upsert
// semantics (0018_pipeline.sql): keyed on fingerprint, `hits` increments on
// conflict, `pr_url` is written separately, once.
function harness({ messages, priorOpens = 0, fixer } = {}) {
  const events = Array.from({ length: priorOpens }, () => ({
    job: 'triage',
    kind: 'opened',
    detail: {},
  }))
  const alerts = new Map()
  const prCalls = []

  const deps = {
    sql: {},
    db: {
      logEvent: (_s, job, kind, detail) => {
        events.push({ job, kind, detail })
        return Promise.resolve([])
      },
      mailboxAddresses: async () => [],
      // Same rows the real query counts: job='triage', kind='opened', today.
      triageOpenedToday: () =>
        Promise.resolve([
          { count: events.filter((e) => e.job === 'triage' && e.kind === 'opened').length },
        ]),
      upsertAlert: (_s, { fingerprint, repo = null, source = null }) => {
        const existing = alerts.get(fingerprint)
        const row = existing
          ? { ...existing, hits: existing.hits + 1 }
          : { fingerprint, repo, source, hits: 1, pr_url: null }
        alerts.set(fingerprint, row)
        return Promise.resolve([row])
      },
      setAlertPr: (_s, fingerprint, prUrl) => {
        const row = alerts.get(fingerprint)
        if (row) row.pr_url = prUrl
        return Promise.resolve(row ? [row] : [])
      },
      threadByMessageIds: () => Promise.resolve([]),
      messageFailureCount: () => Promise.resolve([{ count: 0 }]),
    },
    imap: async () => ({
      messages: async () => messages,
      markSeen: async () => {},
      close: async () => {},
    }),
    github: async ({ title, body, branch, repo }) => {
      prCalls.push({ title, body, branch, repo })
      return { url: `https://github.example/pull/${prCalls.length}` }
    },
    fixer: fixer === undefined ? null : fixer,
    alertRepos: { fallback: FALLBACK, map: { 'ops-example': 'acme/ops' }, clients: [] },
    internalRecipients: [],
    dryRun: false,
    now: NOW,
  }

  return { deps, events, alerts, prCalls }
}

const kinds = (events, job = 'triage') => events.filter((e) => e.job === job).map((e) => e.kind)

test('a fourth alert on a cap-full day writes a skipped event and opens nothing', async () => {
  const { deps, events, alerts, prCalls } = harness({
    messages: [alertMsg({ uid: 4, subject: 'fourth alert of the day' })],
    priorOpens: TRIAGE_DAILY_CAP,
  })

  const result = await poll(deps)

  assert.deepEqual(kinds(events), Array(TRIAGE_DAILY_CAP).fill('opened').concat('skipped'))
  assert.match(events.at(-1).detail.reason, /daily cap/i)
  assert.equal(alerts.size, 0, 'the cap-full alert never touched the alerts table')
  assert.equal(prCalls.length, 0, 'the cap-full alert opened no PR')
  assert.equal(result.triaged, 0)
})

test('the same fingerprint twice increments hits and opens one PR, not two', async () => {
  const first = alertMsg({ uid: 1 })
  const second = alertMsg({ uid: 2 }) // identical subject + first body line
  assert.equal(alertFingerprint(first), alertFingerprint(second), 'fixture is not actually a dupe')

  const { deps, events, alerts, prCalls } = harness({ messages: [first, second] })

  const result = await poll(deps)

  assert.deepEqual(kinds(events), ['opened', 'duplicate'])
  assert.equal(alerts.size, 1)
  assert.equal([...alerts.values()][0].hits, 2)
  assert.equal(prCalls.length, 1, 'only the first sighting opens a PR')
  assert.ok([...alerts.values()][0].pr_url, 'the PR url is recorded on the alert row')
  assert.equal(result.triaged, 2)
})

test('an alert nothing recognises still opens a PR — on the fallback repo, raw body', async () => {
  const { deps, events, alerts, prCalls } = harness({ messages: [alertMsg({ uid: 1 })] })
  await poll(deps)
  assert.deepEqual(kinds(events), ['opened'])
  assert.equal(prCalls[0].repo, FALLBACK)
  assert.equal([...alerts.values()][0].repo, FALLBACK)
  assert.equal([...alerts.values()][0].source, 'unknown')
  assert.match(prCalls[0].body, /disk usage above 90%/)
})

test('no fallback repo and no mapping means an error event, never a PR on a guessed repo', async () => {
  const { deps, events, prCalls } = harness({ messages: [alertMsg({ uid: 1 })] })
  deps.alertRepos = {}
  await poll(deps)
  assert.deepEqual(kinds(events), ['error'])
  assert.match(events[0].detail.reason, /repo/)
  assert.equal(prCalls.length, 0)
})

const GH_FAIL = {
  from: 'notifications@github.com',
  subject: '[bcn-services/bcns-internal] Run failed: clock - main (45e294b)',
  text: 'clock: run failed\nhttps://github.com/bcn-services/bcns-internal/actions/runs/34190000000',
}

test('a GitHub run-failed mail runs the fixer on the repo named in the subject and reports the outcome', async () => {
  const fixCalls = []
  const { deps, events, prCalls } = harness({
    messages: [alertMsg({ uid: 1, ...GH_FAIL })],
    fixer: async (args) => {
      fixCalls.push(args)
      return { triageOnly: false, report: 'root cause: heartbeat missing from SCHEDULES' }
    },
  })
  await poll(deps)
  assert.equal(fixCalls.length, 1)
  assert.equal(fixCalls[0].repo, 'bcn-services/bcns-internal')
  assert.match(fixCalls[0].branch, /^alert\/[0-9a-f]{12}$/)
  assert.equal(fixCalls[0].alert.refs.runId, '34190000000')
  assert.equal(prCalls[0].repo, 'bcn-services/bcns-internal')
  assert.equal(prCalls[0].branch, fixCalls[0].branch)
  assert.match(prCalls[0].title, /^alert: Run failed: clock/)
  assert.match(prCalls[0].body, /heartbeat missing from SCHEDULES/)
  assert.equal(events.at(-1).kind, 'opened')
  assert.equal(events.at(-1).detail.triage_only, false)
})

test('a fixer with no confident fix opens a triage-only PR, and a fixer crash opens nothing', async () => {
  const a = harness({
    messages: [alertMsg({ uid: 1, ...GH_FAIL })],
    fixer: async () => ({ triageOnly: true, report: 'could not reproduce' }),
  })
  await poll(a.deps)
  assert.match(a.prCalls[0].title, /^triage:/)
  assert.match(a.prCalls[0].body, /TRIAGE\.md/)

  const b = harness({
    messages: [alertMsg({ uid: 1, ...GH_FAIL })],
    fixer: async () => {
      throw new Error('clone failed')
    },
  })
  await poll(b.deps)
  assert.deepEqual(kinds(b.events), ['error'])
  assert.match(b.events[0].detail.reason, /clone failed/)
  assert.equal(b.prCalls.length, 0)
})

test('the same incident under two subjects is one fingerprint, and a monitor UP mail opens nothing', async () => {
  const down = alertMsg({ uid: 1, from: 'alert@uptimerobot.com', subject: 'Monitor is DOWN: L2 (https://l2details.com/)', text: 'down' })
  const downAgain = alertMsg({ uid: 2, from: 'alert@uptimerobot.com', subject: 'Monitor is DOWN: L2 (https://l2details.com/health)', text: 'still down, 5 min' })
  const up = alertMsg({ uid: 3, from: 'alert@uptimerobot.com', subject: 'Monitor is UP: L2 (https://l2details.com/)', text: 'up' })
  assert.notEqual(alertFingerprint(down), alertFingerprint(downAgain), 'fixture: subjects differ')
  const { deps, events, alerts, prCalls } = harness({ messages: [down, downAgain, up] })
  deps.alertRepos.map = { 'l2details.com': 'acme/l2' }
  await poll(deps)
  assert.deepEqual(kinds(events), ['opened', 'duplicate', 'resolved'])
  assert.equal(alerts.size, 1)
  assert.equal(prCalls.length, 1)
  assert.equal(prCalls[0].repo, 'acme/l2')
})

test('mail typed To: alerts@ with no Delivered-To (forwarded from the same seat) still reaches triage', async () => {
  const { deps, events, prCalls } = harness({
    messages: [alertMsg({ deliveredTo: null, toAddresses: [ALERTS] })],
  })
  await poll(deps)
  assert.deepEqual(kinds(events), ['opened'])
  assert.equal(prCalls.length, 1)
})
