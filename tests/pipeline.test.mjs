// The end-to-end test. One business walks source -> qualify -> personalize ->
// touch -> poll -> notify through ONE injected deps object, and every job hands
// the next job the row the previous job actually wrote.
//
// Why this file exists: every other test file supplies its own `db` stub, so a
// producer/consumer field-name mismatch between two jobs passes both of their
// unit tests and fails only in production. So there are no per-job db stubs
// here. There is ONE in-memory `sql` fake — a tagged template that dispatches on
// the query text `lib/db.mjs` actually emits — and the REAL `lib/db.mjs` runs
// against it. The store is keyed by the 0018 column names, `selectable_*` reads
// are filtered on `suppressed_at` exactly as the view filters them, and the
// Places client, the page fetcher and the IMAP message decoder are the real
// modules with only their outermost boundary (fetch, a parsed message) faked.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { run as source } from '../jobs/source.mjs'
import { run as qualify } from '../jobs/qualify.mjs'
import { run as personalize } from '../jobs/personalize.mjs'
import { run as touch } from '../jobs/touch.mjs'
import { run as poll } from '../jobs/poll.mjs'
import { run as notify } from '../jobs/notify.mjs'
import { createFetchPage, drainMessages } from '../jobs/run.mjs'
import { createPlaces } from '../lib/places.mjs'
import { GRID } from '../lib/grid.mjs'
import * as db from '../lib/db.mjs'

// --- the store -------------------------------------------------------------
// Column names come from supabase/migrations/0018_pipeline.sql, not from any
// job's idea of them.

const BUSINESS_DEFAULTS = {
  name: null,
  domain: null,
  email: null,
  phone: null,
  address: null,
  town: null,
  state: null,
  trade: null,
  place_id: null,
  source_query: null,
  stage: 'sourced',
  next_touch_at: null,
  touches: 0,
  suppressed_at: null,
  research: {},
}

// `sent_on` is what makes `sent_today` a daily count rather than a lifetime
// one, so the fake carries it: a store row dated before the run's `now` reads
// as zero sends and the next claim restarts the count.
const dayOf = (d) => new Date(d).toISOString().slice(0, 10)

const MAILBOX = {
  address: 'outreach@send.bcn-services.com',
  domain: 'send.bcn-services.com',
  daily_cap: 20,
  sent_today: 0,
  status: 'active',
}

