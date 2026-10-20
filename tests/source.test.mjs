import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GRID, TRADES, TOWNS, pickNextCell, evaluateRun, cellQuery, isKnownCell } from '../lib/grid.mjs'
import { run as source } from '../jobs/source.mjs'

const cells = (rows) => rows.map((r) => ({ exhausted_at: null, last_run_at: null, ...r }))

test('the grid is every trade by every town, and nothing else', () => {
  assert.equal(TRADES.length, 33)
  assert.equal(TOWNS.length, 79)
  assert.equal(GRID.length, 2607)
  assert.equal(GRID.length, TRADES.length * TOWNS.length)
  assert.ok(isKnownCell({ trade: 'accountants', town: 'Milford', state: 'CT' }))
  assert.ok(isKnownCell({ trade: 'law firms', town: 'Norwalk', state: 'CT' }))
  assert.ok(isKnownCell({ trade: 'online store', town: 'Los Angeles', state: 'CA' }))
  assert.ok(isKnownCell({ trade: 'marketing agencies', town: 'Brooklyn', state: 'NY' }))
  assert.ok(isKnownCell({ trade: 'accountants', town: 'Boston', state: 'MA' }))
  // Out of the niche: removed categories are not in the grid.
  assert.ok(!isKnownCell({ trade: 'roofers', town: 'Milford', state: 'CT' }))
  assert.ok(!isKnownCell({ trade: 'restaurants', town: 'Milford', state: 'CT' }))
  assert.ok(!isKnownCell({ trade: 'accountants', town: 'Boston', state: 'CT' }))
  assert.ok(!isKnownCell({ trade: 'dentists in space', town: 'Milford', state: 'CT' }))
})

test('categories and towns are pinned in priority order', () => {
  assert.deepEqual(TRADES.slice(0, 3), ['accountants', 'bookkeepers', 'tax preparers'])
  assert.equal(TRADES[20], 'property management')
  assert.equal(TRADES[21], 'online store')
  assert.equal(TRADES.at(-1), 'subscription box company')
  assert.deepEqual(TOWNS[0], { town: 'Milford', state: 'CT' })
  assert.deepEqual(TOWNS[48], { town: 'Johnston', state: 'RI' })
  assert.deepEqual(TOWNS[49], { town: 'New York', state: 'NY' })
  assert.deepEqual(TOWNS[61], { town: 'Los Angeles', state: 'CA' })
  assert.deepEqual(TOWNS.at(-1), { town: 'Portland', state: 'OR' })
})

test('every grid cell is unique', () => {
  const keys = new Set(GRID.map((c) => `${c.trade}|${c.town}|${c.state}`))
  assert.equal(keys.size, GRID.length)
})

test('pickNextCell returns the least recently run unexhausted cell', () => {
  const c = cells([
    { trade: 'accountants', town: 'Milford', state: 'CT', last_run_at: '2026-08-20' },
    { trade: 'bookkeepers', town: 'Milford', state: 'CT', last_run_at: '2026-08-01' },
    { trade: 'tax preparers', town: 'Milford', state: 'CT', last_run_at: '2026-08-10' },
  ])
  assert.equal(pickNextCell(c).trade, 'bookkeepers')
})

test('a never-run cell outranks every cell that has run', () => {
  const c = cells([
    { trade: 'accountants', town: 'Milford', state: 'CT', last_run_at: '2020-01-01' },
    { trade: 'bookkeepers', town: 'Milford', state: 'CT' },
  ])
  assert.equal(pickNextCell(c).trade, 'bookkeepers')
})

test('stale removed-category row with the oldest last_run_at is skipped; next in-grid cell wins', () => {
  const c = cells([
    { trade: 'roofers', town: 'Milford', state: 'CT', last_run_at: '2019-01-01' },
    { trade: 'accountants', town: 'Milford', state: 'CT', last_run_at: '2026-08-20' },
    { trade: 'bookkeepers', town: 'Milford', state: 'CT', last_run_at: '2026-08-01' },
  ])
  assert.equal(pickNextCell(c).trade, 'bookkeepers')
  assert.equal(pickNextCell(cells([{ trade: 'roofers', town: 'Milford', state: 'CT' }])), null)
})

