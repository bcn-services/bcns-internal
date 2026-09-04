import { test } from 'node:test'
import assert from 'node:assert/strict'

import { run as poll, TRIAGE_DAILY_CAP, alertFingerprint } from '../jobs/poll.mjs'

const NOW = new Date('2026-09-03T09:00:00Z')
const ALERTS = 'alerts@bcn-services.com'

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
function harness({ messages, priorOpens = 0 } = {}) {
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
    github: async ({ title, body, branch }) => {
      prCalls.push({ title, body, branch })
      return { url: `https://github.example/pull/${prCalls.length}` }
    },
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
