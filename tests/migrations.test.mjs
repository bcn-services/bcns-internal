import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dir = new URL('../supabase/migrations/', import.meta.url)
const reset = readFileSync(new URL('0017_reset.sql', dir), 'utf8')
const pipeline = readFileSync(new URL('0018_pipeline.sql', dir), 'utf8')
const dailyReset = readFileSync(new URL('0021_mailbox_daily_reset.sql', dir), 'utf8')

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

// --- 0020 ------------------------------------------------------------------

const clients = readFileSync(new URL('0020_clients.sql', dir), 'utf8')

test('0020 puts no status column on clients — the README owns lifecycle', () => {
  // The whole point of the split. A status column here is the same fact stored
  // twice, and the two copies drift.
  assert.ok(!/^\s*status\s+text/im.test(clients), 'clients grew a status column')
  assert.match(clients, /churn_date\s+date/i)
})

test('0020 keeps money in integer cents, never dollars', () => {
  const money = [...clients.matchAll(/^\s*(\w*(?:fee|rate|amount)\w*)\s+(\w+)/gim)]
  assert.ok(money.length >= 2, 'no money columns found')
  for (const [, name, type] of money) {
    assert.match(name, /_cents$/, `${name} is money but not named _cents`)
    assert.equal(type.toLowerCase(), 'bigint', `${name} is ${type}, not bigint`)
  }
})

test('0020 does not touch the funnel', () => {
  assert.ok(!/alter table businesses/i.test(clients), '0020 alters businesses')
  assert.ok(!/businesses_stage_check/i.test(clients), '0020 rewrites the stage check')
})

