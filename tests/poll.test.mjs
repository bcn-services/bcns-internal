import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  run as poll,
  stripQuoted,
  isOptOut,
  isAutoReply,
  parseCommand,
  threadIds,
  readCategory,
  isAllowedSender,
  ADVANCED_STAGES,
  NO_ANSWER_DAYS,
} from '../jobs/poll.mjs'
import { threadByMessageIds, businessById, assertSelectable } from '../lib/db.mjs'

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
    claude: { ask: classify },
    notify: async (m) => forwards.push(m),
    allowedRecipients: allowed,
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
  // "we don't want any more emails" is NOT in OPT_OUT_PATTERNS today; the
  // second pass must still suppress it. If this ever goes red the phrasing
  // has no line of defence left at all.
  assert.equal(isOptOut("we don't want any more emails"), false)

  const h = harness({
    messages: [msg({ text: "Thanks, but we don't want any more emails." })],
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