test('among never-run cells, trade order then town order decide; CT before NYC before CA', () => {
  const never = (trade, town, state) => ({ trade, town, state })
  // trade priority wins over town priority
  assert.equal(
    pickNextCell(cells([never('bookkeepers', 'Milford', 'CT'), never('accountants', 'Los Angeles', 'CA')])).trade,
    'accountants'
  )
  // same trade: CT beats NYC beats CA regardless of input order
  const same = cells([
    never('accountants', 'Los Angeles', 'CA'),
    never('accountants', 'Brooklyn', 'NY'),
    never('accountants', 'Norwalk', 'CT'),
  ])
  assert.equal(pickNextCell(same).town, 'Norwalk')
  assert.equal(pickNextCell(same.filter((x) => x.state !== 'CT')).town, 'Brooklyn')
  // a run cell is still younger than any never-run cell
  assert.equal(
    pickNextCell(cells([never('accountants', 'Milford', 'CT'), never('law firms', 'Boston', 'MA')].map((x, i) => (i ? x : { ...x, last_run_at: '2026-01-01' })))).trade,
    'law firms'
  )
})

test('pickNextCell returns null when every cell is exhausted', () => {
  const c = cells([
    { trade: 'accountants', town: 'Milford', state: 'CT', exhausted_at: '2026-08-01' },
    { trade: 'bookkeepers', town: 'Milford', state: 'CT', exhausted_at: '2026-08-02' },
  ])
  assert.equal(pickNextCell(c), null)
})

test('a run of entirely known place ids exhausts the cell, and it is never picked again', () => {
  const cell = cells([{ trade: 'accountants', town: 'Milford', state: 'CT' }])[0]
  const results = Array.from({ length: 20 }, (_, i) => ({ place_id: `p${i}`, known: true }))
  const after = evaluateRun(cell, results, new Date('2026-08-30'))
  assert.ok(after.exhausted_at, 'cell not marked exhausted')
  assert.equal(after.new_rows_last_run, 0)
  assert.equal(pickNextCell([after]), null)
})

test('exactly ninety percent known is not yet exhausted', () => {
  const cell = cells([{ trade: 'accountants', town: 'Milford', state: 'CT' }])[0]
  const results = Array.from({ length: 10 }, (_, i) => ({ place_id: `p${i}`, known: i < 9 }))
  assert.equal(evaluateRun(cell, results).exhausted_at, null)
  const harder = Array.from({ length: 20 }, (_, i) => ({ place_id: `p${i}`, known: i < 19 }))
  assert.ok(evaluateRun(cell, harder).exhausted_at)
})

test('an already-exhausted cell keeps its original exhaustion timestamp', () => {
  const cell = { trade: 'accountants', town: 'Milford', state: 'CT', exhausted_at: '2026-01-01' }
  assert.equal(evaluateRun(cell, [{ place_id: 'p', known: true }]).exhausted_at, '2026-01-01')
})

// --- jobs/source.mjs -------------------------------------------------------

