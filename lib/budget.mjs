// Month-to-date Places spend, asked of Google rather than tallied locally: a
// local counter only knows about one machine and this project is shared.
//
// Fails closed. Every path that cannot establish real usage throws, because a
// readBudget that guesses a number is a bill.

export const DEFAULT_CAP = 950
const FILTER =
  'metric.type="serviceruntime.googleapis.com/api/request_count" ' +
  'AND resource.labels.service="places.googleapis.com"'

const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

export function createReadBudget({
  token,
  project,
  cap = DEFAULT_CAP,
  fetch = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  if (!token) throw new Error('createReadBudget needs an access token')
  if (!project) throw new Error('createReadBudget needs a project')

  return async function readBudget() {
    const end = now()
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`)
    for (const [k, v] of Object.entries({
      filter: FILTER,
      'interval.startTime': stamp(start),
      'interval.endTime': stamp(end),
      'aggregation.alignmentPeriod': '86400s',
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    })) url.searchParams.set(k, v)

    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': project },
    })
    if (!res.ok) {
      throw new Error(`cannot read usage (${res.status}): ${String(await res.text()).slice(0, 300)}`)
    }
    const used = sumPoints(await res.json())
    return { remaining: Math.max(0, cap - used), month: stamp(start).slice(0, 7), used, cap }
  }
}

// An absent timeSeries is a real answer — no calls made yet this month. A
// present-but-unreadable one is not, and must never round down to zero.
function sumPoints(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('malformed usage response: not an object')
  }
  const series = body.timeSeries ?? []
  if (!Array.isArray(series)) throw new Error('malformed usage response: timeSeries is not a list')
  let total = 0
  for (const s of series) {
    for (const p of s?.points ?? []) {
      const v = p?.value ?? {}
      const n = Number(v.int64Value ?? v.doubleValue)
      if (!Number.isFinite(n)) throw new Error('malformed usage response: point has no numeric value')
      total += n
    }
  }
  return total
}
