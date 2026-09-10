// Daily sourcing. Works through up to `cellsPerRun` grid cells, paging each
// one up to MAX_PAGES times, and inserts the businesses that are not already
// known.
//
// Budget first, always. The free Places allowance is 1,000 calls a month and
// the cap is set below it; a run that cannot read the budget must not spend,
// because the failure mode of guessing is a bill. Budget is re-checked before
// EVERY page (not once per run) since a multi-cell, multi-page run can spend
// a lot of budget between the first check and the last page.

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
export const MAX_PAGES = 3
export const CELLS_PER_RUN = 2

export async function run({
  sql,
  db,
  places,
  readBudget,
  loadCells,
  saveCell,
  now = new Date(),
  minRemaining = MIN_REMAINING,
  cellsPerRun = CELLS_PER_RUN,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'source', kind, detail)

  const cells = await loadCells()
  const cellsRun = []
  let totalInserted = 0
  let budgetExhausted = false

  for (let i = 0; i < cellsPerRun; i++) {
    // Pick from the local, possibly-already-mutated cell list so a cell just
    // saved this run is never picked again.
    const cell = pickNextCell(cells)
    if (!cell) {
      if (!cellsRun.length) await log('skipped', { reason: 'every grid cell is exhausted' })
      break
    }
    if (!isKnownCell(cell)) {
      await log('error', { reason: 'cell is not in the grid', cell })
      throw new Error(`cell ${JSON.stringify(cell)} is not in the grid`)
    }

    const query = cellQuery(cell)
    const combined = []
    let pageToken
    let fetched = 0

    for (let page = 0; page < MAX_PAGES; page++) {
      let budget
      try {
        budget = await readBudget()
      } catch (err) {
        await log('skipped', { reason: 'budget unreadable', error: String(err?.message ?? err) })
        return { cells: cellsRun, inserted: totalInserted, skipped: 'budget-unreadable' }
      }

      const remaining = budget?.remaining ?? 0
      if (remaining < minRemaining) {
        await log('skipped', { reason: 'budget exhausted', remaining, minRemaining, cell, page })
        budgetExhausted = true
        break
      }

      // One bad page is not a lost day: keep what earlier pages paid for, and
      // let the rest of the tick (qualify, promotion, heartbeat) still run.
      let res
      try {
        res = await places.search(query, { pageToken })
      } catch (err) {
        await log('error', { reason: 'places search failed', query, page, error: String(err?.message ?? err) })
        break
      }
      fetched++
      combined.push(...res.results)
      if (!res.nextPageToken) break
      pageToken = res.nextPageToken
    }

    // Nothing fetched (budget cut or a failed first page): leave the cell's
    // run state alone so it is retried, and stop if the budget is the reason.
    if (!fetched) {
      if (budgetExhausted) break
      continue
    }

    // Dedupe before writing: a place_id already in the database is not a new
    // business, and re-inserting it would collide with the unique index anyway.
    const seen = new Set()
    const marked = []
    for (const r of combined) {
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
    totalInserted += rows.length

    // Mutate the local list so the next pick in this loop sees this cell's
    // fresh last_run_at/exhausted_at instead of re-picking it.
    const idx = cells.findIndex((c) => c.trade === cell.trade && c.town === cell.town && c.state === cell.state)
    if (idx >= 0) cells[idx] = updated
    else cells.push(updated)

    await log('sourced', {
      query,
      returned: marked.length,
      inserted: inserted.length ?? rows.length,
      exhausted: Boolean(updated.exhausted_at),
    })

    cellsRun.push(updated)
    if (budgetExhausted) break
  }

  return { cells: cellsRun, inserted: totalInserted }
}