// `pages`, when given, is the sequence of `{results, nextPageToken}` handed
// back on successive `places.search` calls (across every cell in the run, in
// call order) — the last entry repeats once exhausted. `results` is a
// shorthand for a single always-final page, used by most tests here.
// `budgets`, when given, is the same kind of sequence for `readBudget`.
function harness({
  budget = { remaining: 500 },
  budgets,
  results = [],
  pages,
  known = [],
  cellRows,
  cellsPerRun = 1,
  minRemaining,
} = {}) {
  const events = []
  const inserted = []
  const saved = []
  const placesCalls = []
  const budgetCalls = []
  let pageIdx = 0
  let budgetIdx = 0
  const deps = {
    sql: {},
    db: {
      logEvent: (_s, job, kind, detail) => events.push({ job, kind, detail }),
      businessByPlaceId: async (_s, id) => (known.includes(id) ? [{ id }] : []),
      insertBusinesses: async (_s, rows) => {
        inserted.push(...rows)
        return rows
      },
    },
    places: {
      search: async (query, opts) => {
        placesCalls.push({ query, pageToken: opts?.pageToken })
        if (pages) {
          // Cycles per cell (mod length) rather than clamping to the last
          // entry, so a fixed per-cell page script replays for every cell.
          const p = pages[pageIdx % pages.length]
          pageIdx++
          return p
        }
        return { results, nextPageToken: null }
      },
    },
    readBudget: async () => {
      const b = budgets ? budgets[Math.min(budgetIdx, budgets.length - 1)] : budget
      budgetCalls.push(budgetIdx)
      budgetIdx++
      if (b instanceof Error) throw b
      return b
    },
    loadCells: async () => cellRows ?? cells([{ trade: 'accountants', town: 'Milford', state: 'CT' }]),
    saveCell: async (c) => saved.push(c),
    now: new Date('2026-08-30T13:00:00Z'),
  }
  deps.cellsPerRun = cellsPerRun
  if (minRemaining !== undefined) deps.minRemaining = minRemaining
  return { events, inserted, saved, placesCalls, budgetCalls, deps }
}

test('a budget below the required allowance never calls Places and writes a skipped event', async () => {
  const h = harness({ budget: { remaining: 5 } })
  await source(h.deps)
  assert.equal(h.placesCalls.length, 0)
  assert.deepEqual(h.events.map((e) => e.kind), ['skipped'])
  assert.match(h.events[0].detail.reason, /budget exhausted/)
})

test('a budget that cannot be read never spends', async () => {
  const h = harness({ budget: new Error('monitoring unreachable') })
  await source(h.deps)
  assert.equal(h.placesCalls.length, 0)
  assert.equal(h.events[0].kind, 'skipped')
  assert.match(h.events[0].detail.reason, /unreadable/)
})

test('inserted rows carry place_id, source_query and stage sourced', async () => {
  const h = harness({ results: [{ place_id: 'p1', name: 'Acme Roofing', phone: '555-0100' }] })
  await source(h.deps)
  assert.equal(h.inserted.length, 1)
  assert.equal(h.inserted[0].place_id, 'p1')
  assert.equal(h.inserted[0].source_query, 'accountants in Milford CT')
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
  const h = harness({
    cellRows: cells([{ trade: 'accountants', town: 'Milford', state: 'CT', exhausted_at: '2026-01-01' }]),
  })
  await source(h.deps)
  assert.equal(h.events.at(-1).kind, 'skipped')
  assert.match(h.events.at(-1).detail.reason, /exhausted/)
  assert.equal(h.placesCalls.length, 0)
})

test('a stale row outside the grid is skipped, never searched, never thrown on', async () => {
  const h = harness({
    cellRows: cells([
      { trade: 'roofers', town: 'Milford', state: 'CT', last_run_at: '2020-01-01' },
      { trade: 'dentists', town: 'Boston', state: 'MA' },
      { trade: 'bookkeepers', town: 'Milford', state: 'CT', last_run_at: '2026-08-01' },
    ]),
  })
  await source({ ...h.deps, cellsPerRun: 1 })
  assert.equal(h.saved.length, 1)
  assert.equal(h.saved[0].trade, 'bookkeepers')
  assert.equal(h.placesCalls[0].query, 'bookkeepers in Milford CT')
})

test('a grid holding only stale rows skips cleanly', async () => {
  const h = harness({ cellRows: cells([{ trade: 'roofers', town: 'Milford', state: 'CT' }]) })
  await source(h.deps)
  assert.equal(h.events.at(-1).kind, 'skipped')
  assert.equal(h.placesCalls.length, 0)
})

