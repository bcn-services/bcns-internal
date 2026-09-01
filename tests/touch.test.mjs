import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  run as touch,
  warmedCap,
  jitterMs,
  buildMime,
  splitDraft,
  assertAllowed,
  BUMP_BODY,
  MAX_TOUCHES,
} from '../jobs/touch.mjs'
import { render } from '../lib/template.mjs'
import { assertSelectable, dueTouches, claimMailboxSlot } from '../lib/db.mjs'

const SIG_TXT = readFileSync(new URL('../lib/signature.txt', import.meta.url), 'utf8').trim()
const SIG_HTML = readFileSync(new URL('../lib/signature.html', import.meta.url), 'utf8').trim()

const NOW = new Date('2026-09-01T14:00:00Z')
const ALLOWED = ['nseluga@bcn-services.com', 'bchung@bcn-services.com']
const OLD = new Date('2026-06-01T00:00:00Z') // warmed months ago: ramp is at daily_cap

const DRAFT = render({
  name: 'Acme Roofing',
  ownerName: 'Dana',
  email: 'nseluga@bcn-services.com',
  sentence: 'Most roofing owners we talk to end up tracking jobs on paper',
})

// Real column names, straight from 0018_pipeline.sql, and research.draft is the
// string personalize.mjs writes. A fixture that invents camelCase would let a
// producer/consumer mismatch pass both suites.
function biz(over = {}) {
  return {
    id: 'b1',
    name: 'Acme Roofing',
    email: 'nseluga@bcn-services.com',
    stage: 'drafted',
    touches: 0,
    next_touch_at: null,
    suppressed_at: null,
    research: JSON.stringify({ facts: ['a', 'b', 'c'], draft: DRAFT }),
    ...over,
  }
}

function mailbox(over = {}) {
  return {
    address: 'outreach@send.bcn-services.com',
    domain: 'send.bcn-services.com',
    daily_cap: 20,
    sent_today: 0,
    warmed_at: OLD,
    status: 'active',
    ...over,
  }
}

const TX = { tx: true }

function harness({ rows = [biz()], mailboxes = [mailbox()], prior = [], dryRun = true, allowed = ALLOWED } = {}) {
  const trace = []          // one ordered log of events, claims and connections
  const events = []
  const updates = []
  const threads = []
  const sent = []
  const claims = []
  const handles = []
  const caps = new Map(mailboxes.map((m) => [m.address, m.sent_today]))

  const deps = {
    sql: {
      begin: async (fn) => fn(TX),
    },
    db: {
      logEvent: (_s, job, kind, detail) => {
        events.push({ job, kind, detail })
        trace.push(`event:${kind}`)
      },
      dueTouches: async () => rows,
      activeMailboxes: async () => mailboxes,
      claimMailboxSlot: async (_s, { address, cap }) => {
        claims.push({ address, cap })
        trace.push(`claim:${address}`)
        const at = caps.get(address) ?? 0
        if (at >= cap) return []
        caps.set(address, at + 1)
        return [{ ...mailboxes.find((m) => m.address === address), sent_today: at + 1 }]
      },
      firstOutbound: async () => prior,
      recordThread: async (s, t) => {
        handles.push(s)
        threads.push(t)
        return []
      },
      updateBusiness: async (s, id, patch) => {
        handles.push(s)
        updates.push({ id, patch })
        return []
      },
    },
    transport: async () => {
      trace.push('transport:construct')
      return {
        sendMail: async (m) => {
          trace.push('transport:sendMail')
          sent.push(m)
        },
      }
    },
    allowedRecipients: allowed,
    dryRun,
    now: NOW,
    random: () => 0.5,
    sleep: async (ms) => trace.push(`sleep:${ms}`),
    uuid: (() => {
      let n = 0
      return () => `id${++n}`
    })(),
  }
  return { deps, trace, events, updates, threads, sent, claims, handles, caps }
}

const mime = (raw) => {
  const boundary = /boundary="([^"]+)"/.exec(raw)[1]
  const headers = raw.slice(0, raw.indexOf('\r\n\r\n'))
  const parts = raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => {
      const [head, body] = p.split('\r\n\r\n')
      return {
        type: /Content-Type: ([^;]+)/.exec(head)[1],
        body: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
      }
    })
  return { headers, parts }
}

// --- pure helpers ----------------------------------------------------------

