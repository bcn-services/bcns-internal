import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trim, MAX_CHARS } from '../lib/trim.mjs'
import { run as qualify, PROMPT, parseAnswer } from '../jobs/qualify.mjs'

test('trim caps a 500KB page at 7000 characters', () => {
  const big = '<p>' + 'word '.repeat(120_000) + '</p>'
  assert.ok(big.length > 500_000)
  const out = trim(big)
  assert.ok(out.length <= MAX_CHARS, `got ${out.length}`)
})

test('trim removes script, style, nav and footer content', () => {
  const html = `
    <html><head><style>.a{color:red}SECRETSTYLE</style></head>
    <body><nav>SECRETNAV</nav>
    <p>Acme Roofing serves Milford.</p>
    <script>var x = 'SECRETSCRIPT';</script>
    <footer>SECRETFOOTER</footer></body></html>`
  const out = trim(html)
  for (const s of ['SECRETSTYLE', 'SECRETNAV', 'SECRETSCRIPT', 'SECRETFOOTER']) {
    assert.ok(!out.includes(s), `${s} survived the trim`)
  }
  assert.match(out, /Acme Roofing serves Milford\./)
})

test('trim leaks nothing from an unclosed script tag', () => {
  assert.ok(!trim('<p>hi</p><script>var x = "SECRET"').includes('SECRET'))
})

test('trim collapses whitespace and decodes common entities', () => {
  assert.equal(trim('<p>a  &amp;   b</p>\n\n\n<p>c</p>'), 'a & b\nc')
  assert.equal(trim(''), '')
})

test('trim does not fuse words across block tags', () => {
  assert.match(trim('<li>Roofing</li><li>Siding</li>'), /Roofing\nSiding/)
})

// --- jobs/qualify.mjs ------------------------------------------------------

const PAGE = (extra = '') => `<html><body><p>Acme Roofing, family run since 1998,
  serves Milford and Stratford CT. GAF certified.</p>${extra}</body></html>`

function harness({ rows, pages = {}, answer, fetchThrows = false, promotedToday = 0, promoteNoEmail } = {}) {
  const events = []
  const updates = []
  let asks = 0
  return {
    events, updates, get asks() { return asks },
    deps: {
      sql: {},
      db: {
        logEvent: (_s, job, kind, detail) => events.push({ job, kind, detail }),
        sourcedBacklog: async () => rows,
        updateBusiness: async (_s, id, patch) => { updates.push({ id, patch }); return [] },
        // The promotion step runs at the end of every qualify tick regardless
        // of the sourced backlog; default to "nothing to promote" so existing
        // tests aimed at the main loop don't have to know about it.
        promotedToday: async () => [{ count: promotedToday }],
        promoteNoEmail: promoteNoEmail ?? (async () => []),
      },
      fetchPage: async (url) => {
        if (fetchThrows) throw new Error('ECONNREFUSED')
        if (url in pages) return pages[url]
        const path = url.replace(/^https:\/\/[^/]+/, '')
        if (path === '') return pages.home ?? PAGE()
        throw new Error('404')
      },
      claude: { ask: async () => { asks++; return typeof answer === 'function' ? answer() : answer } },
    },
  }
}

const acme = { id: 'b1', name: 'Acme Roofing', domain: 'acme.example', phone: '555-0100', email: null }

test('a qualified row carries an email and at least three research facts', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: PAGE('<p>Reach us at hello@acme.example</p>') },
    answer: JSON.stringify({
      email: 'hello@acme.example',
      facts: ['Family run since 1998', 'Serves Milford and Stratford CT', 'GAF certified'],
      fit: 'good', reason: 'dated site',
    }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  const { patch } = h.updates[0]
  assert.equal(patch.stage, 'qualified')
  assert.equal(patch.email, 'hello@acme.example')
  assert.ok(JSON.parse(patch.research).facts.length >= 3)
})

test('owner_name from the model lands in research', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: PAGE('<p>Reach us at hello@acme.example</p>') },
    answer: JSON.stringify({
      email: 'hello@acme.example',
      owner_name: 'Dave',
      facts: ['Family run since 1998', 'Serves Milford and Stratford CT', 'GAF certified'],
      fit: 'good', reason: 'dated site',
    }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  const { patch } = h.updates[0]
  assert.equal(JSON.parse(patch.research).owner_name, 'Dave')
})

test('a missing owner_name lands in research as null, never a guess', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: PAGE('<p>Reach us at hello@acme.example</p>') },
    answer: JSON.stringify({
      email: 'hello@acme.example',
      facts: ['Family run since 1998', 'Serves Milford and Stratford CT', 'GAF certified'],
      fit: 'good', reason: 'dated site',
    }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  const { patch } = h.updates[0]
  assert.equal(JSON.parse(patch.research).owner_name, null)
})

