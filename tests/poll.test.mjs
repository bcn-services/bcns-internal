import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toMessage, htmlToText } from '../jobs/run.mjs'
import {
  run as poll,
  isOptOutMessage,
  OPT_OUT_PATTERNS,
  stripQuoted,
  isOptOut,
  isAutoReply,
  parseCommand,
  threadIds,
  readCategory,
  isAllowedSender,
  ADVANCED_STAGES,
  NO_ANSWER_DAYS,
  MAX_ATTEMPTS,
} from '../jobs/poll.mjs'
import {
  threadByMessageIds,
  businessById,
  assertSelectable,
  messageFailureCount,
} from '../lib/db.mjs'

const NOW = new Date('2026-09-02T09:00:00Z')
const ALLOWED = ['nseluga@bcn-services.com', 'bchung@bcn-services.com']
const OUTREACH = 'outreach@send.bcn-services.com'
const BOT = 'bot@bcn-services.com'
const FIRST_ID = '<msg-1@send.bcn-services.com>'

// Column names straight from 0018_pipeline.sql and the rows jobs/touch.mjs
// actually writes — email_threads is (message_id, business_id, direction,
// mailbox, subject). A camelCase fixture here would hide a real mismatch.
function biz(over = {}) {
  return {
    id: 'b1',
    name: 'Acme Roofing',
    email: 'dana@acmeroofing.example',
    stage: 'sent',
    touches: 1,
    next_touch_at: new Date('2026-09-09T14:00:00Z'),
    suppressed_at: null,
    research: JSON.stringify({ facts: ['a'], draft: 'Subject: x\n\nbody' }),
    ...over,
  }
}

function msg(over = {}) {
  return {
    uid: 7,
    messageId: '<reply-7@acmeroofing.example>',
    from: 'dana@acmeroofing.example',
    deliveredTo: OUTREACH,
    subject: 'Re: a question about Acme Roofing',
    text: 'Sounds interesting, can you send times?',
    inReplyTo: FIRST_ID,
    references: FIRST_ID,
    headers: {},
    ...over,
  }
}

function harness({
  messages = [msg()],
  rows = [biz()],
  threads = [{ message_id: FIRST_ID, business_id: 'b1' }],
  classify = async () => 'interested',
  dryRun = false,
  allowed = ALLOWED,
} = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]))
  const events = []
  const updates = []
  const suppressions = []
  const forwards = []
  const seen = []

  const deps = {
    sql: {},
    db: {
      logEvent: (_s, job, kind, detail) => {
        events.push({ job, kind, detail })
        return Promise.resolve([])
      },
      // Counts the same rows lib/db.mjs's query counts: poll error/dead_letter
      // events carrying this message key (the Message-ID, not the uid).
      messageFailureCount: (_s, key) =>
        Promise.resolve([
          {
            count: events.filter(
              (e) =>
                e.job === 'poll' &&
                (e.kind === 'error' || e.kind === 'dead_letter') &&
                String(e.detail?.message_key) === String(key)
            ).length,
          },
        ]),
      threadByMessageIds: (_s, ids) => {
        const hit = ids.map((id) => threads.find((t) => t.message_id === id)).find(Boolean)
        return Promise.resolve(hit ? [hit] : [])
      },
      businessById: (_s, id) => {
        const row = store.get(id)
        // The view hides suppressed rows; the fake must too or the tests lie.
        return Promise.resolve(row && !row.suppressed_at ? [row] : [])
      },
      updateBusiness: (_s, id, patch) => {
        updates.push({ id, patch })
        Object.assign(store.get(id) ?? {}, patch)
        return Promise.resolve([store.get(id)])
      },
      suppress: (_s, id, reason) => {
        const row = store.get(id)
        suppressions.push({ id, reason })
        if (row && !row.suppressed_at) row.suppressed_at = NOW
        return Promise.resolve(row ? [{ id, suppressed_at: row.suppressed_at, reason }] : [])
      },
    },
    imap: async () => ({
      messages: async () => messages,
      markSeen: async (uid) => seen.push(uid),
      close: async () => {},
    }),
    claude: classify === null ? null : { ask: classify },
    notify: async (m) => forwards.push(m),
    internalRecipients: allowed,
    dryRun,
    now: NOW,
  }

  return { deps, store, events, updates, suppressions, forwards, seen }
}

const kinds = (events) => events.map((e) => e.kind)

// --- constants are pinned to literals, so mutating one fails here first -----

test('the constants this suite asserts against are what they claim to be', () => {
  assert.equal(NO_ANSWER_DAYS, 2)
  assert.deepEqual(ADVANCED_STAGES, ['meeting', 'quoted', 'won', 'lost'])
})

// --- quoted regions --------------------------------------------------------

test('stripQuoted removes gmail, outlook and > quoted regions', () => {
  assert.equal(stripQuoted('Thanks!\n\nOn Mon, Sep 1, 2026 at 2:00 PM Nate\n<n@x.com> wrote:\n> Reply "stop" and I won\'t write again.'), 'Thanks!')
  assert.equal(stripQuoted('ok\n\n-----Original Message-----\nReply "stop" now'), 'ok')
  assert.equal(stripQuoted('ok\n\nFrom: Nate <n@x.com>\nSent: Monday\nunsubscribe me'), 'ok')
  assert.equal(stripQuoted('ok\n> unsubscribe\n> take me off your list'), 'ok')
})

test('an opt-out only inside a quoted region is not the sender speaking', () => {
  const quoted = 'Sure, Tuesday works.\n\nOn Mon, Sep 1, 2026 at 2:00 PM Nate <n@x.com> wrote:\n> Reply "stop" and I won\'t write again.'
  assert.equal(isOptOut(quoted), false)
})