test('the warming ramp yields the per-mailbox cap for a given warmed_at age', () => {
  const day = 86_400_000
  const at = (days) => warmedCap({ dailyCap: 20, warmedAt: new Date(NOW - days * day), now: NOW })
  assert.equal(at(0), 5, 'day zero')
  assert.equal(at(6), 5, 'still week one')
  assert.equal(at(7), 10, 'week two')
  assert.equal(at(14), 15)
  assert.equal(at(21), 20)
  assert.equal(at(400), 20, 'never above daily_cap')
  assert.equal(warmedCap({ dailyCap: 3, warmedAt: new Date(NOW - 400 * day), now: NOW }), 3)
  assert.equal(warmedCap({ dailyCap: 20, warmedAt: null, now: NOW }), 5, 'unwarmed is day zero')
})

test('jitter stays inside the hour and the subject line is split off the draft', () => {
  assert.equal(jitterMs(() => 0), 0)
  assert.ok(jitterMs(() => 0.999999) < 60 * 60 * 1000)
  const { subject, body } = splitDraft(DRAFT)
  assert.equal(subject, 'a question about Acme Roofing')
  assert.ok(body.startsWith('Hi Dana,'))
  assert.ok(!body.includes('Subject:'))
})

test('the bump copy is under forty words and makes no new argument', () => {
  const words = BUMP_BODY.trim().split(/\s+/)
  assert.ok(words.length < 40, `bump is ${words.length} words`)
  assert.ok(!/free|price|\$|demo is ready|http/i.test(BUMP_BODY))
})

test('the allow-list refuses an unlisted address and an empty list allows nobody', () => {
  assert.doesNotThrow(() => assertAllowed('NSeluga@BCN-Services.com', ALLOWED))
  // The default names the SEND list, because `touch` is the caller that does
  // not pass a name. A refusal that named the wrong variable would send the
  // operator to widen the list that is not blocking them.
  assert.throws(() => assertAllowed('owner@stranger.test', ALLOWED), /SEND_ALLOWED_RECIPIENTS/)
  assert.throws(() => assertAllowed('nseluga@bcn-services.com', []), /SEND_ALLOWED_RECIPIENTS/)
  assert.throws(() => assertAllowed('nseluga@bcn-services.com', undefined), /SEND_ALLOWED_RECIPIENTS/)
  // The internal caller names its own list.
  assert.throws(
    () => assertAllowed('owner@stranger.test', ALLOWED, 'NOTIFY_ALLOWED_RECIPIENTS'),
    /is not in NOTIFY_ALLOWED_RECIPIENTS — refused before any connection/
  )
})

test('dueTouches reads through selectable_businesses and excludes replied rows', () => {
  let text = ''
  const sql = (strings) => { text = strings.join('?'); return [] }
  dueTouches(sql, { now: NOW })
  assert.match(text, /selectable_businesses/)
  assert.match(text, /stage = 'drafted'/)
  assert.match(text, /stage = 'sent'/)
  assert.ok(!/replied/.test(text))
  assert.doesNotThrow(() => assertSelectable(text))
})

test('claimMailboxSlot increments only below the cap, and starts over on a new day', () => {
  let text = ''
  claimMailboxSlot((strings) => { text = strings.join('?'); return [] }, { address: 'a@b.test', cap: 5 })
  // A stale sent_on restarts the count at 1 rather than adding to yesterday's:
  // without this the cap was a LIFETIME cap and the mailbox went quiet forever.
  assert.match(text, /sent_today = case when sent_on = current_date then sent_today \+ 1 else 1 end/)
  assert.match(text, /sent_on = current_date/)
  // The day is a way past the cap guard, so a mailbox spent yesterday claims today.
  assert.match(text, /sent_on is distinct from current_date or sent_today < \?/)
  assert.match(text, /returning \*/)
})

// --- run(deps) -------------------------------------------------------------

test('a mailbox at capacity is skipped and the next one is chosen', async () => {
  const full = mailbox({ address: 'full@send.bcn-services.com', sent_today: 20 })
  const spare = mailbox({ address: 'spare@send.bcn-services.com', sent_today: 0 })
  const h = harness({ mailboxes: [full, spare], dryRun: false })
  const res = await touch(h.deps)
  assert.equal(res.sent, 1)
  assert.deepEqual(h.claims.map((c) => c.address), [full.address, spare.address])
  assert.equal(h.claims[0].cap, 20, 'the cap offered is the warmed cap, not daily_cap blindly')
  assert.equal(h.caps.get(full.address), 20, 'the full mailbox was incremented past its cap')
  assert.equal(h.caps.get(spare.address), 1)
  assert.equal(h.sent[0].envelope.from, spare.address)
})

test('every mailbox at capacity sends nothing and writes a skipped event', async () => {
  const h = harness({ mailboxes: [mailbox({ sent_today: 20 })], dryRun: false })
  const res = await touch(h.deps)
  assert.equal(res.sent, 0)
  assert.equal(h.sent.length, 0)
  assert.ok(!h.trace.includes('transport:construct'))
  assert.match(h.events.at(-1).detail.reason, /warmed cap/)
})

