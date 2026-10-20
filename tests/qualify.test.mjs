import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trim, MAX_CHARS } from '../lib/trim.mjs'
import { run as qualify, PROMPT, parseAnswer, fitScore, MIN_SIGNALS, CHAIN_CAP } from '../jobs/qualify.mjs'

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

// Signals live in raw tags; each snippet is one platform from lib/signals.mjs.
const SHOPIFY = '<script src="https://cdn.shopify.com/s/files/1/x/theme.js"></script>'
const CALENDLY = '<iframe src="https://calendly.com/acme/30min"></iframe>'
const STRIPE = '<script src="https://js.stripe.com/v3/"></script>'
const GTAG = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>'

const PAGE = (extra = '') => `<html><body><p>Acme Roofing, family run since 1998,
  serves Milford and Stratford CT. GAF certified.</p>${extra}</body></html>`
// Two code-detected signals (store + booking): clears the gate.
const FIT_PAGE = (extra = '') => PAGE(SHOPIFY + CALENDLY + extra)

// 2026-10-19 is a Monday: promotion runs. Tests never read the real clock.
const MONDAY = Date.UTC(2026, 9, 19, 12)
const SATURDAY = Date.UTC(2026, 9, 24, 12)

const MODEL = (over = {}) =>
  JSON.stringify({
    email: null,
    owner_name: null,
    facts: ['Family run since 1998', 'Serves Milford and Stratford CT', 'GAF certified'],
    signals: { store: true, booking: true, payments: false, marketing: false },
    headcount_band: '6-20',
    locations: 1,
    fit_score: 80,
    reason: 'books jobs by phone',
    ...over,
  })

function harness({ rows, pages = {}, answer, fetchThrows = false, promotedToday = 0, promoteQualified } = {}) {
  const events = []
  const updates = []
  const fetched = []
  let asks = 0
  return {
    events, updates, fetched, get asks() { return asks },
    deps: {
      sql: {},
      clock: () => MONDAY,
      db: {
        logEvent: (_s, job, kind, detail) => events.push({ job, kind, detail }),
        sourcedBacklog: async () => rows,
        updateBusiness: async (_s, id, patch) => { updates.push({ id, patch }); return [] },
        // The promotion step runs at the end of every qualify tick regardless
        // of the sourced backlog; default to "nothing to promote" so tests
        // aimed at the main loop don't have to know about it.
        promotedToday: async () => [{ count: promotedToday }],
        promoteQualified: promoteQualified ?? (async () => []),
      },
      fetchPage: async (url) => {
        fetched.push(url)
        if (fetchThrows) throw new Error('ECONNREFUSED')
        if (url in pages) return pages[url]
        const path = url.replace(/^https:\/\/[^/]+/, '')
        if (path === '') return pages.home ?? FIT_PAGE()
        throw new Error('404')
      },
      claude: { ask: async () => { asks++; return typeof answer === 'function' ? answer() : answer ?? MODEL() } },
    },
  }
}

const acme = { id: 'b1', name: 'Acme Roofing', domain: 'acme.example', phone: '555-0100', email: null, state: 'CT' }
const researchOf = (u) => JSON.parse(u.patch.research)

test('a row with 2+ code-detected signals and a phone is qualified with a numeric fit_score, signals and reason', async () => {
  const h = harness({ rows: [acme] })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  const { patch } = h.updates[0]
  assert.equal(patch.stage, 'qualified')
  const r = researchOf(h.updates[0])
  assert.equal(typeof r.fit_score, 'number', 'fit_score must be a JSON number, not a string')
  assert.ok(r.fit_score >= 0 && r.fit_score <= 100)
  assert.deepEqual(r.signals, { store: true, booking: true, payments: false, marketing: false })
  assert.deepEqual(r.signal_evidence.store, ['shopify'])
  assert.equal(r.reason, 'books jobs by phone')
  assert.equal(r.headcount_band, '6-20')
  assert.equal(r.locations, 1)
  assert.ok(r.facts.length >= 3)
  assert.ok(!('fit' in r), 'the old good/weak/no label is gone')
  assert.equal(h.events.at(-1).kind, 'qualified')
})