// --- opt-out recall --------------------------------------------------------

const OPT_OUTS = [
  'please take me off your list',
  'remove me',
  'Remove me from your mailing list.',
  'unsubscribe',
  "not interested, don't contact me again",
  'how do I get off this',
  'STOP',
  'stop',
  'Thanks for reaching out, the site looks great — but please stop emailing me.',
  'Hi Nate, appreciate the note. We are all set. Do not contact us again.',
  'no more emails please',
  'take us off your list',
  'opt out',
  'Please delete my email address from your records.',
  'leave me alone',
]

for (const body of OPT_OUTS) {
  test(`isOptOut catches ${JSON.stringify(body.slice(0, 40))}`, () => {
    assert.equal(isOptOut(body), true)
  })
}

const NOT_OPT_OUTS = [
  'Sounds interesting, can you send times?',
  'We just stopped by your site, looks good. Call me Tuesday.',
  'I am interested but busy until October.',
  'Can you stop by the shop on Thursday?',
]

for (const body of NOT_OPT_OUTS) {
  test(`isOptOut leaves ${JSON.stringify(body.slice(0, 40))} alone`, () => {
    assert.equal(isOptOut(body), false)
  })
}

// --- the ordering guarantee, proven by a throwing classifier ---------------

test('an opt-out is suppressed even when the classifier throws', async () => {
  const h = harness({
    messages: [msg({ text: 'Thanks but please take me off your list.' })],
    classify: async () => {
      throw new Error('claude is down')
    },
  })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }])
  assert.equal(result.suppressed, 1)
  assert.equal(h.store.get('b1').stage, 'sent') // no stage move, only suppression
  assert.deepEqual(h.updates, [])
  assert.ok(kinds(h.events).includes('suppressed'))
})

test('a caps-only STOP suppresses and never reaches the classifier', async () => {
  let asked = 0
  const h = harness({
    messages: [msg({ text: 'STOP' })],
    classify: async () => {
      asked++
      return 'interested'
    },
  })

  await poll(h.deps)

  assert.equal(asked, 0)
  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
})

test('the classifier calling it an opt-out also suppresses', async () => {
  const h = harness({
    messages: [msg({ text: 'we are all set here, cheers' })],
    classify: async () => 'opt_out',
  })

  await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
  assert.deepEqual(h.updates, [])
})

// --- stage moves -----------------------------------------------------------

test('an interested reply sets stage=replied and stops the sequence', async () => {
  const h = harness()

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'replied')
  assert.equal(h.store.get('b1').next_touch_at, null)
  assert.equal(h.store.get('b1').suppressed_at, null)
  assert.equal(result.replied, 1)
  assert.deepEqual(h.seen, [7])
})

test('an out-of-office reply changes no stage', async () => {
  const h = harness({
    messages: [msg({ subject: 'Automatic reply: a question about Acme Roofing', text: 'I am out of the office until 15 September with limited access to email.' })],
  })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'sent')
  assert.deepEqual(h.updates, [])
  assert.deepEqual(h.suppressions, [])
  assert.equal(result.replied, 0)
  assert.equal(result.auto, 1)
})

test('an Auto-Submitted header alone marks a message auto', () => {
  assert.equal(isAutoReply({ text: 'back soon', headers: { 'auto-submitted': 'auto-replied' } }), true)
  assert.equal(isAutoReply({ text: 'back soon', headers: { 'auto-submitted': 'no' } }), false)
})

test('a reply quoting our own stop footer replies, it does not suppress', async () => {
  const h = harness({
    messages: [
      msg({
        text: 'Sure, Tuesday at 10 works.\n\nOn Mon, Sep 1, 2026 at 2:00 PM Nate <n@x.com> wrote:\n> Reply "stop" and I won\'t write again.\n',
      }),
    ],
  })

  await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at, null)
  assert.deepEqual(h.suppressions, [])
  assert.equal(h.store.get('b1').stage, 'replied')
})

test('a reply to a business already at won is not walked back', async () => {
  const h = harness({ rows: [biz({ stage: 'won' })] })

  await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'won')
  assert.deepEqual(h.updates, [])
})

// --- thread mapping --------------------------------------------------------

test('threadIds prefers In-Reply-To, then References newest first', () => {
  assert.deepEqual(threadIds({ inReplyTo: '<c@x>', references: '<a@x> <b@x>' }), ['<c@x>', '<b@x>', '<a@x>'])
  assert.deepEqual(threadIds({ references: '<a@x> <b@x>' }), ['<b@x>', '<a@x>'])
  assert.deepEqual(threadIds({}), [])
})

test('a reply with no In-Reply-To still maps through References', async () => {
  const h = harness({ messages: [msg({ inReplyTo: '', references: `<other@x> ${FIRST_ID}` })] })

  await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'replied')
})

test('a prospect reply matching no thread is forwarded, never guessed at', async () => {
  const h = harness({ messages: [msg({ inReplyTo: '<unknown@x>', references: '' })] })

  const result = await poll(h.deps)

  assert.equal(result.forwarded, 1)
  assert.deepEqual(h.updates, [])
  assert.deepEqual(h.suppressions, [])
  assert.equal(h.forwards.length, 2) // one per allow-listed human
  assert.deepEqual(h.forwards.map((f) => f.to), ALLOWED)
})

// --- teammate commands -----------------------------------------------------

