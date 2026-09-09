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

// `sent_today` is projected against `sent_on`, never read raw: a count left
// over from yesterday is not today's count. Reading it raw is what made
// daily_cap a lifetime cap.
export function activeMailboxes(sql) {
  return sql`
    select *, case when sent_on = current_date then sent_today else 0 end as sent_today
    from mailboxes where status = 'active' order by address asc
  `
}

// Every outreach address the pipeline has ever sent from, whatever its status:
// a reply to a paused or burned mailbox is still a prospect's reply, and poll
// must route it as one rather than forward it as unrecognised.
export function mailboxAddresses(sql) {
  return sql`select address from mailboxes order by address asc`
}

// Claim-then-send: the increment IS the reservation, so two concurrent runs
// cannot both take the last slot. No row back means this mailbox is spent.
//
// The rollover rides in the same statement rather than in a nightly job: a
// stale `sent_on` makes the claim the day's first, so the reset cannot be
// missed while the runner is asleep and there is no tick to fail. `current_date`
// is UTC, and the touch cron is one 14:00 UTC cell, so no run straddles it.
export function claimMailboxSlot(sql, { address, cap }) {
  return sql`
    update mailboxes set
      sent_today = case when sent_on = current_date then sent_today + 1 else 1 end,
      sent_on = current_date
    where address = ${address} and status = 'active'
      and (sent_on is distinct from current_date or sent_today < ${cap})
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

// How many times this message has already failed. `events` is the poller's
// only marker store, so the dead-letter counter reads it rather than adding
// state. Keyed on the caller's message key (the RFC Message-ID), never on the
// uid: a uid is unique only per mailbox per uidvalidity, and against an
// append-only table a recycled uid would inherit a dead predecessor's count.
export function messageFailureCount(sql, key) {
  return sql`
    select count(*)::int as count from events
    where job = 'poll' and kind in ('error', 'dead_letter') and detail->>'message_key' = ${String(key)}
  `
}

// A single row for the poller to inspect before it moves a stage. Through the
// view, so a suppressed business simply is not there.
export function businessById(sql, id) {
  const q = read(sql)
  return q`select * from selectable_businesses where id = ${id} limit 1`
}

// --- notifying -------------------------------------------------------------
// The notify job reads a stage's backlog and nothing else; it writes no
// business row at all. Through the view like every other read, so a suppressed
// business is never the subject of an internal email either.

export function businessesByStage(sql, stage, { limit = 50 } = {}) {
  const q = read(sql)
  return q`
    select * from selectable_businesses
    where stage = ${stage}
    order by updated_at asc
    limit ${limit}
  `
}

// The dedupe read. `events` is the only marker store there is: one
// `notify/notified` row per key, and a key is only ever asked about for rows
// already in hand, so this stays bounded by the job's own limit.
export function notifiedKeys(sql, keys) {
  if (!keys?.length) return Promise.resolve([])
  return sql`
    select distinct detail->>'key' as key from events
    where job = 'notify' and kind = 'notified' and detail->>'key' = any(${keys})
  `
}

// --- one-off verification --------------------------------------------------
// A tally of every event in the window, by job and kind, so a human can tell
// "hourly ticks are landing and nothing is erroring" at a glance without
// reading raw rows.
export function eventCounts(sql, hours = 24) {
  return sql`
    select job, kind, count(*)::int as count from events
    where created_at > now() - make_interval(hours => ${hours})
    group by job, kind
    order by job, kind
  `
}

// Actual sent copy, for a human to eyeball rather than a job to score. Joins
// through `selectable_businesses` like every other read here, so a
// since-suppressed business never resurfaces in a status email.
export function recentSentDrafts(sql, hours = 24, limit = 3) {
  const q = read(sql)
  return q`
    select b.name, b.email, b.research->>'draft' as draft
    from events e
    join selectable_businesses b on b.id = (e.detail->>'business')::uuid
    where e.job = 'touch' and e.kind = 'sent'
      and e.created_at > now() - make_interval(hours => ${hours})
    order by e.created_at desc
    limit ${limit}
  `
}

// --- clients ---------------------------------------------------------------
// The paying roster (migration 0020). `businesses` is the funnel; a client row
// is the money record behind a business that got as far as a quote.

export function clientByBusiness(sql, businessId) {
  return sql`select * from clients where business_id = ${businessId} limit 1`
}

// `business_id` is unique in 0020, so the conflict clause makes a second
// insert a no-op rather than an error — the caller's read is the fast path,
// this is what holds if two runs overlap. No money column is written: an
// invented rate is worse than the blank a human fills in.
// Keyed on business_id, the same unique column insertClient conflicts on, so a
// client row is addressable before anyone has looked up its id.
export function updateClient(sql, businessId, patch) {
  return sql`
    update clients set ${sql(patch, ...Object.keys(patch))}
    where business_id = ${businessId}
    returning *
  `
}

export function insertClient(sql, row) {
  return sql`
    insert into clients ${sql(row, ...Object.keys(row))}
    on conflict (business_id) do nothing
    returning *
  `
}

// --- alert triage ------------------------------------------------------
// One row per fingerprint. `hits` counts every sighting, including the first;
// the caller opens a PR only when the returned `hits` is 1 — anything higher
// means this fingerprint already has one open.
export function upsertAlert(sql, { fingerprint, repo = null, source = null }) {
  return sql`
    insert into alerts (fingerprint, repo, source)
    values (${fingerprint}, ${repo}, ${source})
    on conflict (fingerprint) do update
      set hits = alerts.hits + 1, updated_at = now()
    returning *
  `
}

// Written once, right after the PR opens — never on a later duplicate, so a
// dedupe hit can never clobber the URL a human is already looking at.
export function setAlertPr(sql, fingerprint, prUrl) {
  return sql`
    update alerts set pr_url = ${prUrl}, updated_at = now()
    where fingerprint = ${fingerprint}
    returning *
  `
}

// The daily cap reads `events`, the same marker store `messageFailureCount`
// already uses, rather than a counter column with a midnight reset to forget.
// `current_date` is the same convention `claimMailboxSlot` uses for "today".
export function triageOpenedToday(sql) {
  return sql`
    select count(*)::int as count from events
    where job = 'triage' and kind = 'opened' and created_at::date = current_date
  `
}