test('the stored fit_score is the code formula, not the number the model returned', async () => {
  const h = harness({ rows: [acme], answer: MODEL({ fit_score: 100 }) })
  await qualify(h.deps)
  const r = researchOf(h.updates[0])
  // 2 signals (40) + niche 100*0.06 (6) + band 6-20 (5) + 1 location (5) + CT (0.3)
  assert.equal(r.fit_score, 56.3)
  assert.equal(r.niche_score, 100)
})

test('HARD GATE: one signal is not enough — lost/unfit, and the model is never asked', async () => {
  const h = harness({ rows: [acme], pages: { home: PAGE(SHOPIFY) } })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 0)
  assert.equal(out.lost, 1)
  assert.equal(h.asks, 0, 'a row below the gate cannot pass; the Claude call is wasted')
  const { patch } = h.updates[0]
  assert.equal(patch.stage, 'lost')
  assert.equal(researchOf(h.updates[0]).lost_reason, 'unfit')
  assert.equal(MIN_SIGNALS, 2)
})

test('HARD GATE: zero signals is lost/unfit too', async () => {
  const h = harness({ rows: [acme], pages: { home: PAGE() } })
  await qualify(h.deps)
  assert.equal(h.updates[0].patch.stage, 'lost')
  assert.equal(researchOf(h.updates[0]).lost_reason, 'unfit')
  assert.equal(h.events.find((e) => e.kind === 'lost').detail.reason, 'unfit')
})

test('HARD GATE: signals the model claims without code evidence do not count', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: PAGE(GTAG) }, // exactly one code-detected signal
    answer: MODEL({ signals: { store: true, booking: true, payments: true, marketing: true } }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 0)
  assert.equal(h.updates[0].patch.stage, 'lost')
  assert.equal(researchOf(h.updates[0]).lost_reason, 'unfit')
})

test('code is authoritative when the model disagrees downward: 2 code signals pass, model says none', async () => {
  const h = harness({
    rows: [acme],
    answer: MODEL({ signals: { store: false, booking: false, payments: false, marketing: false } }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  const r = researchOf(h.updates[0])
  assert.equal(r.signals.store, true)
  assert.equal(r.signals.booking, true)
  assert.deepEqual(r.signals_model, { store: false, booking: false, payments: false, marketing: false })
})

test('signals are read from raw html: a pixel and a payments script in <script> tags count', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: PAGE(`${GTAG}${STRIPE}`) },
  })
  assert.equal((await qualify(h.deps)).qualified, 1)
})

test('HARD GATE: no phone is lost/no_phone even with every signal — and nothing is fetched or asked', async () => {
  for (const phone of [null, undefined, '', '   ']) {
    const h = harness({ rows: [{ ...acme, phone }] })
    const out = await qualify(h.deps)
    assert.equal(out.qualified, 0, `phone ${JSON.stringify(phone)} qualified`)
    assert.equal(out.lost, 1)
    assert.equal(h.updates[0].patch.stage, 'lost')
    assert.equal(researchOf(h.updates[0]).lost_reason, 'no_phone')
    assert.equal(h.asks, 0)
    assert.equal(h.fetched.length, 0, 'a phoneless row cost a fetch')
  }
})

test('a business with no domain cannot show signals: lost/unfit, not an error retried forever', async () => {
  const h = harness({ rows: [{ ...acme, domain: null }] })
  const out = await qualify(h.deps)
  assert.equal(out.errors, 0)
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].patch.stage, 'lost')
  assert.equal(researchOf(h.updates[0]).lost_reason, 'unfit')
  assert.ok(!('phone' in h.updates[0].patch), 'phone must stay as sourced')
})