test('parseCommand reads only the first line', () => {
  assert.deepEqual(parseCommand('yes\nlooks good'), { command: 'yes' })
  assert.deepEqual(parseCommand('no'), { command: 'no' })
  assert.deepEqual(parseCommand('no answer, tried twice'), { command: 'no answer' })
  assert.deepEqual(parseCommand('stop'), { command: 'stop' })
  assert.deepEqual(parseCommand('won 2400'), { command: 'won', amount: 2400 })
  assert.deepEqual(parseCommand('won $2,400.50'), { command: 'won', amount: 2400.5 })
  assert.equal(parseCommand('sounds good to me'), null)
  assert.equal(parseCommand('> won 2400'), null)
})

const teammate = (over = {}) =>
  msg({ deliveredTo: BOT, from: 'bchung@bcn-services.com', subject: 'Re: call task', text: 'won 2400', ...over })

test('won 2400 from an allow-listed sender sets stage=won', async () => {
  const h = harness({ messages: [teammate()], rows: [biz({ stage: 'call_due' })] })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'won')
  assert.equal(JSON.parse(h.store.get('b1').research).won_amount, 2400)
  assert.equal(result.commands, 1)
  assert.equal(result.forwarded, 0)
})

// SEND_ALLOWED_RECIPIENTS and NOTIFY_ALLOWED_RECIPIENTS are two lists, and the
// prospect list buys a sender nothing. Literal addresses on purpose.
test('a prospect on the send list issues no commands and receives no forward', async () => {
  const h = harness({
    messages: [teammate({ from: 'dana@acmeroofing.example' })],
    rows: [biz({ stage: 'call_due' })],
    allowed: ['nseluga@bcn-services.com'],
  })
  // Exactly what going live looks like: the prospect IS on the send list.
  h.deps.allowedRecipients = ['dana@acmeroofing.example']

  const result = await poll(h.deps)

  // `won 2400` is not honoured …
  assert.equal(h.store.get('b1').stage, 'call_due')
  assert.deepEqual(h.updates, [])
  assert.equal(result.commands, 0)
  // … it is forwarded instead, and only to the internal human.
  assert.equal(result.forwarded, 1)
  assert.deepEqual(h.forwards.map((m) => m.to), ['nseluga@bcn-services.com'])
})

test('an empty internal list forwards to nobody however full the send list is', async () => {
  const h = harness({
    messages: [teammate({ from: 'dana@acmeroofing.example' })],
    rows: [biz({ stage: 'call_due' })],
    allowed: [],
  })
  h.deps.allowedRecipients = ['dana@acmeroofing.example', 'nseluga@bcn-services.com']

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'call_due')
  assert.deepEqual(h.forwards, [])
  assert.equal(result.forwarded, 0)
  assert.equal(result.errors, 1, 'an unforwardable message must be an error, not a silent drop')
})

test('the same line from an unknown sender changes nothing', async () => {
  const h = harness({
    messages: [teammate({ from: 'stranger@example.com' })],
    rows: [biz({ stage: 'call_due' })],
  })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'call_due')
  assert.deepEqual(h.updates, [])
  assert.deepEqual(h.suppressions, [])
  assert.equal(result.commands, 0)
  assert.equal(result.forwarded, 1)
})

test('an empty allow-list honours nobody', async () => {
  const h = harness({ messages: [teammate()], rows: [biz({ stage: 'call_due' })], allowed: [] })

  await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'call_due')
  assert.deepEqual(h.updates, [])
})

test('isAllowedSender is case and whitespace insensitive but never open', () => {
  assert.equal(isAllowedSender(' BChung@BCN-Services.com ', ALLOWED), true)
  assert.equal(isAllowedSender('stranger@example.com', ALLOWED), false)
  assert.equal(isAllowedSender('bchung@bcn-services.com', []), false)
  assert.equal(isAllowedSender('', ALLOWED), false)
})

test('yes approves, no loses, no answer reschedules the call', async () => {
  for (const [text, stage] of [['yes', 'approved'], ['no', 'lost'], ['no answer', 'call_due']]) {
    const h = harness({ messages: [teammate({ text })], rows: [biz({ stage: 'drafted' })] })
    await poll(h.deps)
    assert.equal(h.store.get('b1').stage, stage, text)
    if (text === 'no answer') {
      assert.equal(
        h.store.get('b1').next_touch_at.toISOString(),
        new Date('2026-09-04T09:00:00Z').toISOString()
      )
    }
  }
})

test('a teammate stop suppresses the business', async () => {
  const h = harness({ messages: [teammate({ text: 'stop' })] })

  await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'teammate stop' }])
})

test('notes append without moving the stage', async () => {
  const h = harness({ messages: [teammate({ text: 'notes owner wants a quote in October' })], rows: [biz({ stage: 'quoted' })] })

  await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'quoted')
  assert.deepEqual(JSON.parse(h.store.get('b1').research).notes, ['owner wants a quote in October'])
})

test('an unparseable message on bot@ is forwarded, not guessed at', async () => {
  const h = harness({ messages: [teammate({ text: 'maybe? I will call him back' })] })

  const result = await poll(h.deps)

  assert.equal(result.forwarded, 1)
  assert.deepEqual(h.updates, [])
})

// --- plumbing --------------------------------------------------------------

test('no imap dep writes a skipped event and nothing else', async () => {
  const h = harness()
  h.deps.imap = null

  const result = await poll(h.deps)

  assert.deepEqual(kinds(h.events), ['skipped'])
  assert.equal(result.read, 0)
})

test('an empty mailbox writes a skipped event', async () => {
  const h = harness({ messages: [] })

  await poll(h.deps)

  assert.deepEqual(kinds(h.events), ['skipped'])
})

test('a dry run writes nothing and leaves the message unread', async () => {
  const h = harness({ messages: [msg({ text: 'please unsubscribe me' })], dryRun: true })

  await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at, null)
  assert.deepEqual(h.suppressions, [])
  assert.deepEqual(h.seen, [])
  assert.ok(kinds(h.events).includes('would_suppress'))
})