// postgres hands a jsonb column back as an object however the writer sent it;
// the jobs write `JSON.stringify(...)` into `research`, so the fake parses on
// write or the round trip would be more forgiving here than in production.
function toJsonb(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const sortByCreated = (rows) => [...rows].sort((a, b) => a.created_at - b.created_at)

function makeSql({ now }) {
  const today = dayOf(now)
  const store = {
    businesses: [],
    mailboxes: [{ id: 'mb1', ...MAILBOX, sent_on: dayOf(now), warmed_at: now }],
    search_grid: [],
    email_threads: [],
    events: [],
  }
  const reads = []
  let phase = 'init'
  let seq = 0
  const id = (p) => `${p}-${++seq}`
  const clone = (row) => ({
    ...row,
    research: row.research && typeof row.research === 'object' ? { ...row.research } : row.research,
  })
  const selectable = () => store.businesses.filter((b) => b.suppressed_at == null)
  const give = (rows) => {
    reads.push({ phase, ids: rows.map((r) => r.id) })
    return rows.map(clone)
  }
  const byId = (bid) => store.businesses.find((b) => b.id === bid)

  function query(text, values) {
    const q = text.replace(/\s+/g, ' ').trim().toLowerCase()

    // --- businesses: writes ---
    if (q.startsWith('insert into businesses')) {
      const out = []
      for (const row of values[0].data) {
        if (row.place_id && store.businesses.some((b) => b.place_id === row.place_id)) continue
        const created = {
          id: id('biz'),
          ...BUSINESS_DEFAULTS,
          ...row,
          research: toJsonb(row.research ?? {}),
          created_at: new Date(now.getTime() + store.businesses.length),
          updated_at: now,
        }
        store.businesses.push(created)
        out.push(clone(created))
      }
      return out
    }
    if (q.startsWith('update businesses set suppressed_at')) {
      const row = byId(values[0])
      if (!row || row.suppressed_at != null) return []
      row.suppressed_at = now
      row.updated_at = now
      return [{ id: row.id, suppressed_at: row.suppressed_at, reason: values[1] }]
    }
    if (q.startsWith('update businesses set')) {
      const row = byId(values[1])
      if (!row) return []
      for (const [k, v] of Object.entries(values[0].data)) row[k] = k === 'research' ? toJsonb(v) : v
      row.updated_at = new Date(now.getTime() + 1)
      return [clone(row)]
    }

    // --- businesses: reads, all through the view ---
    if (q.includes('count(*)::int as count from selectable_businesses')) {
      return [{ count: selectable().filter((b) => b.stage === 'drafted').length }]
    }
    if (q.includes('from selectable_businesses')) {
      if (q.includes("where stage = 'drafted' or (stage = 'sent'")) {
        const [at, limit] = values
        return give(
          selectable()
            .filter(
              (b) =>
                b.stage === 'drafted' ||
                (b.stage === 'sent' && b.next_touch_at && b.next_touch_at <= at)
            )
            .sort((a, b) => (a.stage === 'drafted' ? 0 : 1) - (b.stage === 'drafted' ? 0 : 1))
            .slice(0, limit)
        )
      }
      if (q.includes('where next_touch_at is not null')) {
        const [at, limit] = values
        return give(
          selectable().filter((b) => b.next_touch_at && b.next_touch_at <= at).slice(0, limit)
        )
      }
      if (q.includes('lower(email) = lower(')) {
        const email = String(values[0] ?? '').toLowerCase()
        return give(
          selectable().filter((b) => String(b.email ?? '').toLowerCase() === email).slice(0, 1)
        )
      }
      if (q.includes('where place_id =')) {
        return give(selectable().filter((b) => b.place_id === values[0]).slice(0, 1))
      }
      if (q.includes("where stage = 'sourced'")) {
        return give(sortByCreated(selectable().filter((b) => b.stage === 'sourced')).slice(0, values[0]))
      }
      if (q.includes("where stage = 'qualified'")) {
        return give(sortByCreated(selectable().filter((b) => b.stage === 'qualified')).slice(0, values[0]))
      }
      if (q.includes('where id =')) {
        return give(selectable().filter((b) => b.id === values[0]).slice(0, 1))
      }
      if (q.includes('where stage = ? order by updated_at')) {
        const [stage, limit] = values
        return give(selectable().filter((b) => b.stage === stage).slice(0, limit))
      }
      throw new Error(`unhandled selectable read: ${q}`)
    }
    if (q.includes('from businesses')) throw new Error(`read bypassed the view: ${q}`)

    // --- mailboxes ---
    if (q.startsWith('select *, case when sent_on') && q.includes('from mailboxes')) {
      return store.mailboxes
        .filter((m) => m.status === 'active')
        .map((m) => ({ ...clone(m), sent_today: m.sent_on === today ? m.sent_today : 0 }))
    }
    if (q.startsWith('update mailboxes set sent_today')) {
      const [address, cap] = values
      const mb = store.mailboxes.find(
        (m) =>
          m.address === address &&
          m.status === 'active' &&
          (m.sent_on !== today || m.sent_today < cap)
      )
      if (!mb) return []
      mb.sent_today = mb.sent_on === today ? mb.sent_today + 1 : 1
      mb.sent_on = today
      return [clone(mb)]
    }

    // --- email_threads ---
    if (q.startsWith('insert into email_threads')) {
      const [message_id, business_id, direction, mailbox, subject] = values
      if (store.email_threads.some((t) => t.message_id === message_id)) return []
      const row = {
        message_id,
        business_id,
        direction,
        mailbox,
        subject,
        created_at: new Date(now.getTime() + store.email_threads.length),
      }
      store.email_threads.push(row)
      return [clone(row)]
    }
    if (q.startsWith('select message_id, subject from email_threads')) {
      return store.email_threads
        .filter((t) => t.business_id === values[0] && t.direction === 'outbound')
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, 1)
        .map((t) => ({ message_id: t.message_id, subject: t.subject }))
    }
    if (q.startsWith('select message_id, business_id from email_threads')) {
      const ids = values[0]
      return store.email_threads
        .filter((t) => ids.includes(t.message_id) && t.business_id != null)
        .sort((a, b) => ids.indexOf(a.message_id) - ids.indexOf(b.message_id))
        .slice(0, 1)
        .map((t) => ({ message_id: t.message_id, business_id: t.business_id }))
    }

    // --- events ---
    if (q.startsWith('insert into events')) {
      const [job, kind, detail] = values
      const row = { id: store.events.length + 1, job, kind, detail: detail ?? {}, created_at: now }
      store.events.push(row)
      return [clone(row)]
    }
    if (q.includes('count(*)::int as count from events')) {
      const uid = values[0]
      return [
        {
          count: store.events.filter(
            (e) =>
              e.job === 'poll' &&
              ['error', 'dead_letter'].includes(e.kind) &&
              String(e.detail?.uid ?? '') === uid
          ).length,
        },
      ]
    }
    if (q.includes("select distinct detail->>'key' as key from events")) {
      const keys = values[0]
      const found = new Set(
        store.events
          .filter((e) => e.job === 'notify' && e.kind === 'notified' && keys.includes(e.detail?.key))
          .map((e) => e.detail.key)
      )
      return [...found].map((key) => ({ key }))
    }

    // --- search_grid ---
    if (q.startsWith('insert into search_grid')) {
      const out = []
      for (const cell of values[0].data) {
        if (
          store.search_grid.some(
            (c) => c.trade === cell.trade && c.town === cell.town && c.state === cell.state
          )
        )
          continue
        const row = {
          id: id('cell'),
          ...cell,
          exhausted_at: null,
          last_run_at: null,
          new_rows_last_run: null,
        }
        store.search_grid.push(row)
        out.push(clone(row))
      }
      return out
    }
    if (q.startsWith('select * from search_grid')) return store.search_grid.map(clone)
    if (q.startsWith('update search_grid')) {
      const [last_run_at, new_rows_last_run, exhausted_at, trade, town, state] = values
      const cell = store.search_grid.find(
        (c) => c.trade === trade && c.town === town && c.state === state
      )
      if (!cell) return []
      Object.assign(cell, { last_run_at, new_rows_last_run, exhausted_at })
      return [clone(cell)]
    }

    throw new Error(`unhandled query: ${q}`)
  }

  function sql(first, ...rest) {
    // A tagged-template call; anything else is postgres.js's `sql(data, ...keys)`
    // fragment helper, which db.mjs uses to build insert and update column lists.
    if (Array.isArray(first) && Array.isArray(first.raw)) {
      return Promise.resolve(query(first.join(' ? '), rest))
    }
    return { data: first, keys: rest }
  }
  sql.json = (v) => v
  sql.begin = (fn) => fn(sql)
  sql.end = async () => {}
  sql.store = store
  sql.reads = reads
  sql.phase = (name) => {
    phase = name
  }
  return sql
}

