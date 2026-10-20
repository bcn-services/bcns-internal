// The search grid: every category-by-town pair this pipeline is allowed to
// source from. It is data this repo owns. A job may only ever run a cell that
// is already in here — nothing invents a category or a town at runtime.
//
// Niche (2026-10-20): professional-service firms and online small businesses,
// on the East and West coasts (CT, NYC, CA first). Local trades, food, personal
// care, health and auto are out: bcns Connect connects systems a business
// already runs (CRM, billing, store, inbox), and a single-tool or
// paper-and-phone operator has nothing for it to connect.
//
// The export name `TRADES` stayed from when these were literal trades; treat it
// as "categories". Array order is priority order for both TRADES and TOWNS —
// see pickNextCell. Adding a town or category is a one-line edit here, not a
// code change — new cells insert into `search_grid` on conflict do nothing
// (lib/db.mjs `upsertCells`), so existing run state survives. Removing one
// leaves its old `search_grid` rows behind; pickNextCell ignores them.

export const TRADES = [
  // professional services — CRM, billing, e-signature, practice management
  'accountants',
  'bookkeepers',
  'tax preparers',
  'insurance agents',
  'financial advisors',
  'law firms',
  'business lawyers',
  'estate planning lawyers',
  'marketing agencies',
  'advertising agencies',
  'web design agencies',
  'IT support companies',
  'consulting firms',
  'staffing agencies',
  'recruiting firms',
  'payroll services',
  'architecture firms',
  'engineering firms',
  'interior design firms',
  'real estate brokerages',
  'property management',
  // online small businesses — storefront, inventory, fulfillment, email, ads
  'online store',
  'ecommerce company',
  'boutiques',
  'gift shops',
  'specialty food shops',
  'jewelry stores',
  'furniture stores',
  'clothing stores',
  'bike shops',
  'print shops',
  'wholesale distributors',
  'subscription box company',
]

export const TOWNS = [
  // original 8
  { town: 'Milford', state: 'CT' },
  { town: 'Stratford', state: 'CT' },
  { town: 'Shelton', state: 'CT' },
  { town: 'Orange', state: 'CT' },
  { town: 'West Haven', state: 'CT' },
  { town: 'Fairfield', state: 'CT' },
  { town: 'Bridgeport', state: 'CT' },
  { town: 'Providence', state: 'RI' },
  // Fairfield County CT
  { town: 'Norwalk', state: 'CT' },
  { town: 'Stamford', state: 'CT' },
  { town: 'Danbury', state: 'CT' },
  { town: 'Westport', state: 'CT' },
  { town: 'Trumbull', state: 'CT' },
  { town: 'Monroe', state: 'CT' },
  { town: 'Newtown', state: 'CT' },
  { town: 'Greenwich', state: 'CT' },
  { town: 'Darien', state: 'CT' },
  { town: 'New Canaan', state: 'CT' },
  { town: 'Wilton', state: 'CT' },
  { town: 'Ridgefield', state: 'CT' },
  { town: 'Easton', state: 'CT' },
  { town: 'Weston', state: 'CT' },
  { town: 'Redding', state: 'CT' },
  { town: 'Bethel', state: 'CT' },
  { town: 'Brookfield', state: 'CT' },
  { town: 'New Fairfield', state: 'CT' },
  { town: 'Sherman', state: 'CT' },
  // New Haven County CT
  { town: 'New Haven', state: 'CT' },
  { town: 'Hamden', state: 'CT' },
  { town: 'North Haven', state: 'CT' },
  { town: 'East Haven', state: 'CT' },
  { town: 'Branford', state: 'CT' },
  { town: 'Guilford', state: 'CT' },
  { town: 'Madison', state: 'CT' },
  { town: 'Wallingford', state: 'CT' },
  { town: 'Meriden', state: 'CT' },
  { town: 'Cheshire', state: 'CT' },
  { town: 'Derby', state: 'CT' },
  { town: 'Ansonia', state: 'CT' },
  { town: 'Seymour', state: 'CT' },
  { town: 'Naugatuck', state: 'CT' },
  { town: 'Waterbury', state: 'CT' },
  { town: 'Woodbridge', state: 'CT' },
  // Providence RI metro
  { town: 'Cranston', state: 'RI' },
  { town: 'Warwick', state: 'RI' },
  { town: 'Pawtucket', state: 'RI' },
  { town: 'East Providence', state: 'RI' },
  { town: 'North Providence', state: 'RI' },
  { town: 'Johnston', state: 'RI' },
  // NYC metro
  { town: 'New York', state: 'NY' },
  { town: 'Brooklyn', state: 'NY' },
  { town: 'Queens', state: 'NY' },
  { town: 'Bronx', state: 'NY' },
  { town: 'Staten Island', state: 'NY' },
  { town: 'Garden City', state: 'NY' },
  { town: 'Huntington', state: 'NY' },
  { town: 'White Plains', state: 'NY' },
  { town: 'Jersey City', state: 'NJ' },
  { town: 'Hoboken', state: 'NJ' },
  { town: 'Hackensack', state: 'NJ' },
  { town: 'Newark', state: 'NJ' },
  // California metros
  { town: 'Los Angeles', state: 'CA' },
  { town: 'San Francisco', state: 'CA' },
  { town: 'Oakland', state: 'CA' },
  { town: 'San Jose', state: 'CA' },
  { town: 'San Diego', state: 'CA' },
  { town: 'Sacramento', state: 'CA' },
  { town: 'Santa Monica', state: 'CA' },
  { town: 'Pasadena', state: 'CA' },
  { town: 'Irvine', state: 'CA' },
  { town: 'Long Beach', state: 'CA' },
  { town: 'Palo Alto', state: 'CA' },
  { town: 'Berkeley', state: 'CA' },
  // other coastal metros
  { town: 'Boston', state: 'MA' },
  { town: 'Philadelphia', state: 'PA' },
  { town: 'Washington', state: 'DC' },
  { town: 'Miami', state: 'FL' },
  { town: 'Seattle', state: 'WA' },
  { town: 'Portland', state: 'OR' },
]