test('one bad message does not stop the rest of the batch', async () => {
  const h = harness({
    messages: [
      Object.defineProperty(msg({ uid: 1 }), 'text', {
        get() {
          throw new Error('unparseable')
        },
      }),
      msg({ uid: 2, text: 'unsubscribe' }),
    ],
  })

  const result = await poll(h.deps)

  assert.equal(result.errors, 1)
  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
})

test('an unrecognised Delivered-To is forwarded', async () => {
  const h = harness({ messages: [msg({ deliveredTo: 'someoneelse@bcn-services.com' })] })

  const result = await poll(h.deps)

  assert.equal(result.forwarded, 1)
  assert.deepEqual(h.updates, [])
})

test('readCategory only ever returns a known category', () => {
  assert.equal(readCategory('opt_out'), 'opt_out')
  assert.equal(readCategory('{"category":"out_of_office"}'), 'out_of_office')
  assert.equal(readCategory('who knows'), 'other')
  assert.equal(readCategory(null), 'other')
})

// --- db queries ------------------------------------------------------------

test('businessById reads the view, and threadByMessageIds keeps caller order', async () => {
  let text = ''
  const sql = (strings, ...v) => {
    text = strings.join(' ? ')
    return Promise.resolve([{ v }])
  }
  await businessById(sql, 'b1')
  assert.match(text, /selectable_businesses/)
  assert.throws(() => assertSelectable('select * from businesses where id = ?'))

  await threadByMessageIds(sql, ['<a@x>', '<b@x>'])
  assert.match(text, /array_position/)
  assert.match(text, /email_threads/)
  assert.deepEqual(await threadByMessageIds(sql, []), [])

  // GATING — keyed on the message key, never the uid: a uid is unique only per
  // mailbox per uidvalidity, and `events` keeps every row forever.
  const [{ v }] = await messageFailureCount(sql, '<reply-7@acmeroofing.example>')
  assert.match(text, /detail->>'message_key' =\s+\?/)
  assert.doesNotMatch(text, /detail->>'uid'/)
  assert.deepEqual(v, ['<reply-7@acmeroofing.example>'])
})

// ===========================================================================
// QA additions — adversarial opt-out recall and command-spoofing probes.
// Written independently of the engineer's suite. Every side-effect and
// no-side-effect assertion below drives run(), not an internal helper.
// ===========================================================================

const QA_OPT_OUTS = [
  'Please stop sending me these emails',
  'Do not email me',
  'quit emailing me',
  'I do not wish to receive these',
  'Kindly remove my address',
  'How can I unsubscribe?',
  "I'd like to opt-out.",
  'Take my name off.',
  'Remove us from your database.',
  'Take us off your mailing list',
  'please don\'t contact me anymore',
  'no further emails',
  'Hi Nate,\nThanks for the note and the mockup.\nPlease unsubscribe me from any further mailings.\nBest, Dana',
]

for (const body of QA_OPT_OUTS) {
  test(`qa: isOptOut catches ${JSON.stringify(body.slice(0, 40))}`, () => {
    assert.equal(isOptOut(body), true)
  })
}

test('qa: an opt-out buried under a friendly opening still suppresses through run()', async () => {
  const h = harness({
    messages: [
      msg({
        text: 'Hi Nate — thanks so much, the mockup looks sharp and the team liked it.\nThat said, please remove me from your list going forward.\nGood luck out there.',
      }),
    ],
    classify: async () => 'interested', // the classifier disagreeing must not matter
  })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }])
  assert.equal(h.store.get('b1').stage, 'sent')
  assert.deepEqual(h.updates, [])
  assert.equal(result.replied, 0)
})

test('qa: an opt-out above a quoted region survives stripQuoted', async () => {
  const h = harness({
    messages: [
      msg({
        text: 'Please take us off your list.\n\nOn Mon, Sep 1, 2026 at 2:00 PM Nate <n@x.com> wrote:\n> Quick question about Acme Roofing.',
      }),
    ],
  })

  await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
})

test('qa: a bare "> stop" quote line at the foot of a friendly reply does not suppress', async () => {
  const h = harness({
    messages: [
      msg({
        text: 'Tuesday at 10 is good, see you then.\n> Reply "stop" and I will not write again.\n> unsubscribe\n',
      }),
    ],
  })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at, null)
  assert.deepEqual(h.suppressions, [])
  assert.equal(h.store.get('b1').stage, 'replied')
  assert.equal(result.suppressed, 0)
})

test('qa: the classifier is the backstop when the regex misses the phrasing', async () => {
  // "kindly refrain from further correspondence" is NOT in OPT_OUT_PATTERNS
  // today; the second pass must still suppress it. If this ever goes red the
  // phrasing has no line of defence left at all.
  assert.equal(isOptOut('Kindly refrain from further correspondence'), false)

  const h = harness({
    messages: [msg({ text: 'Kindly refrain from further correspondence.' })],
    classify: async () => 'opt_out',
  })

  await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'classified opt-out' }])
  assert.deepEqual(h.updates, [])
})

test('qa: suppression is committed before the classifier is even reached', async () => {
  const order = []
  const h = harness({
    messages: [msg({ text: 'unsubscribe' })],
    classify: async () => {
      order.push('classify')
      return 'interested'
    },
  })
  const inner = h.deps.db.suppress
  h.deps.db.suppress = (...a) => {
    order.push('suppress')
    return inner(...a)
  }

  await poll(h.deps)

  assert.deepEqual(order, ['suppress'])
})