test('new code never writes the legacy no_email stage', async () => {
  const rows = [
    acme,
    { ...acme, id: 'b2', phone: null },
    { ...acme, id: 'b3', domain: null },
    { ...acme, id: 'b4', research: JSON.stringify({ qualify_failures: 2 }) },
  ]
  const h = harness({ rows, pages: { home: '' } })
  await qualify(h.deps)
  assert.ok(h.updates.length >= 4)
  assert.ok(h.updates.every((u) => u.patch.stage !== 'no_email'))
  assert.ok(!h.events.some((e) => e.kind === 'no_email'))
})

test('an email found on the page is stored unverified; none found still qualifies, email untouched', async () => {
  const withEmail = harness({
    rows: [acme],
    pages: { home: FIT_PAGE('<p>Reach us at hello@acme.example</p>') },
    answer: MODEL({ email: 'hello@acme.example' }),
  })
  await qualify(withEmail.deps)
  assert.equal(withEmail.updates[0].patch.email, 'hello@acme.example')
  assert.equal(researchOf(withEmail.updates[0]).email_verified, false)

  const without = harness({ rows: [acme] })
  const out = await qualify(without.deps)
  assert.equal(out.qualified, 1)
  assert.equal(without.updates[0].patch.stage, 'qualified')
  assert.ok(!('email' in without.updates[0].patch), 'an email was written that nobody published')
  assert.ok(!('phone' in without.updates[0].patch), 'qualify touched the phone number')
})

test('an email claimed with trailing punctuation or a label is never stored with it', async () => {
  for (const claimed of ['info@acme.example.', 'Email: info@acme.example', 'info@acme.example,', '<info@acme.example>']) {
    const h = harness({
      rows: [acme],
      pages: { home: FIT_PAGE(`<p>${claimed}</p>`) },
      answer: MODEL({ email: claimed }),
    })
    const out = await qualify(h.deps)
    assert.equal(out.qualified, 1, claimed)
    assert.ok(!('email' in h.updates[0].patch), `${claimed} was stored as ${h.updates[0].patch.email}`)
    assert.ok(!('email_verified' in researchOf(h.updates[0])))
  }
})

test('an email not present in the page text is refused, never written', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: FIT_PAGE('<p>HR only: worker@acme.example</p>') },
    answer: MODEL({ email: 'info@acme.example' }),
  })
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  assert.ok(!('email' in h.updates[0].patch), 'a constructed address was stored')
})

test('owner_name lands in research when stated, null (never a guess) when not', async () => {
  const named = harness({ rows: [acme], answer: MODEL({ owner_name: 'Dave' }) })
  await qualify(named.deps)
  assert.equal(researchOf(named.updates[0]).owner_name, 'Dave')
  const anon = harness({ rows: [acme] })
  await qualify(anon.deps)
  assert.equal(researchOf(anon.updates[0]).owner_name, null)
})

test('at most one Claude call per business, none for rows that fail a gate', async () => {
  const h = harness({ rows: [acme, { ...acme, id: 'b2' }, { ...acme, id: 'b3', phone: null }] })
  await qualify(h.deps)
  assert.equal(h.asks, 2)
})

// --- fitScore --------------------------------------------------------------

const S = (n) => Object.fromEntries(['store', 'booking', 'payments', 'marketing'].map((k, i) => [k, i < n]))
const base = { signals: S(2), nicheScore: 0, headcountBand: null, locations: null, state: 'TX' }

test('fitScore: one more signal outranks every other factor combined', () => {
  const best2 = fitScore({ ...base, signals: S(2), nicheScore: 100, headcountBand: '1-5', locations: 1, state: 'CT' })
  const bare3 = fitScore({ ...base, signals: S(3) })
  assert.ok(bare3 > best2, `${bare3} should beat ${best2}`)
  assert.ok(fitScore({ ...base, signals: S(4) }) > fitScore({ ...base, signals: S(3), nicheScore: 100, headcountBand: '1-5', locations: 1, state: 'CT' }))
})

