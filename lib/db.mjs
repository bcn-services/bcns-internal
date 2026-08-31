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

// The drafts buffer is capped by counting undelivered rows, not by trusting a
// tally elsewhere: a send that fails leaves its row at `drafted`, and the cap
// has to see that.
export function draftedCount(sql) {
  const q = read(sql)
  return q`select count(*)::int as count from selectable_businesses where stage = 'drafted'`
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

// --- search grid -----------------------------------------------------------
// lib/grid.mjs owns which cells exist; this table only holds their run state.
// Upserting on every run means adding a town there needs no migration.

export function upsertCells(sql, cells) {
  if (!cells.length) return Promise.resolve([])
  return sql`
    insert into search_grid ${sql(cells, 'trade', 'town', 'state')}
    on conflict (trade, town, state) do nothing
    returning *
  `
}

export function allCells(sql) {
  return sql`select * from search_grid`
}

export function saveCell(sql, cell) {
  return sql`
    update search_grid
    set last_run_at = ${cell.last_run_at ?? null},
        new_rows_last_run = ${cell.new_rows_last_run ?? null},
        exhausted_at = ${cell.exhausted_at ?? null}
    where trade = ${cell.trade} and town = ${cell.town} and state = ${cell.state}
    returning *
  `
}

// --- sending ---------------------------------------------------------------
// Everything the touch job needs. Rows come out of the view, so a suppressed
// business is unreachable from here by construction, and the stage filter is
// what keeps a replied row out of the send list.

// Drafted rows first (they are the first touch), then bumps whose next_touch_at
// has passed. A row at `replied` is not in either set.
export function dueTouches(sql, { now = new Date(), limit = 50 } = {}) {
  const q = read(sql)
  return q`
    select * from selectable_businesses
    where stage = 'drafted'
       or (stage = 'sent' and next_touch_at is not null and next_touch_at <= ${now})
    order by (stage = 'drafted') desc, next_touch_at asc nulls first
    limit ${limit}
  `
}

export function activeMailboxes(sql) {
  return sql`select * from mailboxes where status = 'active' order by address asc`
}

// Claim-then-send: the increment IS the reservation, so two concurrent runs
// cannot both take the last slot. No row back means this mailbox is spent.
export function claimMailboxSlot(sql, { address, cap }) {
  return sql`
    update mailboxes set sent_today = sent_today + 1
    where address = ${address} and status = 'active' and sent_today < ${cap}
    returning *
  `
}

// The first outbound message of a thread — what a bump replies to.
export function firstOutbound(sql, businessId) {
  return sql`
    select message_id, subject from email_threads
    where business_id = ${businessId} and direction = 'outbound'
    order by created_at asc
    limit 1
  `
}

// --- polling ---------------------------------------------------------------

// Maps an inbound reply back to a business. The caller passes In-Reply-To
// first, then References newest-first, and `array_position` keeps that order:
// the closest ancestor in the thread wins, not whichever row postgres finds.
export function threadByMessageIds(sql, messageIds) {
  if (!messageIds?.length) return Promise.resolve([])
  return sql`
    select message_id, business_id from email_threads
    where message_id = any(${messageIds}) and business_id is not null
    order by array_position(${messageIds}::text[], message_id)
    limit 1
  `
}

// A single row for the poller to inspect before it moves a stage. Through the
// view, so a suppressed business simply is not there.
export function businessById(sql, id) {
  const q = read(sql)
  return q`select * from selectable_businesses where id = ${id} limit 1`
}