test('exactly one Claude call per business', async () => {
  const h = harness({
    rows: [acme, { ...acme, id: 'b2' }],
    pages: { home: PAGE('<p>hello@acme.example</p>') },
    answer: JSON.stringify({ email: 'hello@acme.example', facts: ['a', 'b', 'c'], fit: 'good' }),
  })
  await qualify(h.deps)
  assert.equal(h.asks, 2)
})

test('no discoverable email lands at no_email with phone untouched and email still null', async () => {
  const h = harness({
    rows: [acme],
    answer: JSON.stringify({ email: null, facts: ['a', 'b', 'c'], fit: 'weak' }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 0)
  const { patch } = h.updates[0]
  assert.equal(patch.stage, 'no_email')
  assert.ok(!('email' in patch), 'no_email wrote an email field')
  assert.ok(!('phone' in patch), 'no_email touched the phone number')
})

test('an email not present in the page text is refused, never written', async () => {
  const h = harness({
    rows: [acme],
    // Some email-shaped text is present (so the pre-Claude scan doesn't
    // short-circuit to no_email before the model is even asked), but not the
    // one the model claims: well-formed, plausible, and a constructed guess.
    pages: { home: PAGE('<p>HR only: worker@acme.example</p>') },
    answer: JSON.stringify({ email: 'info@acme.example', facts: ['a', 'b', 'c'], fit: 'good' }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 0)
  assert.equal(h.updates[0].patch.stage, 'no_email')
})

test('a fetch that throws leaves the row at sourced and writes one error event', async () => {
  const h = harness({ rows: [acme], fetchThrows: true })
  const out = await qualify(h.deps)
  assert.equal(out.errors, 1)
  assert.equal(h.updates.length, 0, 'a failed fetch changed the row')
  const errs = h.events.filter((e) => e.kind === 'error')
  assert.equal(errs.length, 1)
  assert.equal(errs[0].detail.business, 'b1')
  assert.equal(errs[0].detail.name, 'Acme Roofing')
})

test('a business with no domain is a calling lead, not an error retried forever', async () => {
  const h = harness({ rows: [{ ...acme, domain: null }] })
  const out = await qualify(h.deps)
  assert.equal(out.errors, 0)
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].patch.stage, 'no_email')
  assert.ok(!('phone' in h.updates[0].patch), 'phone must stay as sourced')
  assert.equal(h.events.find((e) => e.kind === 'no_email').detail.reason, 'no domain')
})

test('an unparseable Claude answer is an error, not a half-written row', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: PAGE('<p>Reach us at hello@acme.example</p>') },
    answer: 'sorry, I cannot do that',
  })
  const out = await qualify(h.deps)
  assert.equal(out.errors, 1)
  assert.equal(h.updates.length, 0)
})

test('an empty backlog writes a skipped event', async () => {
  const h = harness({ rows: [] })
  await qualify(h.deps)
  assert.deepEqual(h.events.map((e) => e.kind), ['skipped'])
})

test('the prompt forbids constructing an address from the domain', () => {
  assert.match(PROMPT, /Never construct one from the domain/i)
  assert.match(PROMPT, /appears verbatim/i)
})

test('the page text sent to Claude is capped', async () => {
  let sent = ''
  const h = harness({ rows: [acme], answer: JSON.stringify({ email: null, facts: [], fit: 'no' }) })
  h.deps.fetchPage = async () => '<p>' + 'x '.repeat(400_000) + '</p>'
  h.deps.claude = { ask: async (p) => { sent = p; return JSON.stringify({ email: null, facts: [], fit: 'no' }) } }
  await qualify(h.deps)
  assert.ok(sent.length <= PROMPT.length + 2 * MAX_CHARS + 4, `prompt was ${sent.length}`)
})

test('qualify with no claude client writes a skipped event and never throws', async () => {
  const h = harness({ rows: [acme] })
  delete h.deps.claude
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 0)
  assert.deepEqual(h.events.map((e) => e.kind), ['skipped'])
  assert.match(h.events[0].detail.reason, /claude/)
  assert.equal(h.updates.length, 0)

  const h2 = harness({ rows: [acme] })
  delete h2.deps.fetchPage
  await qualify(h2.deps)
  assert.match(h2.events[0].detail.reason, /fetchPage/)
})

const verifiable = {
  rows: [acme],
  pages: { home: PAGE('<p>Reach us at hello@acme.example</p>') },
  answer: JSON.stringify({ email: 'hello@acme.example', facts: ['a', 'b', 'c'], fit: 'good' }),
}

test('an address the probe calls invalid lands at no_email with email cleared and phone intact', async () => {
  const h = harness(verifiable)
  h.deps.verify = async (address) => ({ ok: false, status: 'invalid', address })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 0)
  const { patch } = h.updates[0]
  assert.equal(patch.stage, 'no_email')
  assert.equal(patch.email, null)
  assert.ok(!('phone' in patch), 'verification failure touched the phone number')
})

