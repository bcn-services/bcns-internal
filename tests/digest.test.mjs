import { test } from 'node:test'
import assert from 'node:assert/strict'

import { run as digest, digestMail, etDate } from '../jobs/digest.mjs'
import { createNotifier } from '../jobs/poll.mjs'
import { digestCandidates } from '../lib/db.mjs'

// 21:00 UTC on Oct 20 is 17:00 in New York; 02:00 UTC Oct 21 is still Oct 20 there.
const NOW = new Date('2026-10-20T16:30:00Z')
// Literals, not the module's constants: a widened list or recipient has to fail here.
const BRANDON = 'bchung@bcn-services.com'
const ALLOWED = ['nseluga@bcn-services.com', BRANDON]

function biz(over = {}) {
  return {
    id: 'b1',
    name: 'Acme Roofing',
    domain: 'acmeroofing.example',
    email: 'dana@acmeroofing.example',
    phone: '203-555-0142',
    town: 'Danbury',
    state: 'CT',
    trade: 'roofing',
    stage: 'call_due',
    os_slug: 'acme-roofing-danbury',
    research: JSON.stringify({ fit: 'good', reason: 'paper job tracking', facts: ['no online booking'] }),
    ...over,
  }
}
const withScore = (id, name, fit_score) =>
  biz({ id, name, research: JSON.stringify(fit_score === undefined ? {} : { fit_score, reason: `r-${id}` }) })

// A db fake with the semantics of digestCandidates: rows already listed by a
// real `digested` event, or in `done`, never come back.
function harness({ rows = [], dryRun = false, notifyTo = [BRANDON], allowed = ALLOWED, send = null } = {}) {
  const events = []
  const sent = []
  const db = {
    digestCandidates: async (_s, date) => {
      const listed = new Set(events.filter((e) => e.kind === 'digested').flatMap((e) => e.detail.ids))
      return {
        rows: rows.filter((r) => !listed.has(r.id)),
        sentToday: events.some((e) => e.kind === 'digested' && e.detail.date === date),
      }
    },
    logEvent: async (_s, job, kind, detail) => {
      events.push({ job, kind, detail })
      return []
    },
    updateBusiness: () => {
      throw new Error('digest must never write a business row')
    },
  }
  const deps = { sql: {}, db, notify: send ?? (async (m) => sent.push(m)), internalRecipients: allowed, notifyTo, dryRun, now: NOW }
  return { deps, events, sent }
}
const kinds = (events) => events.map((e) => e.kind)

test('one text email to NOTIFY_TO only, subject counts calls by New York date', async () => {
  const h = harness({ rows: [biz({ id: 'a' }), biz({ id: 'b', name: 'Beta' })] })

  const out = await digest(h.deps)

  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].to, BRANDON)
  assert.equal(h.sent[0].subject, '[pipeline] 2 calls for 2026-10-20')
  assert.equal(out.listed, 2)
  assert.deepEqual(h.events.map((e) => [e.job, e.kind]), [['digest', 'digested']])
  assert.deepEqual(h.events[0].detail.ids, ['a', 'b'])
})

test('the subject date is the New York date, not UTC', () => {
  assert.equal(etDate(new Date('2026-10-21T02:00:00Z')), '2026-10-20')
  assert.equal(digestMail([], etDate(new Date('2026-10-21T02:00:00Z'))).subject, '[pipeline] 0 calls for 2026-10-20')
})

