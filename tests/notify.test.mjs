import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  run as notify,
  callTaskEmail,
  meetingEmail,
  quoteEmail,
  notifyKey,
  NOTIFY_STAGES,
} from '../jobs/notify.mjs'
import { createNotifier } from '../jobs/poll.mjs'
import { RecipientRefused } from '../jobs/touch.mjs'
import { assertSelectable, businessesByStage, notifiedKeys } from '../lib/db.mjs'

const NOW = new Date('2026-09-02T09:00:00Z')
// Literals, not the module's own constant: a widened allow-list has to fail here.
const ALLOWED = ['nseluga@bcn-services.com', 'bchung@bcn-services.com']
const PROSPECT = 'dana@acmeroofing.example'

// Real column names from 0018_pipeline.sql. There is no owner_name column —
// the owner lives in research, written as a JSON string by qualify/personalize.
function biz(over = {}) {
  return {
    id: 'b1',
    name: 'Acme Roofing',
    domain: 'acmeroofing.example',
    email: PROSPECT,
    phone: '203-555-0142',
    address: '12 Main St, Danbury, CT',
    town: 'Danbury',
    state: 'CT',
    trade: 'roofing',
    place_id: 'p1',
    stage: 'call_due',
    touches: 3,
    next_touch_at: new Date('2026-09-04T14:00:00Z'),
    suppressed_at: null,
    research: JSON.stringify({
      facts: ['no online booking', 'reviews mention callbacks'],
      fit: 'paper job tracking',
      owner_name: 'Dana',
      notes: ['wants a portal for his crews'],
      draft: 'Subject: a question about Acme Roofing\n\nHi Dana,\n',
    }),
    ...over,
  }
}

function harness({ rows = [], allowed = ALLOWED, dryRun = false, send = null, hasPitch = true } = {}) {
  const events = []
  const sent = []
  const store = rows.map((r) => ({ ...r }))

  const deps = {
    sql: {},
    db: {
      businessesByStage: (_s, stage) => Promise.resolve(store.filter((r) => r.stage === stage)),
      notifiedKeys: (_s, keys) =>
        Promise.resolve(
          events
            .filter((e) => e.kind === 'notified' && keys.includes(e.detail.key))
            .map((e) => ({ key: e.detail.key }))
        ),
      firstOutbound: (_s, id) =>
        Promise.resolve([{ message_id: `<msg-${id}@send.bcn-services.com>`, subject: 'a question about Acme Roofing' }]),
      logEvent: (_s, job, kind, detail) => {
        events.push({ job, kind, detail })
        return Promise.resolve([])
      },
      // Notify reads stages; it never writes one. A stage write must explode.
      updateBusiness: () => {
        throw new Error('notify must never write a business row')
      },
      suppress: () => {
        throw new Error('notify must never suppress')
      },
    },
    notify: send ?? (async (m) => sent.push(m)),
    internalRecipients: allowed,
    dryRun,
    now: NOW,
    hasPitch,
  }
  return { deps, events, sent, store }
}

const kinds = (events) => events.map((e) => e.kind)

// --- the literals this suite pins ------------------------------------------

test('the constants this suite asserts against are what they claim to be', () => {
  assert.deepEqual(NOTIFY_STAGES, ['call_due', 'replied', 'quoting'])
  assert.equal(NOTIFY_STAGES.length, 3)
  // There is no approval step: a drafted row is not a task for a human.
  assert.ok(!NOTIFY_STAGES.includes('drafted'))
})

// --- notified once per stage ------------------------------------------------

test('a call_due row produces exactly one call-task email across two runs', async () => {
  const h = harness({ rows: [biz()] })

  const first = await notify(h.deps)
  const second = await notify(h.deps)

  assert.equal(first.call_due, 1)
  assert.equal(second.call_due, 0)
  // One email per allow-listed recipient, once — not once per run.
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.sent.map((m) => m.to).sort(), [...ALLOWED].sort())
  assert.equal(h.sent.filter((m) => /call Acme Roofing/.test(m.subject)).length, 2)
  assert.equal(kinds(h.events).filter((k) => k === 'notified').length, 1)
})