test('qa: a lookalike sender domain honours no command', async () => {
  for (const from of [
    'bchung@bcn-services.com.evil.example',
    'bchung@bcn-services.co',
    'Brandon Chung <bchung@bcn-services.com>',
    'bchung@bcn-services.com, stranger@example.com',
  ]) {
    const h = harness({ messages: [teammate({ from })], rows: [biz({ stage: 'call_due' })] })

    const result = await poll(h.deps)

    assert.equal(h.store.get('b1').stage, 'call_due', from)
    assert.deepEqual(h.updates, [], from)
    assert.deepEqual(h.suppressions, [], from)
    assert.equal(result.commands, 0, from)
    assert.equal(result.forwarded, 1, from)
  }
})

test('qa: a spoofed "stop" on bot@ from a stranger suppresses nothing', async () => {
  const h = harness({ messages: [teammate({ from: 'stranger@example.com', text: 'stop' })] })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at, null)
  assert.deepEqual(h.suppressions, [])
  assert.equal(result.suppressed, 0)
  assert.equal(result.forwarded, 1)
})

test('qa: won 2400 from an allow-listed sender with no matching thread changes nothing', async () => {
  const h = harness({
    messages: [teammate({ inReplyTo: '<unknown@x>', references: '' })],
    rows: [biz({ stage: 'call_due' })],
  })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'call_due')
  assert.deepEqual(h.updates, [])
  assert.equal(result.commands, 0)
  assert.equal(result.forwarded, 1)
})

test('qa: a command on a suppressed business is not applied', async () => {
  const h = harness({
    messages: [teammate()],
    rows: [biz({ stage: 'call_due', suppressed_at: NOW })],
  })

  await poll(h.deps)

  assert.deepEqual(h.updates, [])
  assert.equal(h.store.get('b1').stage, 'call_due')
})

test('qa: Delivered-To routing is case insensitive', async () => {
  const h = harness({ messages: [msg({ deliveredTo: 'OUTREACH@Send.BCN-Services.com', text: 'unsubscribe' })] })

  await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
})

test('qa: a prospect opt-out with no thread is forwarded and suppresses nothing it cannot identify', async () => {
  const h = harness({ messages: [msg({ inReplyTo: '<unknown@x>', references: '', text: 'unsubscribe' })] })

  const result = await poll(h.deps)

  assert.deepEqual(h.suppressions, [])
  assert.deepEqual(h.updates, [])
  assert.equal(result.forwarded, 1)
})

// --- review fixes ----------------------------------------------------------
// Every test below pins a fix from review-report.md and fails if it regresses.

// CRITICAL — an html-only multipart/related reply (an Outlook or Gmail reply
// carrying an inline image) arrives from mailparser with NO `text` field. The
// fixtures above all supply one, which is exactly how this hid.
const htmlOnly = (html, over = {}) =>
  toMessage(
    {
      from: { value: [{ address: 'dana@acmeroofing.example' }] },
      subject: 'Re: a question about Acme Roofing',
      html,
      inReplyTo: FIRST_ID,
      references: [],
      headers: new Map([['delivered-to', OUTREACH]]),
      ...over,
    },
    7
  )

test('review: an html-only reply with no text part still suppresses on an opt-out', async () => {
  const message = htmlOnly('<div>Hi Nate,</div><div>Please remove from your list.</div><img src="cid:sig">')
  assert.equal(message.text.includes('Please remove from your list'), true)

  const h = harness({ messages: [message] })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }])
  assert.equal(result.suppressed, 1)
  assert.deepEqual(h.updates, [])
})

test('review: an html-only reply whose body reads empty is forwarded, never classified', async () => {
  const h = harness({
    messages: [htmlOnly('<img src="cid:signature">')],
    classify: async () => {
      throw new Error('the classifier must not be reached for an unreadable body')
    },
  })

  const result = await poll(h.deps)

  assert.equal(result.forwarded, 1)
  assert.deepEqual(h.updates, [])
  assert.deepEqual(h.suppressions, [])
  assert.equal(h.store.get('b1').stage, 'sent')
  assert.equal(
    h.events.some((e) => e.kind === 'forwarded' && /body is empty/.test(e.detail.reason)),
    true
  )
})

test('review: a subject-only UNSUBSCRIBE suppresses', async () => {
  assert.equal(isOptOutMessage({ subject: 'UNSUBSCRIBE', text: 'Sent from my iPhone' }), true)
  assert.equal(isOptOutMessage({ subject: 'Re: a question', text: 'sure, call me' }), false)

  const h = harness({ messages: [msg({ subject: 'Re: a question about Acme Roofing - UNSUBSCRIBE', text: 'Sent from my iPhone' })] })

  const result = await poll(h.deps)

  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }])
  assert.equal(result.suppressed, 1)
})

test('review: the five measured recall gaps now match on the keyword pass', async () => {
  const phrasings = [
    "we don't want any more emails",
    'Please remove this email address from your distribution',
    'Please remove from your list',
    'Please cease all communication',
    'Please do not send us anything further',
  ]
  for (const p of phrasings) assert.equal(isOptOut(p), true, p)

  // ...and a benign reply is still not an opt-out, so recall did not eat precision.
  assert.equal(isOptOut('Sounds interesting, can you send times? Please send more info.'), false)
  assert.equal(OPT_OUT_PATTERNS.length, 21)

  for (const text of phrasings) {
    const h = harness({ messages: [msg({ text })], classify: async () => 'interested' })

    await poll(h.deps)

    assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }], text)
    assert.deepEqual(h.updates, [], text)
  }
})