test('fitScore: small headcount and a single location add points; larger or multi do not', () => {
  const b = fitScore(base)
  assert.equal(fitScore({ ...base, headcountBand: '1-5' }), b + 5)
  assert.equal(fitScore({ ...base, headcountBand: '6-20' }), b + 5)
  assert.equal(fitScore({ ...base, headcountBand: '21-50' }), b)
  assert.equal(fitScore({ ...base, headcountBand: '51+' }), b)
  assert.equal(fitScore({ ...base, locations: 1 }), b + 5)
  assert.equal(fitScore({ ...base, locations: 2 }), b)
})

test('fitScore: chains and franchises (3+ locations) score below any non-chain that passes the gate', () => {
  const chain = fitScore({ ...base, signals: S(4), nicheScore: 100, headcountBand: '1-5', locations: 3, state: 'CT' })
  assert.ok(chain <= CHAIN_CAP)
  assert.ok(chain < fitScore({ ...base, signals: S(MIN_SIGNALS) }))
})

test('fitScore: geography only breaks ties, CT > NYC > CA > other, and totals under one point', () => {
  const g = (state) => fitScore({ ...base, state })
  assert.ok(g('CT') > g('NY') && g('NY') > g('CA') && g('CA') > g('TX'))
  assert.equal(g('NJ'), g('NY'))
  // The biggest geography bonus is smaller than the smallest other step (1 niche point).
  assert.ok(g('CT') - g('TX') < 1)
  assert.equal(typeof g('CT'), 'number')
  assert.equal(g('CT'), 40.3) // exact one-decimal value, no float noise
})

test('fitScore: a CT row with one fewer niche point ranks below the same row elsewhere', () => {
  // nicheScore 50 -> 3 points, 33 -> 2 points: exactly one point apart.
  const elsewhere = fitScore({ ...base, nicheScore: 50, state: 'TX' })
  const ct = fitScore({ ...base, nicheScore: 33, state: 'CT' })
  assert.ok(ct < elsewhere, `CT ${ct} should rank below ${elsewhere}`)
  // And with the niche points equal, CT wins the tie.
  assert.ok(fitScore({ ...base, nicheScore: 50, state: 'CT' }) > elsewhere)
})

test('fitScore: stays within 0-100 and tolerates a model that returns junk', () => {
  const max = fitScore({ signals: S(4), nicheScore: 9999, headcountBand: '1-5', locations: 1, state: 'CT' })
  assert.ok(max <= 100)
  const junk = fitScore({ signals: S(2), nicheScore: 'lots', headcountBand: {}, locations: 'many', state: null })
  assert.equal(junk, 40)
})

// --- failures, parking, guards ---------------------------------------------

test('the first and second failure count on the row and leave it at sourced', async () => {
  for (const prior of [undefined, 1]) {
    const research = prior ? JSON.stringify({ qualify_failures: prior, keep: 'me' }) : undefined
    const h = harness({ rows: [{ ...acme, research }], fetchThrows: true })
    const out = await qualify(h.deps)
    assert.equal(out.errors, 1)
    assert.equal(h.updates.length, 1)
    const patch = h.updates[0].patch
    assert.ok(!('stage' in patch), 'a sub-cap failure moved the row')
    assert.equal(researchOf(h.updates[0]).qualify_failures, (prior ?? 0) + 1)
    if (prior) assert.equal(researchOf(h.updates[0]).keep, 'me', 'existing research was dropped')
    assert.equal(typeof patch.research, 'string', 'research must stay JSON.stringify-encoded')
    const errs = h.events.filter((e) => e.kind === 'error')
    assert.equal(errs.length, 1)
    assert.equal(errs[0].detail.business, 'b1')
    assert.equal(errs[0].detail.name, 'Acme Roofing')
    assert.ok(!h.events.some((e) => e.kind === 'lost'))
  }
})

test('the third failure parks the row as lost/fetch_failed with a reason', async () => {
  const research = JSON.stringify({ qualify_failures: 2 })
  const h = harness({ rows: [{ ...acme, research }], fetchThrows: true })
  await qualify(h.deps)
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].patch.stage, 'lost')
  assert.equal(researchOf(h.updates[0]).lost_reason, 'fetch_failed')
  assert.equal(researchOf(h.updates[0]).qualify_failures, 3)
  const parked = h.events.filter((e) => e.kind === 'lost')
  assert.equal(parked.length, 1)
  assert.equal(parked[0].detail.reason, 'site unreachable after 3 attempts')
  assert.equal(h.events.filter((e) => e.kind === 'error').length, 1, 'the error event was dropped')
})