test('0020 seeds no lost deal as a paying client', () => {
  const insert = clients.match(/insert into clients[\s\S]*?on conflict/i)
  assert.ok(insert, 'no seed insert')
  assert.ok(!/'coventry'/i.test(insert[0]), 'Coventry never signed; it has no clients row')
  const slugs = [...insert[0].matchAll(/^\s*\('([a-z0-9-]+)',/gm)].map((m) => m[1])
  assert.deepEqual(slugs.sort(), ['delucas', 'l2detailz', 'sb', 'technology-associates', 'wwc'])
})

test('0020 enables RLS with no policies, matching 0018', () => {
  assert.match(clients, /alter table clients\s+enable row level security/i)
  assert.ok(!/create policy/i.test(clients), '0020 adds a policy; deny-all is the absence of one')
  assert.equal((clients.match(/\bbegin\b/gi) || []).length, 1)
  assert.equal((clients.match(/\bcommit\b/gi) || []).length, 1)
})


test('0021 gives mailboxes the day its count belongs to', () => {
  assert.match(dailyReset, /alter table mailboxes add column sent_on date/i)
  // Backfilled to today, not null: a mailbox that has already sent today keeps
  // its slots spent rather than being handed a fresh cap mid-day.
  assert.match(dailyReset, /not null default current_date/i)
  // Additive only — 0018's counter is not dropped or rewritten.
  assert.ok(!/drop|delete/i.test(dailyReset.replace(/^--.*$/gm, '')), '0021 destroys something')
})

// --- 0022 ------------------------------------------------------------------

const pipelineV2 = readFileSync(new URL('0022_pipeline_v2.sql', dir), 'utf8')

test('0022 gives businesses os_slug and clients the paperwork columns', () => {
  assert.match(pipelineV2, /alter table businesses add column os_slug text unique/i)
  assert.match(pipelineV2, /alter table clients add column signed_at\s+timestamptz/i)
  assert.match(pipelineV2, /alter table clients add column contract_path\s+text/i)
  assert.match(pipelineV2, /alter table clients add column repo_url\s+text/i)
  assert.equal((pipelineV2.match(/\bbegin\b/gi) || []).length, 1)
  assert.equal((pipelineV2.match(/\bcommit\b/gi) || []).length, 1)
  const parens = pipelineV2.replace(/^--.*$/gm, '')
  assert.equal((parens.match(/\(/g) || []).length, (parens.match(/\)/g) || []).length)
})

test('0022 adds onboarded and keeps approved so existing rows stay valid', () => {
  const check = pipelineV2.match(
    /add constraint businesses_stage_check check \(stage in \(([\s\S]*?)\)\s*\)/i
  )
  assert.ok(check, '0022 re-adds no stage check')
  const listed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.equal(listed.length, 13)
  assert.deepEqual(listed.sort(), [...STAGES, 'quoting', 'onboarded'].sort())
  // `quoted` was already in the vocabulary from 0018 — 0022 re-states it, it
  // does not introduce it. `approved` is retained on purpose: nothing writes it
  // any more, but rows written before the approval loop was removed carry it.
  assert.ok(listed.includes('quoted'))
  assert.ok(listed.includes('approved'))
  assert.ok(/quoted/i.test(pipeline), 'quoted was never new — 0018 already listed it')
})

test('0022 edits no applied migration and contradicts none of them', () => {
  // 0018/0019/0020 are applied and immutable; 0022 is the additive follow-up.
  assert.ok(!/onboarded/i.test(pipeline), '0018 was edited — it is applied')
  assert.ok(!/onboarded/i.test(quoting), '0019 was edited — it is applied')
  assert.ok(!/os_slug|signed_at|contract_path|repo_url/i.test(pipeline), '0018 was edited')
  assert.ok(!/os_slug|signed_at|contract_path|repo_url/i.test(clients), '0020 was edited')
  // The only drop is the stage constraint it immediately re-adds.
  const body = pipelineV2.replace(/^--.*$/gm, '')
  assert.deepEqual(
    [...body.matchAll(/\bdrop\b[^\n;]*/gi)].map((m) => m[0].trim()),
    ['drop constraint businesses_stage_check']
  )
  assert.ok(!/\bdelete\b|\bdrop table\b|\bdrop column\b/i.test(body), '0022 destroys something')
})

test('0022 adds no RLS policy — businesses and clients stay deny-all', () => {
  assert.ok(!/create policy/i.test(pipelineV2), '0022 adds a policy; deny-all is the absence of one')
  assert.ok(!/create policy/i.test(pipeline), '0018 grew a policy')
  assert.ok(!/create policy/i.test(clients), '0020 grew a policy')
})

// --- 0026 --------------------------------------------------------------

const noEmailPool = readFileSync(new URL('0026_no_email_pool.sql', dir), 'utf8')

test('0026 adds no_email to the stage vocabulary, copying 0022s full list', () => {
  const check = noEmailPool.match(
    /add constraint businesses_stage_check check \(stage in \(([\s\S]*?)\)\s*\)/i
  )
  assert.ok(check, '0026 re-adds no stage check')
  const listed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.equal(listed.length, 14)
  assert.deepEqual(listed.sort(), [...STAGES, 'quoting', 'onboarded', 'no_email'].sort())
  assert.ok(listed.includes('no_email'))
})

test('0026 backfills only untouched call_due rows with no email', () => {
  assert.match(
    noEmailPool,
    /update businesses\s+set stage = 'no_email'\s+where stage = 'call_due' and email is null and coalesce\(touches,\s*0\) = 0/i
  )
})

test('0026 parses as balanced SQL with one begin and one commit', () => {
  const stripped = noEmailPool.replace(/--[^\n]*/g, '').replace(/'[^']*'/g, "''")
  let depth = 0
  for (const ch of stripped) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    assert.ok(depth >= 0, '0026: unbalanced parenthesis')
  }
  assert.equal(depth, 0, '0026: unbalanced parenthesis')
  assert.equal((stripped.match(/\bbegin\b/gi) || []).length, 1, '0026: expected one begin')
  assert.equal((stripped.match(/\bcommit\b/gi) || []).length, 1, '0026: expected one commit')
  assert.ok(stripped.trim().endsWith(';'), '0026: does not end in a statement terminator')
})

test('0026 edits no applied migration', () => {
  assert.ok(!/no_email/i.test(pipeline), '0018 was edited — it is applied')
  assert.ok(!/no_email/i.test(pipelineV2), '0022 was edited — it is applied')
})
