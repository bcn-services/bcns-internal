import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dir = new URL('../supabase/migrations/', import.meta.url)
const reset = readFileSync(new URL('0017_reset.sql', dir), 'utf8')
const pipeline = readFileSync(new URL('0018_pipeline.sql', dir), 'utf8')

const STAGES = [
  'sourced', 'qualified', 'call_due', 'drafted', 'approved', 'sent',
  'replied', 'meeting', 'quoted', 'won', 'lost',
]

test('selectable_businesses filters out suppressed rows', () => {
  const view = pipeline.match(/create view selectable_businesses as([\s\S]*?);/i)
  assert.ok(view, 'no selectable_businesses view')
  assert.match(view[1], /where\s+suppressed_at\s+is\s+null/i)
})

test('businesses carries a stage check listing all eleven stages', () => {
  const check = pipeline.match(/constraint businesses_stage_check check \(stage in \(([\s\S]*?)\)\s*\)/i)
  assert.ok(check, 'no stage check constraint')
  const listed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.equal(listed.length, 11)
  assert.deepEqual(listed.sort(), [...STAGES].sort())
})

test('businesses has unique indexes over lower(email) and place_id', () => {
  assert.match(pipeline, /create unique index \w+\s+on businesses \(lower\(email\)\)/i)
  assert.match(pipeline, /create unique index \w+\s+on businesses \(place_id\)/i)
})

test('suppressed_at is a timestamp, not a stage value', () => {
  assert.match(pipeline, /suppressed_at\s+timestamptz/i)
  assert.ok(!STAGES.includes('suppressed'))
})

test('0017 never touches the auth or storage schemas', () => {
  assert.ok(!/\bauth\b/i.test(reset), 'reset references the auth schema')
  assert.ok(!/\bstorage\b/i.test(reset), 'reset references the storage schema')
})

test('0017 drops no schema and no Supabase-owned object', () => {
  assert.ok(!/drop\s+schema/i.test(reset))
})

test('both files parse as balanced SQL', () => {
  for (const [name, sql] of [['0017', reset], ['0018', pipeline]]) {
    const stripped = sql
      .replace(/--[^\n]*/g, '')
      .replace(/'[^']*'/g, "''")
    let depth = 0
    for (const ch of stripped) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      assert.ok(depth >= 0, `${name}: unbalanced parenthesis`)
    }
    assert.equal(depth, 0, `${name}: unbalanced parenthesis`)
    assert.equal((stripped.match(/\bbegin\b/gi) || []).length, 1, `${name}: expected one begin`)
    assert.equal((stripped.match(/\bcommit\b/gi) || []).length, 1, `${name}: expected one commit`)
    assert.ok(stripped.trim().endsWith(';'), `${name}: does not end in a statement terminator`)
  }
})

test('every pipeline table has row level security enabled and no policy', () => {
  const tables = [...pipeline.matchAll(/create table (\w+)/gi)].map((m) => m[1])
  assert.deepEqual(tables.sort(), ['alerts', 'businesses', 'email_threads', 'events', 'mailboxes', 'search_grid'])
  for (const t of tables) {
    assert.match(pipeline, new RegExp(`alter table\\s+${t}\\s+enable row level security`, 'i'), `${t} has no RLS`)
  }
  assert.ok(!/create policy/i.test(pipeline), 'deny-all means no policies at all')
})

test('mailboxes is seeded with exactly one row', () => {
  const inserts = [...pipeline.matchAll(/insert into mailboxes[\s\S]*?;/gi)]
  assert.equal(inserts.length, 1)
  const tuples = inserts[0][0].match(/values([\s\S]*);/i)[1]
  assert.ok(!/\)\s*,\s*\(/.test(tuples), 'more than one seeded row')
  assert.match(inserts[0][0], /outreach@send\.bcn-services\.com/)
})

// --- 0019 ------------------------------------------------------------------

const quoting = readFileSync(new URL('0019_quoting_stage.sql', dir), 'utf8')

test('0019 adds quoting to the stage vocabulary without touching 0018', () => {
  const check = quoting.match(
    /add constraint businesses_stage_check check \(stage in \(([\s\S]*?)\)\s*\)/i
  )
  assert.ok(check, '0019 re-adds no stage check')
  const listed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.equal(listed.length, 12)
  assert.deepEqual(listed.sort(), [...STAGES, 'quoting'].sort())
  // 0018 is applied; a stage added there instead would never reach the database.
  assert.ok(!/quoting/i.test(pipeline), '0018 was edited — it is applied and immutable')
  assert.equal((quoting.match(/\bbegin\b/gi) || []).length, 1)
  assert.equal((quoting.match(/\bcommit\b/gi) || []).length, 1)
})