test('a duplicate email (23505) still qualifies the row, without the email', async () => {
  const h = harness({
    rows: [acme],
    pages: { home: FIT_PAGE('<p>Reach us at hello@acme.example</p>') },
    answer: MODEL({ email: 'hello@acme.example' }),
  })
  const real = h.deps.db.updateBusiness
  h.deps.db.updateBusiness = async (s, id, patch) => {
    if (patch.email) throw Object.assign(new Error('duplicate key businesses_email_key'), { code: '23505' })
    return real(s, id, patch)
  }
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  assert.equal(out.errors, 0)
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].patch.stage, 'qualified')
  assert.ok(!('email' in h.updates[0].patch))
})

test('a failing counter write does not mask the error or crash the run', async () => {
  const h = harness({ rows: [acme, { ...acme, id: 'b2' }], fetchThrows: true })
  h.deps.db.updateBusiness = async () => { throw new Error('db down') }
  const out = await qualify(h.deps)
  assert.equal(out.errors, 2)
  const errs = h.events.filter((e) => e.kind === 'error')
  assert.equal(errs.length, 2)
  assert.equal(errs[0].detail.error, 'ECONNREFUSED')
})

test('an unparseable Claude answer is an error that rotates the row, never a half-written qualified row', async () => {
  const h = harness({ rows: [acme], answer: 'sorry, I cannot do that' })
  const out = await qualify(h.deps)
  assert.equal(out.errors, 1)
  assert.equal(h.updates.length, 1)
  assert.ok(!('stage' in h.updates[0].patch), 'a parse failure moved the row')
  assert.ok(!('email' in h.updates[0].patch))
  assert.equal(researchOf(h.updates[0]).qualify_errors, 1)
  assert.ok(!('fit_score' in researchOf(h.updates[0])), 'a half-scored row was written')
})

test('a post-fetch failure bumps qualify_errors (so the row rotates) and leaves the fetch-failure count alone', async () => {
  for (const [priorErrors, priorFetch] of [[undefined, undefined], [1, 2]]) {
    const research = JSON.stringify({ keep: 'me', ...(priorErrors && { qualify_errors: priorErrors }), ...(priorFetch && { qualify_failures: priorFetch }) })
    const h = harness({ rows: [{ ...acme, research }], answer: () => { throw new Error('claude is down') } })
    const out = await qualify(h.deps)
    assert.equal(out.errors, 1)
    assert.equal(h.updates.length, 1, 'no write means updated_at never bumps and the row never rotates')
    const { patch } = h.updates[0]
    const r = researchOf(h.updates[0])
    assert.ok(!('stage' in patch), 'a sub-cap post-fetch failure moved the row')
    assert.equal(r.qualify_errors, (priorErrors ?? 0) + 1)
    assert.equal(r.qualify_failures, priorFetch, 'the fetch-failure count changed')
    assert.equal(r.keep, 'me', 'existing research was clobbered')
    assert.equal(typeof patch.research, 'string')
    assert.equal(h.events.filter((e) => e.kind === 'error').length, 1)
    assert.ok(!h.events.some((e) => e.kind === 'lost'))
  }
})

test('the third post-fetch failure parks the row as lost/qualify_failed', async () => {
  const research = JSON.stringify({ qualify_errors: 2, qualify_failures: 1, keep: 'me' })
  const h = harness({ rows: [{ ...acme, research }], answer: () => { throw new Error('claude is down') } })
  await qualify(h.deps)
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].patch.stage, 'lost')
  const r = researchOf(h.updates[0])
  assert.equal(r.lost_reason, 'qualify_failed')
  assert.equal(r.qualify_errors, 3)
  assert.equal(r.qualify_failures, 1, 'the fetch-failure count changed')
  assert.equal(r.keep, 'me')
  const parked = h.events.filter((e) => e.kind === 'lost')
  assert.equal(parked.length, 1)
  assert.match(parked[0].detail.reason, /qualify failed after 3 attempts/)
})