test('an unknown verdict leaves the row qualified with its address', async () => {
  const h = harness(verifiable)
  h.deps.verify = async (address) => ({ ok: false, status: 'unknown', code: 450, address })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  assert.equal(h.updates[0].patch.stage, 'qualified')
  assert.equal(h.updates[0].patch.email, 'hello@acme.example')
})

test('a probe that throws is an unknown, not a rejection', async () => {
  const h = harness(verifiable)
  h.deps.verify = async () => { throw new Error('ETIMEDOUT') }
  assert.equal((await qualify(h.deps)).qualified, 1)
})


// --- what a real run turned up ---------------------------------------------
// The first live qualify run errored on a business whose site returned nothing:
// the model, handed an empty PAGE TEXT, answered in prose about that, and the
// unguarded JSON.parse threw. Both halves are covered here.

test('an empty page is skipped without spending a Claude call', async () => {
  const h = harness({ rows: [acme], pages: { home: '' } })
  const out = await qualify(h.deps)
  assert.equal(out.skipped, 1)
  assert.equal(out.errors, 0, 'a dead site is not an error')
  assert.equal(h.asks, 0, 'the model was asked to read an empty page')
  assert.equal(h.updates.length, 0, 'the row moved off sourced and will not be retried')
  assert.match(h.events.at(-1).detail.reason, /no text/)
})

test('page text with no email-shaped string skips the Claude call and lands at no_email', async () => {
  const h = harness({ rows: [acme] }) // default PAGE() has no @ anywhere
  const out = await qualify(h.deps)
  assert.equal(h.asks, 0, 'Claude was called despite no email-shaped text')
  assert.equal(out.qualified, 0)
  assert.equal(h.updates[0].patch.stage, 'no_email')
  assert.equal(h.events.find((e) => e.kind === 'no_email').detail.reason, 'no email-shaped text on page')
})

test('the time guard stops the loop and leaves untouched rows at sourced', async () => {
  const rows = [acme, { ...acme, id: 'b2' }, { ...acme, id: 'b3' }]
  const h = harness({
    rows,
    pages: { home: PAGE('<p>Reach us at hello@acme.example</p>') },
    answer: JSON.stringify({ email: 'hello@acme.example', facts: ['a', 'b', 'c'], fit: 'good' }),
  })
  // Elapsed time exceeds budgetMs right after the first row is processed.
  let calls = 0
  const clock = () => (calls++ === 0 ? 0 : 1000)
  const out = await qualify({ ...h.deps, budgetMs: 500, clock })
  assert.equal(out.timedOut, true)
  assert.ok(h.updates.length < rows.length, 'the time guard did not stop the loop')
  assert.ok(
    h.events.some((e) => e.kind === 'skipped' && /time guard/.test(e.detail.reason)),
    'no skipped event explained the time guard'
  )
})

test('qualify promotes up to callTasksPerDay minus what already promoted today, one event per row', async () => {
  const promoted = []
  const h = harness({
    rows: [],
    promotedToday: 5,
    promoteNoEmail: async (_s, { limit }) => {
      assert.equal(limit, 15) // callTasksPerDay(20) - promotedToday(5)
      const rows = Array.from({ length: limit }, (_, i) => ({ id: `no-email-${i}` }))
      promoted.push(...rows)
      return rows
    },
  })
  const out = await qualify(h.deps)
  assert.equal(out.promoted, 15)
  assert.equal(h.events.filter((e) => e.kind === 'promoted').length, 15)
})

test('a second same-day qualify run promotes nothing once the day quota is spent', async () => {
  const h = harness({
    rows: [],
    promotedToday: 20, // callTasksPerDay's default, already spent
    promoteNoEmail: async () => {
      throw new Error('promoteNoEmail should not be called with no room left')
    },
  })
  const out = await qualify(h.deps)
  assert.equal(out.promoted, 0)
  assert.equal(h.events.filter((e) => e.kind === 'promoted').length, 0)
})

test('parseAnswer digs the object out of a fenced or chatty reply', () => {
  const obj = { email: null, facts: [], fit: 'weak', reason: 'thin' }
  assert.deepEqual(parseAnswer(JSON.stringify(obj)), obj)
  assert.deepEqual(parseAnswer('```json\n' + JSON.stringify(obj) + '\n```'), obj)
  assert.deepEqual(parseAnswer(`Here you go:\n${JSON.stringify(obj)}\nHope that helps!`), obj)
  // Already-parsed objects pass through; genuinely unusable prose still throws,
  // which leaves the row at sourced for the next tick rather than mis-filing it.
  assert.deepEqual(parseAnswer(obj), obj)
  assert.throws(() => parseAnswer('The PAGE TEXT appears to be empty.'), /no JSON/)
})