test('each row carries name, phone, where, trade, fit and reason, facts, website, email, pitch folder', () => {
  const { text } = digestMail([biz()], '2026-10-20')
  for (const want of [
    'Acme Roofing — 203-555-0142',
    'Where: Danbury, CT',
    'Trade: roofing',
    'Fit: good — paper job tracking',
    '- no online booking',
    'Website: acmeroofing.example',
    'Email: dana@acmeroofing.example',
    'Pitch folder: acme-roofing-danbury',
  ]) assert.ok(text.includes(want), `missing ${want}\n${text}`)
  assert.ok(!/undefined|null|\[object/.test(text))
})

test('a numeric fit_score shows and wins over the qualify label; a bare row prints no empty lines', () => {
  const scored = digestMail([biz({ research: JSON.stringify({ fit_score: 8, fit: 'good', reason: 'busy' }) })], 'd').text
  assert.match(scored, /Fit: 8 — busy/)
  const bare = digestMail([{ id: 'x', name: 'Bare Co', research: null }], 'd').text
  assert.equal(bare, '1. Bare Co')
})

test('sorted by fit_score desc, null last, name breaks ties', () => {
  const rows = [
    withScore('n', 'Zed', undefined),
    withScore('lo', 'Low', 3),
    withScore('hi', 'High', 9),
    withScore('t2', 'Tie B', 5),
    withScore('t1', 'Tie A', 5),
    withScore('z', 'Zero', 0),
  ]
  assert.deepEqual(digestMail(rows, 'd').ids, ['hi', 't1', 't2', 'lo', 'z', 'n'])
})

test('an empty list still sends one line', async () => {
  const h = harness({ rows: [] })

  await digest(h.deps)

  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].text, 'No new call tasks today')
  assert.equal(h.sent[0].subject, '[pipeline] 0 calls for 2026-10-20')
  assert.deepEqual(h.events[0].detail.ids, [])
})

test('a second run the same day lists none of the first run\'s ids and sends nothing', async () => {
  const h = harness({ rows: [biz({ id: 'a' })] })
  await digest(h.deps)

  const again = await digest(h.deps)

  assert.equal(h.sent.length, 1)
  assert.equal(again.sent, 0)
  assert.deepEqual(kinds(h.events), ['digested', 'skipped'])
  // Re-entry: a row promoted after the first digest is listed alone, in a second mail.
  h.deps.db.digestCandidates = ((orig) => async (s, d) => {
    const r = await orig(s, d)
    return { ...r, rows: [...r.rows, biz({ id: 'late', name: 'Late' })] }
  })(h.deps.db.digestCandidates)
  await digest(h.deps)
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.events.at(-1).detail.ids, ['late'])
})

test('a dry run writes would_digest, consumes no marker, and the real run still lists the rows', async () => {
  const h = harness({ rows: [biz({ id: 'a' })], dryRun: true })
  await digest(h.deps)
  await digest(h.deps)
  assert.deepEqual(kinds(h.events), ['would_digest', 'would_digest'])
  h.deps.dryRun = false
  await digest(h.deps)
  assert.equal(h.events.at(-1).kind, 'digested')
  assert.deepEqual(h.events.at(-1).detail.ids, ['a'])
})

test('NOTIFY_TO unset is an error event and no send, never a fallback to the internal list', async () => {
  const h = harness({ rows: [biz()], notifyTo: [] })

  await digest(h.deps)

  assert.deepEqual(h.sent, [])
  assert.deepEqual(kinds(h.events), ['error'])
})

test('a NOTIFY_TO address off the allow-list is refused before any read or transport', async () => {
  let transports = 0
  let reads = 0
  const h = harness({ rows: [biz()], notifyTo: ['stranger@outside.example'] })
  h.deps.notify = createNotifier({
    transport: async () => {
      transports++
      return { sendMail: async () => {} }
    },
    internalRecipients: ALLOWED,
    from: 'bot@bcn-services.com',
    dryRun: false,
    now: NOW,
  })
  const orig = h.deps.db.digestCandidates
  h.deps.db.digestCandidates = (...a) => (reads++, orig(...a))

  const out = await digest(h.deps)

  assert.equal(out.sent, 0)
  assert.equal(transports, 0)
  assert.equal(reads, 0)
  assert.deepEqual(kinds(h.events), ['error'])
  assert.match(h.events[0].detail.error, /not in NOTIFY_ALLOWED_RECIPIENTS/)
})

