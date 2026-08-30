// The search grid: every trade-by-town pair this pipeline is allowed to source
// from. It is data this repo owns. A job may only ever run a cell that is
// already in here — nothing invents a trade or a town at runtime.
//
// Trades and towns are the ones the `leads` skill already names. Rhode Island
// is thin on purpose: Providence is the only RI municipality that skill names.
// Adding a town is a one-line edit here, not a code change.

export const TRADES = [
  'roofers',
  'plumbers',
  'HVAC',
  'electricians',
  'landscapers',
  'painters',
  'auto detailing',
  'general contractors',
]

export const TOWNS = [
  { town: 'Milford', state: 'CT' },
  { town: 'Stratford', state: 'CT' },
  { town: 'Shelton', state: 'CT' },
  { town: 'Orange', state: 'CT' },
  { town: 'West Haven', state: 'CT' },
  { town: 'Fairfield', state: 'CT' },
  { town: 'Bridgeport', state: 'CT' },
  { town: 'Providence', state: 'RI' },
]

export const GRID = TRADES.flatMap((trade) =>
  TOWNS.map(({ town, state }) => ({ trade, town, state }))
)

export function cellQuery(cell) {
  return `${cell.trade} in ${cell.town} ${cell.state}`
}

export function isKnownCell(cell) {
  return GRID.some((c) => c.trade === cell.trade && c.town === cell.town && c.state === cell.state)
}

// The least recently run cell that is not exhausted. A cell that has never run
// is the stalest thing there is, so it sorts first. Null when every cell is
// exhausted — the caller stops rather than picking an exhausted one anyway.
export function pickNextCell(cells) {
  const live = cells.filter((c) => !c.exhausted_at)
  if (!live.length) return null
  return live.reduce((oldest, c) => {
    const a = c.last_run_at ? new Date(c.last_run_at).getTime() : -Infinity
    const b = oldest.last_run_at ? new Date(oldest.last_run_at).getTime() : -Infinity
    return a < b ? c : oldest
  })
}

export const EXHAUSTED_RATIO = 0.9

// A run that comes back almost entirely already-known place ids means Places
// has nothing new left in that cell; keep asking and every weekly run spends
// budget to rediscover the same businesses.
export function evaluateRun(cell, results, now = new Date()) {
  const total = results.length
  const known = results.filter((r) => r.known).length
  const fresh = total - known
  const exhausted = total > 0 && known / total > EXHAUSTED_RATIO
  return {
    ...cell,
    last_run_at: now,
    new_rows_last_run: fresh,
    exhausted_at: cell.exhausted_at ?? (exhausted ? now : null),
  }
}