test('review: with no classifier the job says so and forwards the reply for a human', async () => {
  const h = harness({ messages: [msg()], classify: null })

  const result = await poll(h.deps)

  assert.equal(
    h.events.some((e) => e.kind === 'degraded' && /no classifier/.test(e.detail.reason)),
    true
  )
  assert.equal(result.forwarded, 1)
  assert.equal(h.forwards.length, 2)
})

test('review: an empty allow-list logs an error, not a forward nobody receives', async () => {
  const h = harness({
    messages: [msg({ inReplyTo: '<unknown@x>', references: '', text: 'unsubscribe' })],
    allowed: [],
  })

  const result = await poll(h.deps)

  assert.equal(result.forwarded, 0)
  assert.equal(result.errors, 1)
  assert.equal(h.forwards.length, 0)
  assert.equal(
    h.events.some((e) => e.kind === 'error' && e.detail.reason === 'no allow-listed recipient'),
    true
  )
  assert.equal(h.events.some((e) => e.kind === 'forwarded'), false)
})

test('review: a handler that throws leaves the message unseen, and the retry does not double-apply', async () => {
  const h = harness({ messages: [teammate({ text: 'notes: called, left a voicemail' })] })
  const logEvent = h.deps.db.logEvent
  let boom = true
  h.deps.db.logEvent = (sql, job, kind, detail) => {
    if (boom && kind === 'command') {
      boom = false
      throw new Error('the event write failed after the patch landed')
    }
    return logEvent(sql, job, kind, detail)
  }

  const first = await poll(h.deps)

  assert.equal(first.errors, 1)
  assert.deepEqual(h.seen, [], 'an unhandled message must stay unread for the next tick')
  assert.deepEqual(JSON.parse(h.store.get('b1').research).notes, ['called, left a voicemail'])

  // The next tick sees the same message again.
  await poll(h.deps)

  assert.deepEqual(h.seen, [7])
  assert.deepEqual(JSON.parse(h.store.get('b1').research).notes, ['called, left a voicemail'])
})

test('review: a bare local-part Delivered-To takes no privileged path', async () => {
  const h = harness({
    messages: [msg({ deliveredTo: 'bot@anything.example', from: 'bchung@bcn-services.com', text: 'won 2400' })],
    rows: [biz({ stage: 'call_due' })],
  })

  const result = await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'call_due')
  assert.deepEqual(h.updates, [])
  assert.equal(result.commands, 0)
  assert.equal(result.forwarded, 1)
})

test('review: a forward nobody accepted is not counted as delivered', async () => {
  const h = harness({ messages: [msg({ inReplyTo: '<unknown@x>', references: '' })] })
  h.deps.notify = async () => {
    throw new Error('smtp is down')
  }

  const result = await poll(h.deps)

  assert.equal(result.forwarded, 0)
  assert.equal(result.errors, 2) // one per allow-listed human
})

test('review: the same note re-processed twice is stored once', async () => {
  const note = teammate({ text: 'notes: called, left a voicemail' })
  const h = harness({ messages: [note, { ...note, uid: 8 }] })

  await poll(h.deps)

  assert.deepEqual(JSON.parse(h.store.get('b1').research).notes, ['called, left a voicemail'])
})

// --- entity + apostrophe normalisation -------------------------------------
// "we don't want any more emails" with anything but a plain ASCII apostrophe
// was a measured false negative: a missed opt-out is this item's whole risk.

const APOSTROPHE_VARIANTS = [
  ['hex entity', 'we don&#x27;t want any more emails'],
  ['named rsquo entity', 'we don&rsquo;t want any more emails'],
  ['raw curly U+2019', 'we don’t want any more emails'],
]

test('review: a curly or entity-encoded apostrophe is still an opt-out, on both paths', async () => {
  for (const [label, html] of APOSTROPHE_VARIANTS) {
    // the html-only path
    const h = harness({ messages: [htmlOnly(`<div>${html}</div>`)], classify: async () => 'interested' })

    await poll(h.deps)

    assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }], `html: ${label}`)
    assert.deepEqual(h.updates, [], `html: ${label}`)

    // the plain-text path, with the entity already decoded by the sender
    const text = html.replace('&#x27;', "’").replace('&rsquo;', '’')
    assert.equal(isOptOut(text), true, `text: ${label}`)

    const p = harness({ messages: [msg({ text })], classify: async () => 'interested' })

    await poll(p.deps)

    assert.deepEqual(p.suppressions, [{ id: 'b1', reason: 'reply opt-out' }], `text: ${label}`)
    assert.deepEqual(p.updates, [], `text: ${label}`)
  }

  // U+02BC, the other apostrophe mail clients emit.
  assert.equal(isOptOut('we donʼt want any more emails'), true)
  // Normalising did not widen the list, and a benign reply is still not an opt-out.
  assert.equal(OPT_OUT_PATTERNS.length, 21)
  assert.equal(isOptOut("we don’t have time this week, try me in the spring"), false)
})

// --- third review pass -----------------------------------------------------

const parsedReply = (html) => ({
  from: { value: [{ address: 'dana@acmeroofing.example' }] },
  subject: 'Re: a question about Acme Roofing',
  html,
  inReplyTo: FIRST_ID,
  references: [],
  headers: new Map([['delivered-to', OUTREACH]]),
})

