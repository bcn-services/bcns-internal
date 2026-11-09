import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COLUMNS, createSheet, dedupe, mapRow } from '../lib/sheet.mjs'

const col = (values, name) => values[COLUMNS.indexOf(name)]
const row = (over = {}) => ({
  id: 'b1', place_id: 'ChIJ1', name: 'Acme Roofing', trade: 'roofing', town: 'Danbury',
  phone: '+1 203-555-0142', domain: 'acmeroofing.example', source_query: 'roofer danbury', ...over,
})

test('COLUMNS matches the sheet header the Mac pull wrote (sheets.py)', () => {
  assert.equal(COLUMNS.length, 22)
  assert.deepEqual([COLUMNS[0], COLUMNS[11], COLUMNS[19], COLUMNS[21]], ['place_id', 'status', 'source_query', 'notes'])
})

test('mapRow: a scored row fills identity, status new, date and a fit note; judgment columns stay blank', () => {
  const v = mapRow({ row: row(), research: { fit_score: 8, fit: 'good', reason: 'paper job tracking' } }, '2026-11-10')
  assert.equal(v.length, COLUMNS.length)
  assert.deepEqual(
    ['place_id', 'business_name', 'type', 'city', 'phone', 'website', 'has_website', 'status', 'source_query', 'date_added', 'notes'].map((c) => col(v, c)),
    ['ChIJ1', 'Acme Roofing', 'roofing', 'Danbury', '+1 203-555-0142', 'acmeroofing.example', 'yes', 'new', 'roofer danbury', '2026-11-10', 'fit 8 — paper job tracking'],
  )
  for (const c of ['rating', 'lead_score', 'score_reason', 'call_count', 'deal_value']) assert.equal(col(v, c), '')
})

test('mapRow: label-only fit, null place_id, no domain, no source_query', () => {
  const v = mapRow({ row: row({ place_id: null, domain: null, source_query: null }), research: { fit: 'weak' } }, 'd')
  assert.equal(col(v, 'place_id'), 'pipeline:b1')
  assert.equal(col(v, 'website'), '')
  assert.equal(col(v, 'has_website'), 'no')
  assert.equal(col(v, 'source_query'), '')
  assert.equal(col(v, 'notes'), 'fit weak')
  assert.equal(col(mapRow({ row: row(), research: {} }, 'd'), 'notes'), '')
  assert.equal(col(mapRow({ row: row(), research: { fit_score: 0 } }, 'd'), 'notes'), 'fit 0')
})

test('dedupe drops ids already in the sheet and repeats within the batch, order kept', () => {
  const r = (id) => [id, `n-${id}`]
  assert.deepEqual(dedupe(['a'], [r('a'), r('b'), r('c'), r('b')]).map((x) => x[0]), ['b', 'c'])
})

function fakeFetch(responses) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, ...init })
    const { status = 200, body = {} } = responses.shift() ?? {}
    return { ok: status < 300, status, json: async () => body }
  }
  return { fetch, calls }
}

test('placeIds reads column A of the Leads tab with the bearer token', async () => {
  const f = fakeFetch([{ body: { values: [['a'], [''], ['b']] } }])
  const ids = await createSheet({ token: 'tok', sheetId: 'SHEET', fetch: f.fetch }).placeIds()
  assert.deepEqual(ids, ['a', 'b'])
  assert.equal(f.calls[0].url, 'https://sheets.googleapis.com/v4/spreadsheets/SHEET/values/Leads!A2%3AA')
  assert.equal(f.calls[0].method, undefined)
  assert.equal(f.calls[0].headers.authorization, 'Bearer tok')
})

test('placeIds on an empty tab is an empty list', async () => {
  const f = fakeFetch([{ body: {} }])
  assert.deepEqual(await createSheet({ token: 't', sheetId: 'S', fetch: f.fetch }).placeIds(), [])
})

test('append POSTs RAW values as inserted rows', async () => {
  const f = fakeFetch([{ body: {} }])
  await createSheet({ token: 'tok', sheetId: 'SHEET', fetch: f.fetch }).append([['a', '=HYPERLINK()']])
  const c = f.calls[0]
  assert.equal(c.method, 'POST')
  assert.equal(c.url, 'https://sheets.googleapis.com/v4/spreadsheets/SHEET/values/Leads!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS')
  assert.deepEqual(JSON.parse(c.body), { values: [['a', '=HYPERLINK()']] })
})

test('a non-2xx throws with the status and Google message, never the token', async () => {
  const f = fakeFetch([{ status: 403, body: { error: { message: 'The caller does not have permission' } } }])
  await assert.rejects(createSheet({ token: 'secret-tok', sheetId: 'S', fetch: f.fetch }).placeIds(), (err) => {
    assert.match(err.message, /403: The caller does not have permission/)
    assert.ok(!err.message.includes('secret-tok'))
    return true
  })
})