// --- the outside world, faked at its outermost edge only -------------------

const PLACE = {
  id: 'places/ChIJacme',
  displayName: { text: 'Acme Roofing' },
  formattedAddress: '12 Main St, Milford, CT 06460',
  nationalPhoneNumber: '(203) 555-0100',
  websiteUri: 'https://www.acmeroofing.example/',
  rating: 4.8,
  userRatingCount: 61,
}

const SECOND_PLACE = {
  id: 'places/ChIJbolt',
  displayName: { text: 'Bolt Roofing' },
  formattedAddress: '9 Bridge Rd, Milford, CT 06460',
  nationalPhoneNumber: '(203) 555-0200',
  websiteUri: 'https://boltroofing.example',
  rating: 4.5,
  userRatingCount: 22,
}

const HOME = (name) => `<html><body><h1>${name}</h1>
  <p>${name} has been family run since 1998 and serves Milford, Stratford and Orange CT.</p>
  <p>We are GAF Master Elite certified and our crews do asphalt, slate and flat roofs.</p>
  </body></html>`

const CONTACT = (email) =>
  `<html><body><p>Call us or email ${email} and we will come out.</p></body></html>`

const PAGES = {
  'https://acmeroofing.example': HOME('Acme Roofing'),
  'https://acmeroofing.example/contact': CONTACT('hello@acmeroofing.example'),
  'https://boltroofing.example': HOME('Bolt Roofing'),
  'https://boltroofing.example/contact': CONTACT('office@boltroofing.example'),
}

const FACTS = [
  'Family run since 1998',
  'Serves Milford, Stratford and Orange CT',
  'GAF Master Elite certified',
]

