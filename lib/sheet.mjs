// The Cold Call Tracker's `Leads` tab, over Sheets REST v4 with the keyless
// token clock.yml mints (GOOGLE_OAUTH_ACCESS_TOKEN, spreadsheets scope). The
// sheet is shared with that service account. Port of the Mac-side
// ~/os/skills/leads/sheets.py `pull` (COLUMNS, dedupe, map_row).

// The sheet's column order. Appending a column is safe; reordering or renaming
// is not -- every existing row would shift under it. Keep in step with sheets.py.
export const COLUMNS = [
  'place_id', 'business_name', 'type', 'city', 'phone', 'website',
  'has_website', 'rating', 'review_count',
  'lead_score', 'score_reason',
  'status', 'call_count', 'last_contact', 'contact_name', 'last_outcome',
  'consult_date', 'close_date', 'deal_value',
  'source_query', 'date_added', 'notes',
]

// A sortRows() entry -> one sheet row, in COLUMNS order. lead_score stays blank
// on purpose: fit is the pipeline's judgment, so it goes in notes.
export function mapRow({ row, research = {} }, today) {
  const n = Number(research.fit_score)
  const fit = research.fit_score == null || research.fit_score === '' || Number.isNaN(n) ? research.fit : n
  const notes = [fit != null && fit !== '' && `fit ${fit}`, research.reason].filter(Boolean).join(' — ')
  const r = {
    // place_id can be null in the pipeline; a blank id would re-append daily.
    place_id: row.place_id || `pipeline:${row.id}`,
    business_name: row.name, type: row.trade, city: row.town,
    phone: row.phone, website: row.domain,
    has_website: row.domain ? 'yes' : 'no',
    status: 'new', source_query: row.source_query || '',
    date_added: today, notes,
  }
  return COLUMNS.map((c) => r[c] ?? '')
}

// Drop rows whose place_id (column A) is already in the sheet, and dupes
// within the batch. Order preserved.
export function dedupe(existingIds, rows) {
  const seen = new Set(existingIds)
  return rows.filter((r) => !seen.has(r[0]) && seen.add(r[0]))
}

export function createSheet({ token, sheetId, fetch = globalThis.fetch }) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/`
  const call = async (url, init = {}) => {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(`sheets ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`)
    }
    return res.json()
  }
  return {
    async placeIds() {
      const { values = [] } = await call(base + encodeURIComponent('Leads!A2:A'))
      return values.map((v) => v[0]).filter(Boolean)
    },
    // RAW, not USER_ENTERED: names and sites come from Places and the web, and
    // a cell starting `=` must stay text, never run as a formula.
    append(values) {
      return call(`${base}${encodeURIComponent('Leads!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: JSON.stringify({ values }),
      })
    },
  }
}