test('a re-scheduled call is a new notification, so the marker cannot wedge', async () => {
  const h = harness({ rows: [biz()] })
  await notify(h.deps)
  // What poll's `no answer` command writes: same stage, later next_touch_at.
  h.store[0].next_touch_at = new Date('2026-09-06T14:00:00Z')

  const again = await notify(h.deps)

  assert.equal(again.call_due, 1)
  assert.equal(h.sent.length, 4)
  assert.notEqual(notifyKey(h.store[0]), `b1:call_due:${new Date('2026-09-04T14:00:00Z').toISOString()}`)
})

test('a dry run marks would_notify, which never consumes the real notification', async () => {
  const h = harness({ rows: [biz()], dryRun: true })

  await notify(h.deps)
  await notify(h.deps)

  assert.equal(kinds(h.events).filter((k) => k === 'notified').length, 0)
  assert.equal(kinds(h.events).filter((k) => k === 'would_notify').length, 2)
})

// --- the allow-list gate ----------------------------------------------------

test('an address outside the allow-list is refused before SMTP is opened', async () => {
  let transports = 0
  const send = createNotifier({
    transport: async () => {
      transports++
      return { sendMail: async () => {} }
    },
    internalRecipients: ALLOWED,
    from: 'bot@bcn-services.com',
    dryRun: false,
    now: NOW,
  })

  await assert.rejects(
    () => send({ to: PROSPECT, subject: 'x', text: 'y' }),
    (err) => err instanceof RecipientRefused
  )
  assert.equal(transports, 0)
})

test('a widened recipient list still cannot reach a prospect', async () => {
  let transports = 0
  // The gate carries the real list; the job is handed a widened one.
  const send = createNotifier({
    transport: async () => {
      transports++
      return { sendMail: async () => {} }
    },
    internalRecipients: ALLOWED,
    from: 'bot@bcn-services.com',
    dryRun: false,
    now: NOW,
  })
  const h = harness({ rows: [biz()], allowed: [PROSPECT], send })

  const result = await notify(h.deps)

  assert.equal(transports, 0)
  assert.equal(result.call_due, 0)
  assert.equal(result.errors, 1)
  assert.equal(kinds(h.events).filter((k) => k === 'notified').length, 0)
  assert.match(h.events.find((e) => e.kind === 'error').detail.error, /not in NOTIFY_ALLOWED_RECIPIENTS/)
})

// Two lists. A prospect on the send list is not an internal recipient, and an
// empty internal list is nobody whatever the send list holds. Literals only.
test('internal mail goes to the internal list, never to a prospect on the send list', async () => {
  const h = harness({ rows: [biz()], allowed: ['nseluga@bcn-services.com'] })
  h.deps.allowedRecipients = ['dana@acmeroofing.example']

  const result = await notify(h.deps)

  assert.deepEqual(h.sent.map((m) => m.to), ['nseluga@bcn-services.com'])
  assert.equal(result.errors, 0)
})

test('an empty internal list mails nobody however full the send list is', async () => {
  const h = harness({ rows: [biz()], allowed: [] })
  h.deps.allowedRecipients = ['dana@acmeroofing.example', 'nseluga@bcn-services.com']

  const result = await notify(h.deps)

  assert.deepEqual(h.sent, [])
  assert.equal(result.emails, 0)
  assert.deepEqual(kinds(h.events), ['skipped'])
})

test('an empty allow-list is nobody, not everybody', async () => {
  const h = harness({ rows: [biz()], allowed: [] })

  const result = await notify(h.deps)

  assert.deepEqual(h.sent, [])
  assert.equal(result.emails, 0)
  assert.deepEqual(kinds(h.events), ['skipped'])
})

// --- the three templates ----------------------------------------------------