export const GRID = TRADES.flatMap((trade) =>
  TOWNS.map(({ town, state }) => ({ trade, town, state }))
)

export function cellQuery(cell) {
  return `${cell.trade} in ${cell.town} ${cell.state}`
}

const key = (c) => `${c.trade}|${c.town}|${c.state}`
const KNOWN = new Set(GRID.map(key))
const TRADE_RANK = new Map(TRADES.map((t, i) => [t, i]))
const TOWN_RANK = new Map(TOWNS.map((t, i) => [`${t.town}|${t.state}`, i]))

export function isKnownCell(cell) {
  return KNOWN.has(key(cell))
}

// The least recently run cell that is not exhausted. A cell that has never run
// is the stalest thing there is, so it sorts first; among never-run cells (or
// equal timestamps), ties break by category priority (position in TRADES), then
// town priority (position in TOWNS, so CT/RI before NYC before CA), so the grid
// actually sources its priority cells instead of whatever order the database
// returns. Rows whose trade/town is no longer in GRID (a removed category left
// behind in search_grid) are ignored — source would otherwise throw on them.
// Null when no in-grid cell is live — the caller stops rather than picking an
// exhausted one anyway.
export function pickNextCell(cells) {
  const live = cells.filter((c) => !c.exhausted_at && isKnownCell(c))
  if (!live.length) return null
  const rank = (c) => TRADE_RANK.get(c.trade) * TOWNS.length + TOWN_RANK.get(`${c.town}|${c.state}`)
  return live.reduce((oldest, c) => {
    const a = c.last_run_at ? new Date(c.last_run_at).getTime() : -Infinity
    const b = oldest.last_run_at ? new Date(oldest.last_run_at).getTime() : -Infinity
    if (a !== b) return a < b ? c : oldest
    return rank(c) < rank(oldest) ? c : oldest
  })
}

export const EXHAUSTED_RATIO = 0.9

// A run that comes back almost entirely already-known place ids means Places
// has nothing new left in that cell; keep asking and every daily run spends
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