function claudeFor(state) {
  let asks = 0
  return {
    get asks() {
      return asks
    },
    async ask(prompt) {
      asks++
      if (prompt.includes('Return ONLY minified JSON')) {
        const email = /email (\S+@\S+) and we will/.exec(prompt)?.[1] ?? null
        return JSON.stringify({
          email,
          facts: FACTS,
          fit: 'good',
          reason: 'runs a crew, tracks jobs on paper',
        })
      }
      if (prompt.includes('ONE sentence for a cold email')) {
        return 'Most roofing owners we talk to end up rebuilding the same estimate by hand every week'
      }
      if (prompt.includes('Classify this reply')) return state.classification
      throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`)
    },
  }
}

// mailparser's shape, as `toMessage` in jobs/run.mjs reads it. The real decoder
// runs, so the header names the poller depends on are exercised here.
function inbound({ from, to, subject, text, inReplyTo = '' }) {
  return {
    from: { value: [{ address: from }] },
    headers: new Map([['delivered-to', to]]),
    subject,
    text,
    inReplyTo,
    references: [],
  }
}

const TEAMMATE = 'nseluga@bcn-services.com'
const OUTREACH = 'outreach@send.bcn-services.com'
const BOT = 'bot@bcn-services.com'

function pipeline({ places = [PLACE], allowedRecipients = [], internalRecipients = [TEAMMATE] } = {}) {
  const now = new Date('2026-09-07T13:00:00Z')
  const sql = makeSql({ now })
  const state = { classification: 'interested' }
  const claude = claudeFor(state)
  const sent = []
  const seen = []
  let inboxMessages = []
  let uuids = 0

  const deps = {
    sql,
    db,
    logEvent: db.logEvent,
    now,
    dryRun: false,
    uuid: () => `uuid-${++uuids}`,
    random: () => 0,
    sleep: async () => {},
    // Two lists, never one: `allowedRecipients` is which PROSPECTS touch may
    // mail, `internalRecipients` is which humans poll/notify forward to and
    // whose commands are obeyed. The pipeline run below keeps them disjoint.
    allowedRecipients,
    internalRecipients,
    notifyFrom: BOT,
    outreachAddress: OUTREACH,
    botAddress: BOT,
    claude,
    places: createPlaces({
      token: 'test-token',
      project: 'test-project',
      fetch: async () => ({ ok: true, json: async () => ({ places }) }),
    }),
    readBudget: async () => ({ used: 12, cap: 950, remaining: 938 }),
    loadCells: async () => {
      await db.upsertCells(sql, GRID)
      return db.allCells(sql)
    },
    saveCell: (cell) => db.saveCell(sql, cell),
    fetchPage: createFetchPage({
      fetchImpl: async (url) => {
        const body = PAGES[url.replace(/\/$/, '')]
        if (!body) return { ok: false, status: 404, text: async () => '' }
        return { ok: true, status: 200, text: async () => body }
      },
    }),
    verify: async () => ({ status: 'ok' }),
    transport: async () => ({
      sendMail: async ({ envelope, raw }) => {
        sent.push({ from: envelope.from, to: envelope.to, raw })
        return { accepted: [envelope.to] }
      },
    }),
    imap: async () => ({
      messages: () =>
        drainMessages(
          inboxMessages.map((m, i) => ({ uid: i + 1, source: m })),
          async (parsed) => parsed
        ),
      markSeen: async (uid) => seen.push(uid),
      close: async () => {},
    }),
  }

  return {
    deps,
    sql,
    store: sql.store,
    sent,
    seen,
    state,
    claude,
    inbox: (msgs) => {
      inboxMessages = msgs
    },
    row: (name) => sql.store.businesses.find((b) => b.name === name),
    events: (job, kind) => sql.store.events.filter((e) => e.job === job && (!kind || e.kind === kind)),
  }
}

// The base64 body parts of one MIME message, decoded and joined.
function bodyOf(raw) {
  return String(raw)
    .split(/--bcns-[^\r\n]*\r\n/)
    .slice(1)
    .map((part) => {
      const at = part.indexOf('\r\n\r\n')
      return at === -1 ? '' : Buffer.from(part.slice(at + 4), 'base64').toString('utf8')
    })
    .join('\n')
}

test('one business walks sourced -> qualified -> drafted -> sent -> replied through every job in schedule order', async () => {
  const p = pipeline()

  // --- Monday 13:00 — source, then qualify (SCHEDULES['0 13 * * 1']) ---
  p.sql.phase('source')
  const sourced = await source(p.deps)
  assert.equal(sourced.inserted, 1)
  assert.equal(sourced.query, 'roofers in Milford CT')

  let row = p.row('Acme Roofing')
  assert.ok(row, 'source wrote no business row')
  // The producer/consumer seam that has already bitten this lane once: the
  // Places client emits place_id/website, jobs/source.mjs stores place_id and a
  // bare hostname in `domain`.
  assert.equal(row.place_id, 'places/ChIJacme')
  assert.equal(row.domain, 'acmeroofing.example')
  assert.equal(row.phone, '(203) 555-0100')
  assert.equal(row.town, 'Milford')
  assert.equal(row.trade, 'roofers')
  assert.equal(row.stage, 'sourced')

  p.sql.phase('qualify')
  const qualified = await qualify(p.deps)
  assert.deepEqual(qualified, { qualified: 1, callDue: 0, errors: 0 })

  row = p.row('Acme Roofing')
  assert.equal(row.stage, 'qualified')
  assert.equal(row.email, 'hello@acmeroofing.example')
  assert.equal(row.research.facts.length, 3)
  assert.equal(row.research.fit, 'good')

  // --- personalize (see the report: it has no cron cell of its own) ---
  p.sql.phase('personalize')
  const drafted = await personalize(p.deps)
  assert.deepEqual(drafted, { drafted: 1, skipped: 0, errors: 0 })

  row = p.row('Acme Roofing')
  assert.equal(row.stage, 'drafted')
  assert.match(row.research.draft, /^Subject: a question about Acme Roofing\n\n/)
  assert.match(row.research.draft, /rebuilding the same estimate by hand every week and I'd love/)
  // personalize merges into `research`; it must not clobber qualify's keys.
  assert.equal(row.research.facts.length, 3)
  assert.equal(row.research.fit, 'good')

  // --- weekday 14:00 — touch (SCHEDULES['0 14 * * 1-5']) ---
  // The recipient has to be on the send allow-list for a real send, so the list
  // here is what a live pilot's SEND_ALLOWED_RECIPIENTS would hold — the
  // prospect and nobody internal.
  p.deps.allowedRecipients = ['hello@acmeroofing.example']
  p.sql.phase('touch')
  const touched = await touch(p.deps)
  assert.equal(touched.sent, 1)
  assert.equal(touched.refused, 0)
  assert.equal(touched.errors, 0)

  row = p.row('Acme Roofing')
  assert.equal(row.stage, 'sent')
  assert.equal(row.touches, 1)
  assert.equal(row.next_touch_at.toISOString(), '2026-09-14T13:00:00.000Z')

  assert.equal(p.sent.length, 1)
  assert.equal(p.sent[0].to, 'hello@acmeroofing.example')
  assert.equal(p.sent[0].from, OUTREACH)
  // The bytes on the wire are the draft personalize wrote, not a re-render.
  assert.match(bodyOf(p.sent[0].raw), /rebuilding the same estimate by hand every week/)

  const [thread] = p.store.email_threads
  assert.equal(thread.business_id, row.id)
  assert.equal(thread.direction, 'outbound')
  assert.equal(thread.mailbox, OUTREACH)
  assert.equal(p.store.mailboxes[0].sent_today, 1)

  // --- every 20 min — poll, then notify (SCHEDULES['*/20 8-20 * * 1-5']) ---
  // The reply threads on the Message-ID the sender actually recorded.
  p.inbox([
    inbound({
      from: 'hello@acmeroofing.example',
      to: OUTREACH,
      subject: 'Re: a question about Acme Roofing',
      text: 'This sounds useful. What times work for a call next week?',
      inReplyTo: thread.message_id,
    }),
  ])
  p.sql.phase('poll')
  const polled = await poll(p.deps)
  assert.equal(polled.read, 1)
  assert.equal(polled.replied, 1)
  assert.equal(polled.suppressed, 0)
  assert.equal(polled.errors, 0)
  assert.deepEqual(p.seen, [1])

  row = p.row('Acme Roofing')
  assert.equal(row.stage, 'replied')
  assert.equal(row.next_touch_at, null)
  assert.ok(row.research.draft, 'poll clobbered research')

  p.sql.phase('notify')
  const notified = await notify(p.deps)
  assert.equal(notified.replied, 1)
  assert.equal(notified.errors, 0)

  const toTeammate = p.sent.slice(1).find((m) => m.to === TEAMMATE)
  assert.ok(toTeammate, 'no meeting notification reached the allow-listed teammate')
  assert.match(bodyOf(toTeammate.raw), /Acme Roofing replied\. Book the meeting\./)
  // The notification carries the thread the sender recorded, not a fresh id.
  assert.match(bodyOf(toTeammate.raw), /Message-ID: <uuid-1@send\.bcn-services\.com>/)
  assert.equal(thread.message_id, '<uuid-1@send.bcn-services.com>')
  assert.equal(p.events('notify', 'notified').length, 1)

  // The row is at `replied` and nothing further moves it this tick.
  assert.equal(p.row('Acme Roofing').stage, 'replied')
})

test('an opt-out reply sets suppressed_at, and no later job in the same run selects that row', async () => {
  const p = pipeline({ places: [PLACE, SECOND_PLACE] })
  p.deps.allowedRecipients = ['hello@acmeroofing.example', 'office@boltroofing.example']

  p.sql.phase('source')
  await source(p.deps)
  p.sql.phase('qualify')
  await qualify(p.deps)
  p.sql.phase('personalize')
  await personalize(p.deps)
  p.sql.phase('touch')
  await touch(p.deps)

  const bolt = p.row('Bolt Roofing')
  const acme = p.row('Acme Roofing')
  assert.equal(bolt.stage, 'sent')
  assert.equal(acme.stage, 'sent')
  assert.equal(bolt.suppressed_at, null)

  const boltThread = p.store.email_threads.find((t) => t.business_id === bolt.id)
  const acmeThread = p.store.email_threads.find((t) => t.business_id === acme.id)

  // Mid-path: one opt-out, one ordinary reply on the same tick.
  p.inbox([
    inbound({
      from: 'office@boltroofing.example',
      to: OUTREACH,
      subject: 'Re: a question about Bolt Roofing',
      text: 'Please remove me from your list.',
      inReplyTo: boltThread.message_id,
    }),
    inbound({
      from: 'hello@acmeroofing.example',
      to: OUTREACH,
      subject: 'Re: a question about Acme Roofing',
      text: 'Interested, send me some times.',
      inReplyTo: acmeThread.message_id,
    }),
  ])
  p.sql.phase('poll')
  const polled = await poll(p.deps)
  assert.equal(polled.suppressed, 1)
  assert.equal(polled.replied, 1)

  const suppressed = p.store.businesses.find((b) => b.id === bolt.id)
  assert.notEqual(suppressed.suppressed_at, null)
  // Suppression is a timestamp, never a stage: the funnel position is untouched.
  assert.equal(suppressed.stage, 'sent')

  const cutoff = p.sql.reads.length

  // The rest of the same tick, then the next week's sender and the next poll.
  p.sql.phase('notify')
  await notify(p.deps)
  p.sql.phase('touch-2')
  p.deps.now = new Date('2026-09-15T14:00:00Z')
  await touch(p.deps)
  p.sql.phase('poll-2')
  p.inbox([])
  await poll(p.deps)

  const later = p.sql.reads.slice(cutoff)
  assert.ok(later.length > 0, 'no reads happened after the suppression')
  for (const read of later) {
    assert.ok(!read.ids.includes(bolt.id), `${read.phase} selected the suppressed row`)
  }
  // And the sender never mailed it again: exactly the one first touch, sent
  // before the opt-out arrived. (Internal notifier mail is counted separately —
  // it goes out from bot@, and see the report on the shared allow-list.)
  const outreachToBolt = p.sent.filter(
    (m) => m.to === 'office@boltroofing.example' && m.from === OUTREACH
  )
  assert.equal(outreachToBolt.length, 1)
  assert.equal(p.store.businesses.find((b) => b.id === bolt.id).touches, 1)
})

test('a mailbox spent yesterday sends again today rather than going quiet forever', async () => {
  const p = pipeline({ places: [PLACE] })
  p.deps.allowedRecipients = ['hello@acmeroofing.example']

  // Yesterday this mailbox hit its cap. Before the rollover the counter was
  // never reset by anything, so `daily_cap` was a LIFETIME cap: touch logged
  // `every mailbox is at its warmed cap` and stopped sending, silently, for
  // good. The count is stale, not spent.
  const mb = p.store.mailboxes[0]
  mb.sent_today = mb.daily_cap
  mb.sent_on = '2026-09-06'

  p.sql.phase('source')
  await source(p.deps)
  p.sql.phase('qualify')
  await qualify(p.deps)
  p.sql.phase('personalize')
  await personalize(p.deps)
  p.sql.phase('touch')
  const res = await touch(p.deps)

  assert.equal(res.sent, 1, 'yesterday’s count blocked today’s send')
  assert.equal(p.row('Acme Roofing').stage, 'sent')
  // The claim restarted the day rather than adding to yesterday's total.
  assert.equal(mb.sent_today, 1)
  assert.equal(mb.sent_on, '2026-09-07')
  assert.equal(p.events('touch', 'skipped').length, 0)
})