// CRITICAL — String.fromCodePoint throws a RangeError above U+10FFFF. The throw
// escaped the drain (a try/finally with no catch), so ONE entity from a stranger
// stalled every tick forever and nothing was ever marked seen.
test('review: an out-of-range numeric entity cannot stall the tick', async () => {
  assert.equal(htmlToText('<p>hi &#x110000; there</p>'), 'hi &#x110000; there')
  assert.equal(htmlToText('<p>a &#99999999999; b</p>'), 'a &#99999999999; b')
  assert.equal(htmlToText('<p>&#xD800;</p>'), '&#xD800;') // a lone surrogate is not output either
  assert.equal(htmlToText('<p>don&#x27;t</p>'), "don't") // in-range still decodes

  const h = harness({ messages: [] })
  h.deps.imap = async () => ({
    // The drain parses inside the mailbox client: this is where the throw was.
    messages: async () => [
      toMessage(parsedReply('<div>Thanks &#x110000; I will consider it</div>'), 11),
      toMessage(parsedReply('<div>please remove me from your list</div>'), 12),
    ],
    markSeen: async (uid) => h.seen.push(uid),
    close: async () => {},
  })

  const result = await poll(h.deps)

  assert.equal(result.read, 2, 'the bad entity must not stall the tick')
  assert.deepEqual(h.seen, [11, 12], 'every message in the tick is still marked seen')
  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }])
})

// IMPORTANT — the pair strip tolerated an unbalanced opener and ran on to the
// NEXT one, DELETING the body in between. A silently missed opt-out.
test('review: an unbalanced <style> or comment cannot delete the opt-out', async () => {
  const stylish = '<style>a{}<div>please remove me from your list</div><style>b{}</style><p>ok</p>'
  const commented = '<!--x<div>please remove me from your list</div><!-- y --><p>ok</p>'
  for (const html of [stylish, commented]) {
    assert.equal(htmlToText(html).includes('remove me from your list'), true, html)

    const h = harness({ messages: [], classify: async () => 'interested' })
    h.deps.imap = async () => ({
      messages: async () => [toMessage(parsedReply(html), 13)],
      markSeen: async (uid) => h.seen.push(uid),
      close: async () => {},
    })

    await poll(h.deps)

    assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }], html)
    assert.deepEqual(h.updates, [], html)
  }
  // Balanced pairs are still stripped whole.
  assert.equal(htmlToText('<style>a{color:red}</style><p>hello</p>'), 'hello')
  assert.equal(htmlToText('<!-- hidden --><p>hello</p>'), 'hello')
})

// IMPORTANT — folding the subject into the match made the bare-"stop" line
// reachable from ordinary subjects. Suppression is permanent and has no undo.
test('review: an ordinary "Stop by..." subject does not suppress, a bare STOP still does', async () => {
  assert.equal(OPT_OUT_PATTERNS.length, 21)
  assert.equal(isOptOutMessage({ subject: 'Stop by the office Thursday!' }), false)
  assert.equal(isOptOutMessage({ subject: 'Can you stop in on Friday?' }), false)
  assert.equal(isOptOutMessage({ subject: 'stop over any time' }), false)
  assert.equal(isOptOutMessage({ subject: 'STOP' }), true)
  assert.equal(isOptOutMessage({ subject: 'UNSUBSCRIBE' }), true)
  assert.equal(isOptOutMessage({ subject: 'please stop' }), true)
  assert.equal(isOptOut('stop\n'), true)

  const benign = harness({ messages: [msg({ subject: 'Stop by the office Thursday!' })] })
  await poll(benign.deps)
  assert.deepEqual(benign.suppressions, [])
  assert.equal(benign.store.get('b1').stage, 'replied')

  for (const subject of ['STOP', 'UNSUBSCRIBE']) {
    const h = harness({ messages: [msg({ subject, text: '' })] })
    await poll(h.deps)
    assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }], subject)
  }
})

// IMPORTANT — with markSeen last, a deterministically failing message was
// retried every tick forever, re-forwarding to every human each time.
test('review: a message that always throws is dead-lettered instead of retried forever', async () => {
  assert.equal(MAX_ATTEMPTS, 3)

  const h = harness({ classify: null })
  const logEvent = h.deps.db.logEvent
  h.deps.db.logEvent = (sql, job, kind, detail) => {
    if (kind === 'replied') throw new Error('deterministic failure on every tick')
    return logEvent(sql, job, kind, detail)
  }
  h.deps.imap = async () => ({
    messages: async () => (h.seen.includes(7) ? [] : [msg()]),
    markSeen: async (uid) => h.seen.push(uid),
    close: async () => {},
  })

  for (let tick = 0; tick < 5; tick++) await poll(h.deps)

  assert.deepEqual(h.seen, [7], 'dead-lettered once, then never fetched again')
  // 2 humans x 3 attempts, plus the 2 dead-letter forwards, then it stops.
  assert.equal(h.forwards.length, 8)
  const dead = h.events.filter((e) => e.kind === 'dead_letter')
  assert.equal(dead.length, 1)
  assert.deepEqual(dead[0].detail, {
    uid: 7,
    message_key: '<reply-7@acmeroofing.example>',
    attempts: 3,
    forwarded: true,
  })
  assert.equal(h.events.filter((e) => e.kind === 'error' && e.detail.uid === 7).length, 3)
})

// GATING — the dead letter is forwarded to the humans BEFORE the message is
// marked seen. A visible drop is acceptable; an invisible one is not.
test('qa: a dead letter reaches the allow-listed humans before markSeen', async () => {
  const h = harness({ classify: null })
  const order = []
  const logEvent = h.deps.db.logEvent
  h.deps.db.logEvent = (sql, job, kind, detail) => {
    if (kind === 'replied') throw new Error('deterministic failure on every tick')
    if (kind === 'dead_letter') order.push('dead_letter')
    return logEvent(sql, job, kind, detail)
  }
  const notify = h.deps.notify
  h.deps.notify = async (m) => {
    order.push(`forward:${m.to}`)
    return notify(m)
  }
  h.deps.imap = async () => ({
    messages: async () => (h.seen.includes(7) ? [] : [msg()]),
    markSeen: async (uid) => {
      order.push('markSeen')
      h.seen.push(uid)
    },
    close: async () => {},
  })

  for (let tick = 0; tick < 4; tick++) await poll(h.deps)

  assert.deepEqual(order.slice(-4), [
    'forward:nseluga@bcn-services.com',
    'forward:bchung@bcn-services.com',
    'dead_letter',
    'markSeen',
  ])
  const last = h.forwards.at(-1)
  assert.equal(last.to, 'bchung@bcn-services.com')
  assert.match(last.text, /handling failed 3 times — dead-lettered, read this one by hand/)
})