test('the three templates render row fields and no prospect address is ever a recipient', async () => {
  const h = harness({
    rows: [
      biz({ id: 'c1', stage: 'call_due' }),
      biz({ id: 'r1', stage: 'replied' }),
      biz({ id: 'q1', stage: 'quoting' }),
    ],
  })

  const result = await notify(h.deps)

  assert.deepEqual(
    { call_due: result.call_due, replied: result.replied, quoting: result.quoting },
    { call_due: 1, replied: 1, quoting: 1 }
  )
  assert.equal(result.drafted, undefined, 'the result still carries a drafted tally')
  // Three bodies, each to both humans.
  assert.equal(h.sent.length, 6)
  for (const m of h.sent) {
    assert.ok(ALLOWED.includes(m.to), `${m.to} is not an allow-listed recipient`)
    assert.notEqual(m.to, PROSPECT)
    assert.ok(!/acmeroofing\.example/.test(m.to))
    assert.ok(m.subject && m.text)
  }

  const body = (re) => h.sent.find((m) => re.test(m.subject)).text
  assert.ok(!h.sent.some((m) => /approve/i.test(m.subject)), 'an approval mail still goes out')

  const call = body(/call Acme Roofing — 203-555-0142/)
  assert.match(call, /Phone: 203-555-0142/)
  assert.match(call, /Owner: Dana/)
  assert.match(call, /no online booking/)
  assert.match(call, /\/pitch Acme Roofing/)

  const meeting = body(/replied — book the meeting/)
  assert.match(meeting, /Thread: a question about Acme Roofing/)
  assert.match(meeting, /<msg-r1@send\.bcn-services\.com>/)

  const quote = body(/quote Acme Roofing/)
  assert.match(quote, /wants a portal for his crews/)
})

test('the templates hold up on a row with nothing in research', () => {
  const bare = { id: 'x', name: 'Bare Co', stage: 'call_due', research: null }
  for (const mail of [
    callTaskEmail(bare, { hasPitch: false }),
    meetingEmail(bare, null),
    quoteEmail(bare),
  ]) {
    assert.match(mail.subject, /Bare Co/)
    assert.ok(mail.text.length > 0)
    assert.ok(!/undefined|null|\[object/.test(mail.text), mail.text)
  }
  assert.match(callTaskEmail(bare, { hasPitch: false }).text, /~\/os is not on this machine/)
  assert.match(quoteEmail(bare).text, /left no notes/)
})

// --- what notify is not allowed to do ---------------------------------------

test('a drafted row is not notified about at all: no mail, no event, no read', async () => {
  // The real entry point, with a drafted row as the only thing in the store.
  const h = harness({ rows: [biz({ id: 'd1', stage: 'drafted', next_touch_at: null })] })
  const stagesRead = []
  const byStage = h.deps.db.businessesByStage
  h.deps.db.businessesByStage = (s, stage, opts) => {
    stagesRead.push(stage)
    return byStage(s, stage, opts)
  }

  const result = await notify(h.deps)

  assert.deepEqual(h.sent, [], 'a drafted row still produces mail')
  assert.equal(result.emails, 0)
  assert.equal(result.errors, 0)
  assert.deepEqual(
    kinds(h.events).filter((k) => ['notified', 'would_notify', 'error'].includes(k)),
    [],
    'a drafted row still wrote a notification event'
  )
  assert.ok(!stagesRead.includes('drafted'), 'notify still queries the drafted stage')
})

test('a dry run over a drafted row is silent too', async () => {
  const h = harness({ rows: [biz({ stage: 'drafted', next_touch_at: null })], dryRun: true })

  const result = await notify(h.deps)

  assert.deepEqual(h.sent, [])
  assert.equal(result.emails, 0)
  assert.deepEqual(kinds(h.events).filter((k) => k === 'would_notify'), [])
})

test('notify moves no stage — the fake explodes if it tries', async () => {
  const h = harness({ rows: [biz({ stage: 'replied' }), biz({ id: 'b2', stage: 'quoting' })] })

  const result = await notify(h.deps)

  assert.equal(result.errors, 0)
  assert.deepEqual(h.store.map((r) => r.stage), ['replied', 'quoting'])
})

// --- the queries -------------------------------------------------------------

test('the notify reads go through the view and stay parameterised', () => {
  const seen = []
  const sql = (strings, ...values) => {
    seen.push({ text: strings.join('?'), values })
    return Promise.resolve([])
  }
  businessesByStage(sql, 'call_due', { limit: 10 })
  assert.match(seen[0].text, /from selectable_businesses/)
  assert.deepEqual(seen[0].values, ['call_due', 10])
  assert.throws(() => assertSelectable('select * from businesses where stage = ?'), /selectable_businesses/)

  notifiedKeys(sql, ['b1:call_due:x'])
  assert.match(seen[1].text, /job = 'notify' and kind = 'notified'/)
  assert.deepEqual(seen[1].values, [['b1:call_due:x']])
})
