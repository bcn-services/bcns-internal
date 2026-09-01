import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPlaces, FIELD_MASK, SEARCH_URL } from '../lib/places.mjs'
import { createReadBudget } from '../lib/budget.mjs'
import { buildDeps } from '../jobs/run.mjs'

// Every fetch here is a fake. Nothing in this file opens a socket.
const fakeFetch = (body, { ok = true, status = 200 } = {}) => {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) }
  }
  fn.calls = calls
  return fn
}

const PLACE = {
  id: 'ChIJ1',
  displayName: { text: 'Acme Roofing' },
  formattedAddress: '1 Main St, Milford, CT 06460, USA',
  nationalPhoneNumber: '(203) 555-0100',
  websiteUri: 'https://www.acmeroofing.com/',
  rating: 4.7,
  userRatingCount: 88,
}

test('search posts a Places (New) text search with the bearer token and field mask', async () => {
  const fetch = fakeFetch({ places: [PLACE] })
  await createPlaces({ token: 'tok-123', project: 'bcns-leads', fetch }).search('roofers in Milford CT')

  const [{ url, init }] = fetch.calls
  assert.equal(url, SEARCH_URL)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer tok-123')
  assert.equal(init.headers['X-Goog-FieldMask'], FIELD_MASK)
  assert.equal(init.headers['x-goog-user-project'], 'bcns-leads')
  assert.deepEqual(JSON.parse(init.body), { textQuery: 'roofers in Milford CT', maxResultCount: 20 })
  // No API key, ever: the token is the only credential.
  assert.ok(!('X-Goog-Api-Key' in init.headers))
  assert.ok(!/key=/.test(url))
})

test('search maps a Places response to the row shape source inserts', async () => {
  const fetch = fakeFetch({ places: [PLACE, { id: 'ChIJ2', displayName: { text: 'Bare Co' } }] })
  const rows = await createPlaces({ token: 't', project: 'p', fetch }).search('q')
  assert.deepEqual(rows[0], {
    place_id: 'ChIJ1',
    name: 'Acme Roofing',
    phone: '(203) 555-0100',
    website: 'https://www.acmeroofing.com/',
    address: '1 Main St, Milford, CT 06460, USA',
    rating: 4.7,
    review_count: 88,
  })
  // A place missing every optional field still maps, with nulls, not undefined.
  assert.deepEqual(rows[1], {
    place_id: 'ChIJ2', name: 'Bare Co', phone: null, website: null,
    address: null, rating: null, review_count: null,
  })
})

test('search throws on a non-ok response rather than returning no rows', async () => {
  const fetch = fakeFetch({ error: 'nope' }, { ok: false, status: 403 })
  await assert.rejects(createPlaces({ token: 't', project: 'p', fetch }).search('q'), /places search failed \(403\)/)
})

test('createPlaces refuses to exist without a token', () => {
  assert.throws(() => createPlaces({ project: 'p' }), /access token/)
})

// --- lib/budget.mjs --------------------------------------------------------

const usage = (n) => ({ timeSeries: [{ points: [{ value: { int64Value: String(n) } }] }] })

test('readBudget returns remaining and month from the monitoring response', async () => {
  const fetch = fakeFetch(usage(150))
  const readBudget = createReadBudget({
    token: 'tok-123', project: 'bcns-leads', cap: 950, fetch,
    now: () => new Date('2026-08-31T12:00:00Z'),
  })
  const out = await readBudget()
  assert.equal(out.remaining, 800)
  assert.equal(out.month, '2026-08')

  const [{ url, init }] = fetch.calls
  assert.ok(url.startsWith('https://monitoring.googleapis.com/v3/projects/bcns-leads/timeSeries'))
  assert.equal(init.headers.authorization, 'Bearer tok-123')
  // The window is the calendar month to date, matching the cap's reset.
  assert.match(url, /interval\.startTime=2026-08-01T00%3A00%3A00Z/)
  assert.match(url, /places\.googleapis\.com/)
})

test('readBudget floors at zero once the cap is spent', async () => {
  const readBudget = createReadBudget({ token: 't', project: 'p', cap: 100, fetch: fakeFetch(usage(400)) })
  assert.equal((await readBudget()).remaining, 0)
})

test('an empty month is zero used, not a failure', async () => {
  const readBudget = createReadBudget({ token: 't', project: 'p', cap: 950, fetch: fakeFetch({}) })
  assert.equal((await readBudget()).remaining, 950)
})

test('readBudget throws, never returns a number, on a malformed or failed response', async () => {
  const cases = [
    [{ error: { message: 'denied' } }, { ok: false, status: 403 }, /cannot read usage \(403\)/],
    [{ timeSeries: 'not-a-list' }, {}, /timeSeries is not a list/],
    [{ timeSeries: [{ points: [{ value: {} }] }] }, {}, /no numeric value/],
    [{ timeSeries: [{ points: [{ value: { int64Value: 'lots' } }] }] }, {}, /no numeric value/],
    ['a string', {}, /not an object/],
  ]
  for (const [body, opts, re] of cases) {
    const readBudget = createReadBudget({ token: 't', project: 'p', fetch: fakeFetch(body, opts) })
    await assert.rejects(readBudget(), re, `expected a throw for ${JSON.stringify(body)}`)
  }
})

// --- jobs/run.mjs deps -----------------------------------------------------

test('buildDeps carries places and readBudget when the token and project are present', async () => {
  const deps = await buildDeps({ GOOGLE_OAUTH_ACCESS_TOKEN: 'tok', GCP_PROJECT: 'bcns-leads' })
  assert.equal(typeof deps.places?.search, 'function')
  assert.equal(typeof deps.readBudget, 'function')
  assert.equal(deps.sql, undefined, 'no DATABASE_URL means no postgres client')
})

test('buildDeps leaves both off when the auth step minted no token', async () => {
  for (const env of [{ GCP_PROJECT: 'bcns-leads' }, { GOOGLE_OAUTH_ACCESS_TOKEN: '', GCP_PROJECT: 'p' }, {}]) {
    const deps = await buildDeps(env)
    assert.equal(deps.places, undefined)
    assert.equal(deps.readBudget, undefined)
    assert.equal(deps.dryRun, true)
  }
})
