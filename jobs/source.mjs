// Weekly sourcing. Picks one grid cell, searches it on Places, and inserts the
// businesses that are not already known.
//
// Budget first, always. The free Places allowance is 1,000 calls a month and
// the cap is set below it; a run that cannot read the budget must not spend,
// because the failure mode of guessing is a bill.

import { pickNextCell, evaluateRun, cellQuery, isKnownCell } from '../lib/grid.mjs'

// Places returns a full website URL; `businesses` stores a hostname, which is
// what every later stage (email guessing, dedupe) actually matches on.
function hostname(website) {
  try {
    return new URL(website).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export const MIN_REMAINING = 20 // one page of results is one call per 20 rows

export async function run({
  sql,
  db,
  places,
  readBudget,
  loadCells,
  saveCell,
  now = new Date(),
  minRemaining = MIN_REMAINING,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'source', kind, detail)

  let budget
  try {
    budget = await readBudget()
  } catch (err) {
    await log('skipped', { reason: 'budget unreadable', error: String(err?.message ?? err) })
    return { skipped: 'budget-unreadable' }
  }

  const remaining = budget?.remaining ?? 0
  if (remaining < minRemaining) {
    await log('skipped', { reason: 'budget exhausted', remaining, minRemaining })
    return { skipped: 'budget', remaining }
  }

  const cells = await loadCells()
  const cell = pickNextCell(cells)
  if (!cell) {
    await log('skipped', { reason: 'every grid cell is exhausted' })
    return { skipped: 'exhausted' }
  }
  if (!isKnownCell(cell)) {
    await log('error', { reason: 'cell is not in the grid', cell })
    throw new Error(`cell ${JSON.stringify(cell)} is not in the grid`)
  }

  const query = cellQuery(cell)
  const results = await places.search(query)

  // Dedupe before writing: a place_id already in the database is not a new
  // business, and re-inserting it would collide with the unique index anyway.
  const seen = new Set()
  const marked = []
  for (const r of results) {
    if (seen.has(r.place_id)) continue
    seen.add(r.place_id)
    const existing = await db.businessByPlaceId(sql, r.place_id)
    marked.push({ ...r, known: existing.length > 0 })
  }

  const rows = marked
    .filter((r) => !r.known)
    .map((r) => ({
      name: r.name,
      domain: hostname(r.website),
      phone: r.phone ?? null,
      address: r.address ?? null,
      town: cell.town,
      state: cell.state,
      trade: cell.trade,
      place_id: r.place_id,
      source_query: query,
      stage: 'sourced',
      // The pitch skill's facts contract names these two; qualify merges
      // its own keys in on top rather than replacing the blob.
      research: JSON.stringify({ rating: r.rating ?? null, review_count: r.review_count ?? null }),
    }))

  const inserted = rows.length ? await db.insertBusinesses(sql, rows) : []
  const updated = evaluateRun(cell, marked, now)
  await saveCell(updated)

  await log('sourced', {
    query,
    returned: marked.length,
    inserted: inserted.length ?? rows.length,
    exhausted: Boolean(updated.exhausted_at),
    remaining,
  })

  return { query, returned: marked.length, inserted: rows.length, cell: updated }
}