test('every run writes an events row', async () => {
  const h = harness({ results: [{ place_id: 'p1', name: 'Acme' }] })
  await source(h.deps)
  assert.ok(h.events.length >= 1)
  assert.equal(h.events.at(-1).job, 'source')
})

test('cellQuery renders the literal Places search string', () => {
  assert.equal(cellQuery({ trade: 'bookkeepers', town: 'Providence', state: 'RI' }), 'bookkeepers in Providence RI')
})

// --- multi-cell, multi-page, per-page budget checks -------------------------

test('two cells at three pages each make exactly six Places calls, with the budget read before every one', async () => {
  const h = harness({
    cellsPerRun: 2,
    cellRows: cells([
      { trade: 'accountants', town: 'Milford', state: 'CT' },
      { trade: 'bookkeepers', town: 'Milford', state: 'CT' },
    ]),
    budget: { remaining: 500 },
    // Every page but the last of each cell says there is another page; the
    // third is taken (MAX_PAGES=3) and only then does paging stop.
    pages: [
      { results: [], nextPageToken: 't1' },
      { results: [], nextPageToken: 't2' },
      { results: [], nextPageToken: null },
    ],
  })
  const out = await source(h.deps)
  assert.equal(h.placesCalls.length, 6)
  assert.equal(h.budgetCalls.length, 6, 'readBudget must run before every page, not once per run')
  assert.equal(out.cells.length, 2)
  // Each cell gets exactly one 'sourced' event, not one per page.
  assert.equal(h.events.filter((e) => e.kind === 'sourced').length, 2)
})

test('a budget cut after paid pages still inserts what those pages returned', async () => {
  const h = harness({
    pages: [{ results: [{ place_id: 'p1', name: 'A' }], nextPageToken: 't1' }],
    budgets: [{ remaining: 500 }, { remaining: 5 }],
  })
  await source(h.deps)
  assert.equal(h.placesCalls.length, 1)
  assert.deepEqual(h.inserted.map((r) => r.place_id), ['p1'])
  assert.equal(h.saved.length, 1)
})

test('a Places error on one cell logs and moves to the next cell', async () => {
  const h = harness({
    cellsPerRun: 2,
    cellRows: cells([
      { trade: 'accountants', town: 'Milford', state: 'CT' },
      { trade: 'bookkeepers', town: 'Milford', state: 'CT' },
    ]),
    budget: { remaining: 500 },
  })
  let n = 0
  h.deps.places.search = async () => {
    if (n++ === 0) throw new Error('503')
    return { results: [{ place_id: 'p2', name: 'B' }], nextPageToken: null }
  }
  await source(h.deps)
  assert.ok(h.events.some((e) => e.kind === 'error' && /places search failed/.test(e.detail.reason)))
  assert.deepEqual(h.inserted.map((r) => r.place_id), ['p2'])
})

test('a budget that drops mid-run stops before the next page, and logs why', async () => {
  const h = harness({
    cellsPerRun: 2,
    cellRows: cells([
      { trade: 'accountants', town: 'Milford', state: 'CT' },
      { trade: 'bookkeepers', town: 'Milford', state: 'CT' },
    ]),
    pages: [
      { results: [], nextPageToken: 't1' },
      { results: [], nextPageToken: 't2' },
    ],
    // Plenty for the first two pages, then below MIN_REMAINING (20) on the
    // read that would gate the third page.
    budgets: [{ remaining: 500 }, { remaining: 500 }, { remaining: 5 }],
  })
  await source(h.deps)
  // Only the first two pages were ever fetched — the third's budget read
  // stopped the run before a third places.search call, and before the
  // second cell was ever touched.
  assert.equal(h.placesCalls.length, 2)
  // The two paid pages are kept (the cell is saved); the second cell is not.
  assert.equal(h.saved.length, 1)
  assert.equal(h.saved[0].trade, 'accountants')
  const skip = h.events.find((e) => e.kind === 'skipped')
  assert.match(skip.detail.reason, /budget exhausted/)
})