test('the real notifier refuses a prospect before building a transport, and no marker is written', async () => {
  let transports = 0
  const h = harness({ rows: [biz()], notifyTo: ['dana@acmeroofing.example'], allowed: ['dana@acmeroofing.example'] })
  h.deps.notify = createNotifier({
    transport: async () => {
      transports++
      return { sendMail: async () => {} }
    },
    internalRecipients: ALLOWED, // the real list; the job was handed a widened one
    from: 'bot@bcn-services.com',
    dryRun: false,
    now: NOW,
  })

  await digest(h.deps)

  assert.equal(transports, 0)
  assert.ok(!kinds(h.events).includes('digested'))
})

test('a send failure writes an error and no digested marker, so the rows are listed next run', async () => {
  const h = harness({ rows: [biz({ id: 'a' })], send: async () => { throw new Error('smtp down') } })

  await digest(h.deps)

  assert.deepEqual(kinds(h.events), ['error'])
  assert.match(h.events[0].detail.error, /smtp down/)
})

test('live run with no SMTP credentials is not a delivery: would_digest, no marker, rows listed again', async () => {
  const h = harness({ rows: [biz({ id: 'a' })] })
  h.deps.notify = null // the real createNotifier...
  h.deps.transport = null // ...with no credentials: it answers { dryRun: true } and sends nothing

  const first = await digest(h.deps)
  const second = await digest(h.deps)

  assert.deepEqual(kinds(h.events), ['would_digest', 'would_digest'])
  assert.ok(!kinds(h.events).includes('digested'))
  assert.equal(first.sent, 0)
  assert.deepEqual(h.events[1].detail.ids, ['a']) // the next run lists the same row again
  assert.equal(second.listed, 1)

  // Credentials arrive: the row is still there and now really goes out.
  const mails = []
  h.deps.transport = async () => ({ sendMail: async (m) => mails.push(m) })
  await digest(h.deps)
  assert.equal(mails.length, 1)
  assert.equal(h.events.at(-1).kind, 'digested')
  assert.deepEqual(h.events.at(-1).detail.ids, ['a'])
})

test('marker only when every NOTIFY_TO address was delivered; one failure leaves the rows to the next run', async () => {
  const NATE = 'nseluga@bcn-services.com'
  const sent = []
  let nateDown = true
  const send = async (m) => {
    if (m.to === NATE && nateDown) throw new Error('mailbox full')
    sent.push(m.to)
  }
  const h = harness({ rows: [biz({ id: 'a' })], notifyTo: [BRANDON, NATE], send })

  const first = await digest(h.deps)

  assert.deepEqual(sent, [BRANDON]) // Brandon got it, Nate's send failed
  assert.deepEqual(kinds(h.events), ['error'])
  assert.equal(h.events[0].detail.to, NATE)
  assert.match(h.events[0].detail.error, /mailbox full/)
  assert.equal(first.listed, 0)

  nateDown = false
  await digest(h.deps) // re-lists the row to both
  assert.deepEqual(sent, [BRANDON, BRANDON, NATE])
  assert.deepEqual(kinds(h.events), ['error', 'digested'])
  assert.deepEqual(h.events[1].detail.ids, ['a'])
})

test('digestCandidates reads the view, dedupes on digested ids and old call mail, and filters on next_touch_at', async () => {
  const calls = []
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join(' ? '), values })
    return Promise.resolve(calls.length === 1 ? [{ id: 'a' }] : [])
  }
  const out = await digestCandidates(sql, '2026-10-20')
  const { text } = calls[0]
  assert.match(text, /from\s+selectable_businesses/i)
  assert.ok(!/\bfrom\s+businesses\b/i.test(text))
  assert.match(text, /s\.stage = 'call_due'/)
  assert.match(text, /s\.next_touch_at is null or s\.next_touch_at <= now\(\)/)
  assert.match(text, /e\.job = 'digest' and e\.kind = 'digested'/)
  assert.match(text, /detail->'ids' @> to_jsonb\(s\.id::text\)/)
  assert.match(text, /e\.job = 'notify' and e\.kind = 'notified'/)
  assert.match(text, /like s\.id::text \|\| ':call_due:%'/)
  assert.deepEqual(out, { rows: [{ id: 'a' }], sentToday: false })
  assert.deepEqual(calls[1].values, ['2026-10-20'])
  assert.match(calls[1].text, /America\/New_York/)
})
