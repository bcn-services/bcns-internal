import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GRID, TRADES, TOWNS, pickNextCell, evaluateRun, cellQuery, isKnownCell } from '../lib/grid.mjs'
import { run as source } from '../jobs/source.mjs'

const cells = (rows) => rows.map((r) => ({ exhausted_at: null, last_run_at: null, ...r }))

test('the grid is every trade by every town, and nothing else', () => {
  assert.equal(TRADES.length, 8)
  assert.equal(GRID.length, TRADES.length * TOWNS.length)
  assert.ok(isKnownCell({ trade: 'roofers', town: 'Milford', state: 'CT' }))
  assert.ok(!isKnownCell({ trade: 'roofers', town: 'Boston', state: 'MA' }))
  assert.ok(!isKnownCell({ trade: 'dentists', town: 'Milford', state: 'CT' }))
})

test('pickNextCell returns the least recently run unexhausted cell', () => {
  const c = cells([
    { trade: 'roofers', town: 'Milford', state: 'CT', last_run_at: '2026-08-20' },
    { trade: 'plumbers', town: 'Milford', state: 'CT', last_run_at: '2026-08-01' },
    { trade: 'HVAC', town: 'Milford', state: 'CT', last_run_at: '2026-08-10' },
  ])
  assert.equal(pickNextCell(c).trade, 'plumbers')
})

test('a never-run cell outranks every cell that has run', () => {
  const c = cells([
    { trade: 'roofers', town: 'Milford', state: 'CT', last_run_at: '2020-01-01' },
    { trade: 'plumbers', town: 'Milford', state: 'CT' },
  ])
  assert.equal(pickNextCell(c).trade, 'plumbers')
})

test('pickNextCell returns null when every cell is exhausted', () => {
  const c = cells([
    { trade: 'roofers', town: 'Milford', state: 'CT', exhausted_at: '2026-08-01' },
    { trade: 'plumbers', town: 'Milford', state: 'CT', exhausted_at: '2026-08-02' },
  ])
  assert.equal(pickNextCell(c), null)
})

test('a run of entirely known place ids exhausts the cell, and it is never picked again', () => {
  const cell = cells([{ trade: 'roofers', town: 'Milford', state: 'CT' }])[0]
  const results = Array.from({ length: 20 }, (_, i) => ({ place_id: `p${i}`, known: true }))
  const after = evaluateRun(cell, results, new Date('2026-08-30'))
  assert.ok(after.exhausted_at, 'cell not marked exhausted')
  assert.equal(after.new_rows_last_run, 0)
  assert.equal(pickNextCell([after]), null)
})

test('exactly ninety percent known is not yet exhausted', () => {
  const cell = cells([{ trade: 'roofers', town: 'Milford', state: 'CT' }])[0]
  const results = Array.from({ length: 10 }, (_, i) => ({ place_id: `p${i}`, known: i < 9 }))
  assert.equal(evaluateRun(cell, results).exhausted_at, null)
  const harder = Array.from({ length: 20 }, (_, i) => ({ place_id: `p${i}`, known: i < 19 }))
  assert.ok(evaluateRun(cell, harder).exhausted_at)
})

test('an already-exhausted cell keeps its original exhaustion timestamp', () => {
  const cell = { trade: 'roofers', town: 'Milford', state: 'CT', exhausted_at: '2026-01-01' }
  assert.equal(evaluateRun(cell, [{ place_id: 'p', known: true }]).exhausted_at, '2026-01-01')
})

// --- jobs/source.mjs -------------------------------------------------------

function harness({ budget = { remaining: 500 }, results = [], known = [], cellRows } = {}) {
  const events = []
  const inserted = []
  const saved = []
  let placesCalls = 0
  return {
    events, inserted, saved, get placesCalls() { return placesCalls },
    deps: {
      sql: {},
      db: {
        logEvent: (_s, job, kind, detail) => events.push({ job, kind, detail }),
        businessByPlaceId: async (_s, id) => (known.includes(id) ? [{ id }] : []),
        insertBusinesses: async (_s, rows) => { inserted.push(...rows); return rows },
      },
      places: { search: async () => { placesCalls++; return results } },
      readBudget: async () => {
        if (budget instanceof Error) throw budget
        return budget
      },
      loadCells: async () => cellRows ?? cells([{ trade: 'roofers', town: 'Milford', state: 'CT' }]),
      saveCell: async (c) => saved.push(c),
      now: new Date('2026-08-30T13:00:00Z'),
    },
  }
}