test('a failing bookkeeping write after a post-fetch failure is swallowed', async () => {
  const h = harness({ rows: [acme, { ...acme, id: 'b2' }], answer: () => { throw new Error('claude is down') } })
  h.deps.db.updateBusiness = async () => { throw new Error('db down') }
  const out = await qualify(h.deps)
  assert.equal(out.errors, 2)
  assert.equal(h.events.filter((e) => e.kind === 'error').length, 2)
})

test('a log failure after a stage write does not rewrite the row', async () => {
  const h = harness({ rows: [acme], pages: { home: PAGE() } }) // no signals: lost/unfit
  const real = h.deps.db.logEvent
  h.deps.db.logEvent = (s, job, kind, detail) => {
    if (kind === 'lost') throw new Error('log down')
    return real(s, job, kind, detail)
  }
  const out = await qualify(h.deps)
  assert.equal(out.errors, 1)
  assert.equal(h.updates.length, 1, 'recordFailure overwrote a row that already moved')
  assert.equal(h.updates[0].patch.stage, 'lost')
})

test('an empty backlog writes a skipped event', async () => {
  const h = harness({ rows: [] })
  await qualify(h.deps)
  assert.deepEqual(h.events.map((e) => e.kind), ['skipped'])
})

test('the prompt forbids constructing an address and asks for the new shape', () => {
  assert.match(PROMPT, /Never construct one from the domain/i)
  assert.match(PROMPT, /appears verbatim/i)
  for (const key of ['email', 'owner_name', 'facts', 'signals', 'headcount_band', 'locations', 'fit_score', 'reason']) {
    assert.match(PROMPT, new RegExp(`"${key}"`), `prompt does not ask for ${key}`)
  }
})