test('a row at touches=3 with no reply lands at call_due and issues no SMTP command', async () => {
  // The literal 3, not MAX_TOUCHES: an assertion written against the constant
  // moves with it, so raising the ladder to four touches would pass silently.
  assert.equal(MAX_TOUCHES, 3, 'exactly two bumps; the third touch is a call')
  const h = harness({ rows: [biz({ stage: 'sent', touches: 3, next_touch_at: OLD })], dryRun: false })
  const res = await touch(h.deps)
  assert.equal(res.callDue, 1)
  assert.equal(res.sent + res.bumped, 0)
  assert.deepEqual(h.updates, [{ id: 'b1', patch: { stage: 'call_due', next_touch_at: null } }])
  assert.equal(h.sent.length, 0, 'a third email went out')
  assert.deepEqual(h.trace.filter((t) => t.startsWith('transport')), [], 'the transport was touched')
  assert.deepEqual(h.claims, [], 'a mailbox slot was burned on a call_due row')
  assert.equal(h.events.at(-1).kind, 'call_due')
})

test('a bump carries In-Reply-To of the first message and adds no new argument', async () => {
  const h = harness({
    rows: [biz({ stage: 'sent', touches: 1, next_touch_at: OLD })],
    prior: [{ message_id: '<first@send.bcn-services.com>', subject: 'a question about Acme Roofing' }],
    dryRun: false,
  })
  const res = await touch(h.deps)
  assert.equal(res.bumped, 1)
  const { headers, parts } = mime(h.sent[0].raw)
  assert.match(headers, /^In-Reply-To: <first@send\.bcn-services\.com>$/m)
  assert.match(headers, /^References: <first@send\.bcn-services\.com>$/m)
  assert.match(headers, /^Subject: Re: a question about Acme Roofing$/m)
  assert.ok(parts[0].body.includes(BUMP_BODY), 'the bump body is the fixed short copy')
  assert.ok(!parts[0].body.includes('fifteen minutes on a call'), 'the bump restated the pitch')
  assert.equal(h.updates[0].patch.touches, 2)
})

test('the second bump is the last: touches lands at 3 and the next run calls', async () => {
  const h = harness({
    rows: [biz({ stage: 'sent', touches: 2, next_touch_at: OLD })],
    prior: [{ message_id: '<first@x>', subject: 'a question about Acme Roofing' }],
    dryRun: false,
  })
  await touch(h.deps)
  assert.equal(h.updates[0].patch.touches, 3)
  assert.equal(h.updates[0].patch.stage, 'sent')
})

test('the thread row, the counter and the stage commit in one transaction', async () => {
  const h = harness({ dryRun: false })
  await touch(h.deps)
  assert.equal(h.handles.length, 2)
  assert.ok(h.handles.every((s) => s === TX), 'a write escaped sql.begin')
  assert.equal(h.threads[0].messageId, h.sent[0].raw.match(/^Message-ID: (\S+)$/m)[1])
  assert.equal(h.threads[0].direction, 'outbound')
  assert.equal(h.threads[0].business_id ?? h.threads[0].businessId, 'b1')
  const patch = h.updates[0].patch
  assert.equal(patch.stage, 'sent')
  assert.equal(patch.touches, 1)
  assert.equal(patch.next_touch_at.getTime(), NOW.getTime() + 7 * 86_400_000)
})

test('with DRY_RUN off an unlisted address is refused before any connection opens', async () => {
  const h = harness({
    rows: [biz({ id: 'stranger', email: 'owner@stranger.test' }), biz({ id: 'ok' })],
    dryRun: false,
  })
  const res = await touch(h.deps)

  assert.equal(res.refused, 1)
  const refusedAt = h.trace.indexOf('event:refused')
  const firstConnect = h.trace.indexOf('transport:construct')
  assert.ok(refusedAt > -1, 'no refusal was recorded')
  assert.ok(firstConnect > refusedAt, 'a connection opened before the refusal')
  assert.deepEqual(h.sent.map((m) => m.envelope.to), ['nseluga@bcn-services.com'])
  assert.deepEqual(h.claims.map((c) => c.address), [mailbox().address], 'the refused row burned a slot')

  // …and an allow-listed address is not refused.
  assert.equal(res.sent, 1)
  assert.ok(h.events.some((e) => e.kind === 'sent' && e.detail.business === 'ok'))
})

test('an empty allow-list allows nobody, even with DRY_RUN off', async () => {
  const h = harness({ dryRun: false, allowed: [] })
  const res = await touch(h.deps)
  assert.equal(res.refused, 1)
  assert.equal(res.sent, 0)
  assert.deepEqual(h.trace.filter((t) => t.startsWith('transport')), [])
})

