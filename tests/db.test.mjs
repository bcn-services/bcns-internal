import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSelectable, dueBusinesses, businessByEmail, businessByPlaceId,
  qualifiedBacklog, suppress, logEvent, recordThread,
} from '../lib/db.mjs'

// A postgres.js-shaped tagged-template fake. Records the static text of every
// query and the values that would have been parameterised.
function fakeClient(handler = () => []) {
  const calls = []
  const sql = (strings, ...values) => {
    const text = strings.join(' ? ')
    calls.push({ text, values })
    return Promise.resolve(handler(text, values) ?? [])
  }
  sql.json = (v) => ({ json: v })
  sql.calls = calls
  return sql
}

const READERS = [
  ['dueBusinesses', (sql) => dueBusinesses(sql)],
  ['businessByEmail', (sql) => businessByEmail(sql, 'a@b.com')],
  ['businessByPlaceId', (sql) => businessByPlaceId(sql, 'place-1')],
  ['qualifiedBacklog', (sql) => qualifiedBacklog(sql)],
]

test('every read helper goes through selectable_businesses', async () => {
  for (const [name, call] of READERS) {
    const sql = fakeClient()
    await call(sql)
    assert.equal(sql.calls.length, 1, `${name} issued ${sql.calls.length} queries`)
    const { text } = sql.calls[0]
    assert.match(text, /from\s+selectable_businesses/i, `${name} does not read the view`)
    assert.ok(!/\bfrom\s+businesses\b/i.test(text), `${name} reads the table directly`)
  }
})

test('assertSelectable throws on a direct read of businesses', () => {
  assert.throws(() => assertSelectable('select * from businesses where id = $1'), /selectable_businesses/)
  assert.throws(() => assertSelectable('SELECT *\nFROM   businesses'), /selectable_businesses/)
  assert.doesNotThrow(() => assertSelectable('select * from selectable_businesses'))
  // Writes legitimately target the table; the guard only wraps reads.
  assert.doesNotThrow(() => assertSelectable('update businesses set stage = $1'))
})

test('logEvent writes one row carrying job, kind and detail', async () => {
  const sql = fakeClient()
  await logEvent(sql, 'source', 'inserted', { rows: 3 })
  assert.equal(sql.calls.length, 1)
  assert.match(sql.calls[0].text, /insert into events \(job, kind, detail\)/i)
  assert.deepEqual(sql.calls[0].values, ['source', 'inserted', { json: { rows: 3 } }])
})

test('logEvent still writes a row when the detail object is empty', async () => {
  for (const detail of [{}, undefined, null]) {
    const sql = fakeClient()
    await logEvent(sql, 'heartbeat', 'skipped', detail)
    assert.equal(sql.calls.length, 1)
    assert.deepEqual(sql.calls[0].values[2], { json: {} })
  }
})

// Interprets the `suppressed_at is null` guard against one stored row, so the
// test fails if that guard is ever dropped from the update.
function suppressingClient(row) {
  return fakeClient((text) => {
    if (!/update businesses set suppressed_at/i.test(text)) return []
    const guarded = /suppressed_at\s+is\s+null/i.test(text)
    if (guarded && row.suppressed_at !== null) return []
    row.suppressed_at = new Date('2026-08-30T12:00:00Z')
    return [{ id: row.id, suppressed_at: row.suppressed_at }]
  })
}

test('suppress twice leaves the original timestamp unchanged', async () => {
  const row = { id: 'b1', suppressed_at: null }
  const sql = suppressingClient(row)
  await suppress(sql, 'b1')
  const first = row.suppressed_at
  assert.ok(first instanceof Date)
  row.__later = new Date('2026-09-01T00:00:00Z')
  const second = await suppress(sql, 'b1')
  assert.equal(row.suppressed_at, first, 'a second suppress rewrote the timestamp')
  assert.deepEqual(second, [], 'a second suppress should update no row')
})

test('suppress never writes null', async () => {
  const sql = fakeClient()
  await suppress(sql, 'b1')
  assert.match(sql.calls[0].text, /suppressed_at\s*=\s*now\(\)/i)
  assert.ok(!/suppressed_at\s*=\s*null/i.test(sql.calls[0].text))
})

test('recordThread is idempotent on message_id', async () => {
  const sql = fakeClient()
  await recordThread(sql, { messageId: '<a@b>', businessId: 'b1', direction: 'outbound', mailbox: 'outreach@send.bcn-services.com' })
  assert.match(sql.calls[0].text, /on conflict \(message_id\) do nothing/i)
})

test('nothing in lib/db.mjs opens a connection', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../lib/db.mjs', import.meta.url), 'utf8'))
  assert.ok(!/from ['"]postgres['"]/.test(src), 'db.mjs imports a driver')
  assert.ok(!/DATABASE_URL/.test(src), 'db.mjs reaches for a connection string')
})