// GATING — the counter was keyed on the uid alone, so a NEW message re-using a
// dead-lettered uid (uidvalidity reset, or a second mailbox) was dead-lettered
// on its FIRST transient failure: marked seen, never re-fetched, its opt-out
// lost silently. Keyed on the Message-ID it cannot happen.
test('qa: a new message re-using a dead-lettered uid is still processed, opt-out and all', async () => {
  const h = harness({ classify: null })
  const events = h.events
  const logEvent = h.deps.db.logEvent
  let poison = true
  h.deps.db.logEvent = (sql, job, kind, detail) => {
    if (poison && kind === 'replied') throw new Error('deterministic failure on every tick')
    return logEvent(sql, job, kind, detail)
  }
  h.deps.imap = async () => ({
    messages: async () => (h.seen.includes(7) ? [] : [msg()]),
    markSeen: async (uid) => h.seen.push(uid),
    close: async () => {},
  })
  for (let tick = 0; tick < 4; tick++) await poll(h.deps)
  assert.deepEqual(h.seen, [7], 'the first message is dead-lettered')

  // Same uid, different message: a uidvalidity reset or a second mailbox.
  poison = false
  h.deps.db.logEvent = logEvent
  const fresh = msg({ uid: 7, messageId: '<fresh-7@other.example>', text: 'unsubscribe' })
  const suppress = h.deps.db.suppress
  let transient = 1
  h.deps.db.suppress = (sql, id, reason) => {
    if (transient-- > 0) throw new Error('transient blip')
    return suppress(sql, id, reason)
  }
  h.deps.imap = async () => ({
    messages: async () => (h.store.get('b1').suppressed_at ? [] : [fresh]),
    markSeen: async (uid) => h.seen.push(uid),
    close: async () => {},
  })

  await poll(h.deps) // one transient failure — must NOT dead-letter
  assert.equal(h.store.get('b1').suppressed_at, null)
  assert.equal(events.filter((e) => e.kind === 'dead_letter').length, 1, 'no second dead letter')
  assert.deepEqual(h.seen, [7], 'still unseen, so the next tick re-fetches it')

  await poll(h.deps) // retried, and the opt-out lands
  assert.equal(h.store.get('b1').suppressed_at instanceof Date, true)
  assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }])
})

// A transient fault is not a dead letter: two failures then success still
// processes the message normally.
test('qa: two transient failures then success processes the message normally', async () => {
  const h = harness()
  const updateBusiness = h.deps.db.updateBusiness
  let fails = 2
  h.deps.db.updateBusiness = (sql, id, patch) => {
    if (fails-- > 0) throw new Error('transient blip')
    return updateBusiness(sql, id, patch)
  }
  h.deps.imap = async () => ({
    messages: async () => (h.store.get('b1').stage === 'replied' ? [] : [msg()]),
    markSeen: async (uid) => h.seen.push(uid),
    close: async () => {},
  })

  for (let tick = 0; tick < 3; tick++) await poll(h.deps)

  assert.equal(h.store.get('b1').stage, 'replied')
  assert.deepEqual(h.seen, [7])
  assert.equal(h.events.filter((e) => e.kind === 'dead_letter').length, 0)
})

// IMPORTANT — the bare-"stop" pattern is anchored to a line that is ONLY
// "stop", because the open slot after it is a verb and no preposition list
// closes it. suppressed_at has no undo, so each of these was a killed lead.
const BENIGN_STOP_SUBJECTS = [
  'Stop light replacement quote',
  'Stop press: we are hiring',
  'Stop guessing, start measuring',
  'Stop worrying about SEO',
]

for (const subject of BENIGN_STOP_SUBJECTS) {
  test(`qa: ${JSON.stringify(subject)} reaches replied with no suppression`, async () => {
    assert.equal(isOptOutMessage({ subject }), false)
    const h = harness({ messages: [msg({ subject })] })
    await poll(h.deps)
    assert.equal(h.store.get('b1').suppressed_at, null)
    assert.deepEqual(h.suppressions, [])
    assert.equal(h.store.get('b1').stage, 'replied')
  })
}

test('qa: a bare STOP still suppresses, in the subject and in the body', async () => {
  assert.equal(OPT_OUT_PATTERNS.length, 21)
  // The last three regressed to false under a bare `^stop$` anchor and were
  // caught by no other pattern — QA measured it. They are real replies.
  for (const subject of [
    'STOP',
    'UNSUBSCRIBE',
    'stop.',
    '  STOP!  ',
    'Please stop',
    'stop stop stop',
    'STOP PLEASE',
    'stop now',
  ]) {
    const h = harness({ messages: [msg({ subject, text: '' })] })
    await poll(h.deps)
    assert.deepEqual(h.suppressions, [{ id: 'b1', reason: 'reply opt-out' }], subject)
  }
  const body = harness({ messages: [msg({ subject: 'Re: hello', text: 'STOP' })] })
  await poll(body.deps)
  assert.deepEqual(body.suppressions, [{ id: 'b1', reason: 'reply opt-out' }])
})