// SEND_ALLOWED_RECIPIENTS and NOTIFY_ALLOWED_RECIPIENTS are two lists. Every
// address below is a literal: importing one from the module under test would
// let the constant move with the bug.
test('an internal recipient that is not on the send list cannot be mailed by touch', async () => {
  const h = harness({
    rows: [biz({ id: 'internal', email: 'nseluga@bcn-services.com' })],
    dryRun: false,
    allowed: ['dana@acmeroofing.example'],
  })
  // The internal list is populated, and it must buy this address nothing.
  h.deps.internalRecipients = ['nseluga@bcn-services.com', 'bchung@bcn-services.com']

  const res = await touch(h.deps)

  assert.equal(res.refused, 1)
  assert.equal(res.sent, 0)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.trace.filter((t) => t.startsWith('transport')), [], 'a connection opened')
  const refusal = h.events.find((e) => e.kind === 'refused')
  assert.ok(refusal, 'no refusal was recorded')
  assert.match(String(refusal.detail.error ?? refusal.detail.reason ?? ''), /SEND_ALLOWED_RECIPIENTS/)
})

test('an empty send list allows nobody however full the internal list is', async () => {
  const h = harness({ dryRun: false, allowed: [] })
  h.deps.internalRecipients = ['nseluga@bcn-services.com']

  const res = await touch(h.deps)

  assert.equal(res.refused, 1)
  assert.equal(res.sent, 0)
  assert.deepEqual(h.trace.filter((t) => t.startsWith('transport')), [])
})

test('with DRY_RUN on nothing opens SMTP and nothing is written', async () => {
  const h = harness({ dryRun: true })
  const res = await touch(h.deps)
  assert.equal(res.wouldSend, 1)
  assert.deepEqual(h.trace.filter((t) => t.startsWith('transport')), [], 'a dry run touched the transport')
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.claims, [], 'a dry run wrote to mailboxes')
  assert.deepEqual(h.updates, [])
  assert.deepEqual(h.threads, [])
  assert.equal(h.events.at(-1).kind, 'would_send')
})

test('the message is multipart/alternative carrying both signature files verbatim', async () => {
  const h = harness({ dryRun: false })
  await touch(h.deps)
  const { headers, parts } = mime(h.sent[0].raw)
  assert.match(headers, /^Content-Type: multipart\/alternative; boundary="[^"]+"$/m)
  assert.equal(parts.length, 2)
  assert.deepEqual(parts.map((p) => p.type), ['text/plain', 'text/html'])
  assert.ok(parts[0].body.includes(SIG_TXT), 'lib/signature.txt is not in the text part verbatim')
  assert.ok(parts[1].body.includes(SIG_HTML), 'lib/signature.html is not in the html part verbatim')
  assert.ok(!parts[1].body.includes(SIG_TXT), 'the html part carries the plain-text signature too')
  assert.ok(parts[0].body.startsWith('Hi Dana,'))
  assert.ok(parts[1].body.includes('<p>Hi Dana,</p>'))
})

test('a suppressed or replied row is never sent to, and sends jitter over the hour', async () => {
  const h = harness({
    rows: [biz({ id: 's', suppressed_at: NOW }), biz({ id: 'r', stage: 'replied', touches: 1 })],
    dryRun: false,
  })
  const res = await touch(h.deps)
  assert.equal(res.skipped, 2)
  assert.deepEqual(h.sent, [])

  const j = harness({ dryRun: false })
  await touch(j.deps)
  const slept = j.trace.find((t) => t.startsWith('sleep:'))
  assert.ok(Number(slept.slice(6)) > 0 && Number(slept.slice(6)) < 60 * 60 * 1000)
})

test('no rows and no transport each write their own skipped event', async () => {
  const empty = harness({ rows: [] })
  await touch(empty.deps)
  assert.match(empty.events.at(-1).detail.reason, /no rows due/)

  const noTransport = harness({ dryRun: false })
  delete noTransport.deps.transport
  const res = await touch(noTransport.deps)
  assert.equal(res.sent, 0)
  assert.match(noTransport.events.at(-1).detail.reason, /missing deps: transport/)
})

test('buildMime omits In-Reply-To on a first send', () => {
  const raw = buildMime({
    from: 'a@b.test', to: 'c@d.test', subject: 's', text: 't', html: '<p>t</p>',
    messageId: '<m@b.test>', date: NOW, boundary: 'bnd',
  })
  assert.ok(!/In-Reply-To/.test(raw))
  assert.match(raw, /^Message-ID: <m@b\.test>$/m)
})