test('the page text sent to Claude is capped', async () => {
  let sent = ''
  const h = harness({ rows: [acme] })
  h.deps.fetchPage = async () => `<p>${SHOPIFY}${CALENDLY}` + 'x '.repeat(400_000) + '</p>'
  h.deps.claude = { ask: async (p) => { sent = p; return MODEL() } }
  await qualify(h.deps)
  assert.ok(sent.length > PROMPT.length)
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

test('qualify no longer takes or calls an SMTP verify probe', async () => {
  const h = harness({ rows: [acme], pages: { home: FIT_PAGE('<p>hello@acme.example</p>') }, answer: MODEL({ email: 'hello@acme.example' }) })
  h.deps.verify = async () => { throw new Error('verify must not be called') }
  const out = await qualify(h.deps)
  assert.equal(out.qualified, 1)
  assert.equal(h.updates[0].patch.email, 'hello@acme.example')
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
  assert.equal(h.updates.length, 1)
  assert.ok(!('stage' in h.updates[0].patch), 'the first empty page moved the row')
  assert.equal(researchOf(h.updates[0]).qualify_failures, 1)
  assert.match(h.events.at(-1).detail.reason, /no text/)
})

test('an empty page counts toward the cap like a thrown fetch', async () => {
  const research = JSON.stringify({ qualify_failures: 2 })
  const h = harness({ rows: [{ ...acme, research }], pages: { home: '' } })
  await qualify(h.deps)
  assert.equal(h.updates[0].patch.stage, 'lost')
  assert.equal(researchOf(h.updates[0]).lost_reason, 'fetch_failed')
  assert.equal(h.asks, 0)
  assert.equal(h.events.at(-1).detail.reason, 'site unreachable after 3 attempts')
})

test('the time guard stops the loop and leaves untouched rows at sourced', async () => {
  const rows = [acme, { ...acme, id: 'b2' }, { ...acme, id: 'b3' }]
  const h = harness({ rows })
  // Elapsed time exceeds budgetMs right after the first row is processed.
  let calls = 0
  const clock = () => (calls++ === 0 ? MONDAY : MONDAY + 1000)
  const out = await qualify({ ...h.deps, budgetMs: 500, clock })
  assert.equal(out.timedOut, true)
  assert.ok(h.updates.length < rows.length, 'the time guard did not stop the loop')
  assert.ok(
    h.events.some((e) => e.kind === 'skipped' && /time guard/.test(e.detail.reason)),
    'no skipped event explained the time guard'
  )
})

test('the process deadline caps the budget: a near deadline skips the loop, logs the time guard, and still promotes', async () => {
  const rows = [acme, { ...acme, id: 'b2' }, { ...acme, id: 'b3' }]
  const h = harness({
    rows,
    promoteQualified: async () => [{ id: 'q-1' }],
  })
  // 1.5 s left in the process, though the 20-minute budget has all the time in
  // the world. The clock advances 1 s per read: start, row 1 (1 s in: go), row 2
  // (2 s in: past the deadline, stop).
  let t = MONDAY - 1000
  const out = await qualify({ ...h.deps, deadline: MONDAY + 1500, clock: () => (t += 1000) })
  assert.equal(out.timedOut, true)
  assert.equal(out.qualified, 1, 'the deadline did not stop the loop after the row in flight')
  assert.ok(h.events.some((e) => e.kind === 'skipped' && /time guard/.test(e.detail.reason)))
  assert.equal(out.promoted, 1, 'promotion must still run when the deadline cut the loop')
})

test('a deadline already passed processes no rows at all, and no deadline leaves the budget alone', async () => {
  const rows = [acme, { ...acme, id: 'b2' }]
  const late = harness({ rows })
  const out = await qualify({ ...late.deps, deadline: MONDAY - 1 })
  assert.equal(out.timedOut, true)
  assert.equal(late.updates.length, 0)
  assert.equal(late.asks, 0)

  const plenty = harness({ rows })
  const ok = await qualify({ ...plenty.deps, deadline: MONDAY + 24 * 60_000 })
  assert.equal(ok.timedOut, false)
  assert.equal(ok.qualified, 2)

  const none = harness({ rows })
  assert.equal((await qualify(none.deps)).qualified, 2) // deadline unset: budgetMs only
})

test('the default per-run limit is above what one 20-minute budget can read, and is passed to the backlog read', async () => {
  let asked
  const h = harness({ rows: [] })
  h.deps.db.sourcedBacklog = async (_s, { limit }) => { asked = limit; return [] }
  await qualify(h.deps)
  assert.ok(asked >= 150, `limit was ${asked}`)
})

// --- promotion -------------------------------------------------------------

test('qualify promotes up to callTasksPerDay (default 50) minus what already promoted today, one event per row', async () => {
  const h = harness({
    rows: [],
    promotedToday: 5,
    promoteQualified: async (_s, { limit }) => {
      assert.equal(limit, 45) // callTasksPerDay(50) - promotedToday(5)
      return Array.from({ length: limit }, (_, i) => ({ id: `q-${i}` }))
    },
  })
  const out = await qualify(h.deps)
  assert.equal(out.promoted, 45)
  assert.equal(h.events.filter((e) => e.kind === 'promoted').length, 45)
})

test('callTasksPerDay is configurable', async () => {
  let asked
  const h = harness({ rows: [], promoteQualified: async (_s, { limit }) => { asked = limit; return [] } })
  await qualify({ ...h.deps, callTasksPerDay: 12 })
  assert.equal(asked, 12)
})

test('a second same-day qualify run promotes nothing once the day quota is spent', async () => {
  const h = harness({
    rows: [],
    promotedToday: 50,
    promoteQualified: async () => {
      throw new Error('promoteQualified should not be called with no room left')
    },
  })
  const out = await qualify(h.deps)
  assert.equal(out.promoted, 0)
  assert.equal(h.events.filter((e) => e.kind === 'promoted').length, 0)
})

test('promotion only runs on weekday ticks before the 12:30 UTC digest', async () => {
  const at = (h, m = 0) => Date.UTC(2026, 9, 19, h, m) // Monday
  for (const [clock, expected] of [
    [at(8), 1], [at(11), 1], [at(12), 1], [at(12, 29), 1],
    [at(12, 30), 0], [at(13), 0], [at(20), 0],
  ]) {
    const h = harness({ rows: [acme], promoteQualified: async () => [{ id: 'q-1' }] })
    const out = await qualify({ ...h.deps, clock: () => clock })
    assert.equal(out.qualified, 1, 'a late tick must still qualify')
    assert.equal(out.promoted, expected, new Date(clock).toISOString())
  }
})

test('a post-digest tick never even asks the db for promotions', async () => {
  const h = harness({
    rows: [],
    promoteQualified: async () => { throw new Error('promoted after the digest') },
  })
  const out = await qualify({ ...h.deps, clock: () => Date.UTC(2026, 9, 19, 13) })
  assert.equal(out.promoted, 0)
})

test('weekends qualify but never promote: the digest is weekday-only', async () => {
  const h = harness({
    rows: [acme],
    promoteQualified: async () => {
      throw new Error('promoted on a weekend')
    },
  })
  const out = await qualify({ ...h.deps, clock: () => SATURDAY })
  assert.equal(out.qualified, 1)
  assert.equal(out.promoted, 0)
})

test('parseAnswer digs the object out of a fenced or chatty reply', () => {
  const obj = { email: null, facts: [], fit_score: 10, reason: 'thin' }
  assert.deepEqual(parseAnswer(JSON.stringify(obj)), obj)
  assert.deepEqual(parseAnswer('```json\n' + JSON.stringify(obj) + '\n```'), obj)
  assert.deepEqual(parseAnswer(`Here you go:\n${JSON.stringify(obj)}\nHope that helps!`), obj)
  // Already-parsed objects pass through; genuinely unusable prose still throws,
  // which leaves the row at sourced for the next tick rather than mis-filing it.
  assert.deepEqual(parseAnswer(obj), obj)
  assert.throws(() => parseAnswer('The PAGE TEXT appears to be empty.'), /no JSON/)
})

test('a deadline already passed: zero rows, the time-guard skip event, and promotion still evaluated', async () => {
  let asked = 0
  const h = harness({
    rows: [acme, { ...acme, id: 'b2' }],
    promoteQualified: async () => { asked++; return [{ id: 'q-1' }] },
  })
  const out = await qualify({ ...h.deps, deadline: MONDAY - 1 })
  assert.equal(out.timedOut, true)
  assert.equal(h.updates.length, 0, 'a row was touched after the deadline')
  assert.equal(h.asks, 0, 'Claude was called after the deadline')
  assert.equal(h.fetched.length, 0, 'a site was fetched after the deadline')
  const skips = h.events.filter((e) => e.kind === 'skipped' && /time guard/.test(e.detail.reason))
  assert.equal(skips.length, 1)
  assert.equal(asked, 1, 'promotion was not evaluated')
  assert.equal(out.promoted, 1)
})

test('a db error on the post-fetch stage write rotates the row via qualify_errors and merges research', async () => {
  const h = harness({ rows: [{ ...acme, research: JSON.stringify({ keep: 'me', qualify_failures: 1 }) }] })
  const writes = []
  h.deps.db.updateBusiness = async (_s, id, patch) => {
    writes.push({ id, patch })
    if (writes.length === 1) throw new Error('connection reset') // the stage write itself
    return []
  }
  const out = await qualify(h.deps)
  assert.equal(out.errors, 1)
  assert.equal(writes.length, 2, 'no bookkeeping write after the db error, so the row never rotates')
  assert.ok(!('stage' in writes[1].patch), 'a sub-cap error moved the row')
  const r = JSON.parse(writes[1].patch.research)
  assert.equal(r.qualify_errors, 1)
  assert.equal(r.qualify_failures, 1, 'the fetch-failure count changed')
  assert.equal(r.keep, 'me', 'existing research was clobbered')
  assert.ok(!('fit_score' in r), 'half-scored research was written')
})
