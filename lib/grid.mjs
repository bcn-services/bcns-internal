// The search grid: every category-by-town pair this pipeline is allowed to
// source from. It is data this repo owns. A job may only ever run a cell that
// is already in here — nothing invents a category or a town at runtime.
//
// `TRADES` started as literal trades and has grown to cover every local
// small-business category worth cold-pitching — trades, personal care,
// health, professional services, food, retail, and events. The export name
// stayed `TRADES` to avoid a churn-only rename across grid/source/qualify;
// treat it as "categories".
//
// Array order is priority order: pickNextCell sources earlier categories
// first. As of 2026-09-15 the pipeline is repointed toward businesses that
// tend to run on a pile of disconnected online tools (retail, food,
// personal care, services) and away from trades/contractors/auto, which
// are pushed to the bottom.
//
// Towns cover Fairfield County CT, New Haven County CT, and the Providence RI
// metro. Adding a town or category is a one-line edit here, not a code
// change — new cells insert into `search_grid` on conflict do nothing
// (lib/db.mjs `upsertCells`), so existing run state for every other cell
// survives.

export const TRADES = [
  // food — juggle POS, reservations, delivery apps, reviews, social
  'restaurants',
  'cafes',
  'bakeries',
  'caterers',
  // retail — POS, inventory, e-commerce, loyalty, social
  'florists',
  'boutiques',
  'gift shops',
  'hardware stores',
  'bike shops',
  // personal care — booking apps, POS, memberships, social
  'hair salons',
  'barbershops',
  'nail salons',
  'day spas',
  'med spas',
  'massage',
  'tattoo studios',
  'gyms',
  'yoga studios',
  'pilates',
  'martial arts',
  'personal trainers',
  // pets
  'dog groomers',
  'dog trainers',
  'dog daycare',
  'pet sitters',
  // health — scheduling, EHR/records, insurance/billing systems
  'chiropractors',
  'physical therapy',
  'dentists',
  'optometrists',
  // professional services — CRM, e-signature, case/practice management
  'accountants',
  'bookkeepers',
  'tax preparers',
  'insurance agents',
  'property management',
  'real estate brokerages',
  'home inspectors',
  'estate planning lawyers',
  'family lawyers',
  'real estate lawyers',
  // events — bookings, galleries, contracts, social
  'photographers',
  'DJs',
  'wedding venues',
  'event planners',
  'print shops',
  // trades / home services — deprioritized, simpler tool stacks
  'roofers',
  'plumbers',
  'HVAC',
  'electricians',
  'landscapers',
  'painters',
  'auto detailing',
  'general contractors',
  'tree service',
  'masonry',
  'fencing',
  'paving',
  'deck builders',
  'flooring',
  'garage doors',
  'kitchen and bath remodelers',
  'window installers',
  'handyman',
  'pest control',
  'pool service',
  'pressure washing',
  'gutter cleaning',
  'snow removal',
  'house cleaning',
  'commercial cleaning',
  'carpet cleaning',
  'movers',
  'junk removal',
  // auto — deprioritized
  'auto repair',
  'auto body shops',
  'tire shops',
  'towing',
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
// is the stalest thing there is, so it sorts first; among never-run cells,
// ties break by category priority (position in TRADES above) so a repointed
// grid actually sources the new priority categories instead of whatever order
// the database happens to return. Null when every cell is exhausted — the
// caller stops rather than picking an exhausted one anyway.
export function pickNextCell(cells) {
  const live = cells.filter((c) => !c.exhausted_at)
  if (!live.length) return null
  return live.reduce((oldest, c) => {
    const a = c.last_run_at ? new Date(c.last_run_at).getTime() : -Infinity
    const b = oldest.last_run_at ? new Date(oldest.last_run_at).getTime() : -Infinity
    if (a !== b) return a < b ? c : oldest
    return TRADES.indexOf(c.trade) < TRADES.indexOf(oldest.trade) ? c : oldest
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
