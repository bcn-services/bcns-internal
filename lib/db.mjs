// The only module in the repo that writes SQL.
//
// The whole system's opt-out safety rests on one invariant: every read of a
// business goes through the `selectable_businesses` view, which filters out
// rows with a `suppressed_at`. Reading `businesses` directly would silently
// mail someone who asked to be left alone. `assertSelectable` enforces that at
// runtime so a later edit cannot quietly bypass it.
//
// The Postgres client is always passed in. Nothing here opens a connection.

const DIRECT_READ = /\bfrom\s+businesses\b/i

export function assertSelectable(query) {
  if (DIRECT_READ.test(query)) {
    throw new Error(
      'read queries must target selectable_businesses, not businesses — ' +
        'reading the table directly bypasses the suppression filter'
    )
  }
  return query
}

// Wraps a postgres.js tagged-template client so every read is checked before
// it runs. Values stay parameterised; only the static text is inspected.
function read(sql) {
  return (strings, ...values) => {
    assertSelectable(strings.join(' ? '))
    return sql(strings, ...values)
  }
}

export function dueBusinesses(sql, { now = new Date(), limit = 50 } = {}) {
  const q = read(sql)
  return q`
    select * from selectable_businesses
    where next_touch_at is not null and next_touch_at <= ${now}
    order by next_touch_at asc
    limit ${limit}
  `
}

export function businessByEmail(sql, email) {
  const q = read(sql)
  return q`
    select * from selectable_businesses
    where lower(email) = lower(${email})
    limit 1
  `
}

export function businessByPlaceId(sql, placeId) {
  const q = read(sql)
  return q`
    select * from selectable_businesses
    where place_id = ${placeId}
    limit 1
  `
}

export function sourcedBacklog(sql, { limit = 25 } = {}) {
  const q = read(sql)
  return q`
    select * from selectable_businesses
    where stage = 'sourced'
    order by created_at asc
    limit ${limit}
  `
}

export function qualifiedBacklog(sql, { limit = 50 } = {}) {
  const q = read(sql)
  return q`
    select * from selectable_businesses
    where stage = 'qualified'
    order by created_at asc
    limit ${limit}
  `
}

// Sourcing inserts in bulk and re-runs the same grid cell weekly, so a repeat
// hit on place_id is expected, not an error.
export function insertBusinesses(sql, rows) {
  if (!rows.length) return Promise.resolve([])
  return sql`
    insert into businesses ${sql(rows, ...Object.keys(rows[0]))}
    on conflict (place_id) where place_id is not null do nothing
    returning *
  `
}

export function updateBusiness(sql, id, patch) {
  return sql`
    update businesses set ${sql(patch, ...Object.keys(patch))}, updated_at = now()
    where id = ${id}
    returning *
  `
}

// The only writer of suppressed_at, and it never writes null. The
// `is null` guard makes a second call a no-op rather than a fresh timestamp:
// the moment someone opted out is a fact, not something a later reply resets.
export function suppress(sql, id, reason = null) {
  return sql`
    update businesses set suppressed_at = now(), updated_at = now()
    where id = ${id} and suppressed_at is null
    returning id, suppressed_at, ${reason}::text as reason
  `
}

export function recordThread(sql, { messageId, businessId, direction, mailbox, subject = null }) {
  return sql`
    insert into email_threads (message_id, business_id, direction, mailbox, subject)
    values (${messageId}, ${businessId}, ${direction}, ${mailbox}, ${subject})
    on conflict (message_id) do nothing
    returning *
  `
}

export function logEvent(sql, job, kind, detail = {}) {
  return sql`
    insert into events (job, kind, detail)
    values (${job}, ${kind}, ${sql.json(detail ?? {})})
    returning *
  `
}