test('a budget below the required allowance never calls Places and writes a skipped event', async () => {
  const h = harness({ budget: { remaining: 5 } })
  const out = await source(h.deps)
  assert.equal(h.placesCalls, 0)
  assert.equal(out.skipped, 'budget')
  assert.deepEqual(h.events.map((e) => e.kind), ['skipped'])
})

test('a budget that cannot be read never spends', async () => {
  const h = harness({ budget: new Error('monitoring unreachable') })
  await source(h.deps)
  assert.equal(h.placesCalls, 0)
  assert.equal(h.events[0].kind, 'skipped')
  assert.match(h.events[0].detail.reason, /unreadable/)
})

test('inserted rows carry place_id, source_query and stage sourced', async () => {
  const h = harness({ results: [{ place_id: 'p1', name: 'Acme Roofing', phone: '555-0100' }] })
  await source(h.deps)
  assert.equal(h.inserted.length, 1)
  assert.equal(h.inserted[0].place_id, 'p1')
  assert.equal(h.inserted[0].source_query, 'roofers in Milford CT')
  assert.equal(h.inserted[0].stage, 'sourced')
  assert.equal(h.inserted[0].town, 'Milford')
})

test('a website URL is stored as a bare hostname, and no website as null', async () => {
  const h = harness({
    results: [
      { place_id: 'p1', name: 'Acme', website: 'https://www.acme.com/roofing?x=1' },
      { place_id: 'p2', name: 'No Site' },
    ],
  })
  await source(h.deps)
  assert.deepEqual(h.inserted.map((r) => r.domain), ['acme.com', null])
})

test('a place_id already in the database is not inserted again', async () => {
  const h = harness({
    results: [{ place_id: 'p1', name: 'Known' }, { place_id: 'p2', name: 'New' }],
    known: ['p1'],
  })
  await source(h.deps)
  assert.deepEqual(h.inserted.map((r) => r.place_id), ['p2'])
})

test('a place_id repeated within one page is inserted once', async () => {
  const h = harness({ results: [{ place_id: 'p1', name: 'A' }, { place_id: 'p1', name: 'A' }] })
  await source(h.deps)
  assert.equal(h.inserted.length, 1)
})

test('an all-known run marks the cell exhausted on the saved row', async () => {
  const results = Array.from({ length: 20 }, (_, i) => ({ place_id: `p${i}`, name: `b${i}` }))
  const h = harness({ results, known: results.map((r) => r.place_id) })
  await source(h.deps)
  assert.equal(h.inserted.length, 0)
  assert.ok(h.saved[0].exhausted_at)
  assert.equal(h.events.at(-1).detail.exhausted, true)
})

test('an exhausted grid writes a skipped event and calls nothing', async () => {
  const h = harness({ cellRows: cells([{ trade: 'roofers', town: 'Milford', state: 'CT', exhausted_at: '2026-01-01' }]) })
  const out = await source(h.deps)
  assert.equal(out.skipped, 'exhausted')
  assert.equal(h.placesCalls, 0)
})

test('a cell outside the grid is refused, never searched', async () => {
  const h = harness({ cellRows: cells([{ trade: 'dentists', town: 'Boston', state: 'MA' }]) })
  await assert.rejects(source(h.deps), /not in the grid/)
  assert.equal(h.placesCalls, 0)
})

test('every run writes an events row', async () => {
  const h = harness({ results: [{ place_id: 'p1', name: 'Acme' }] })
  await source(h.deps)
  assert.ok(h.events.length >= 1)
  assert.equal(h.events.at(-1).job, 'source')
})

test('cellQuery renders the literal Places search string', () => {
  assert.equal(cellQuery({ trade: 'plumbers', town: 'Providence', state: 'RI' }), 'plumbers in Providence RI')
})
