import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATE, SIGNATURE, render, isRoleAddress } from '../lib/template.mjs'
import { run as personalize, BANNED } from '../jobs/personalize.mjs'
import { assertSelectable, draftedCount } from '../lib/db.mjs'

const FACTS = ['Family run since 1998', 'Serves Milford and Stratford', 'GAF certified']

function biz(i, over = {}) {
  return {
    id: `b${i}`,
    name: `Acme Roofing ${i}`,
    email: `owner${i}@acme.test`,
    town: 'Milford',
    state: 'CT',
    trade: 'roofing',
    stage: 'qualified',
    research: JSON.stringify({ facts: FACTS, fit: 'good', reason: 'no site' }),
    ...over,
  }
}

const SENTENCE = 'Most roofing owners we talk to end up tracking jobs on paper'

function harness({ rows, drafted = 0, answer = SENTENCE, voice = null } = {}) {
  const events = []
  const updates = []
  const prompts = []
  return {
    events, updates, prompts,
    deps: {
      sql: {},
      db: {
        logEvent: (_s, job, kind, detail) => events.push({ job, kind, detail }),
        draftedCount: async () => [{ count: drafted }],
        qualifiedBacklog: async (_s, { limit }) => rows.slice(0, limit),
        updateBusiness: async (_s, id, patch) => { updates.push({ id, patch }); return [] },
      },
      claude: { ask: async (p) => { prompts.push(p); return typeof answer === 'function' ? answer(p) : answer } },
      ...(voice === null ? {} : { readVoiceRules: async () => voice }),
    },
  }
}

// --- lib/template.mjs ------------------------------------------------------

test('render fills every slot and leaves the fixed blocks byte-identical', () => {
  const out = render({ name: 'Acme Roofing', ownerName: 'Dana', email: 'dana@acme.test', sentence: SENTENCE })
  assert.ok(out.startsWith('Subject: a question about Acme Roofing\n'))
  assert.match(out, /Hi Dana,/)
  assert.match(out, new RegExp(`sell you anything\\. ${SENTENCE} and I'd love`))
  assert.ok(out.includes(SIGNATURE))
  assert.ok(out.endsWith('Reply "stop" and I won\'t write again.\n'))
  for (const slot of ['BUSINESS_NAME', 'OWNER_NAME', 'NATE_SIGNATURE', '>>> GENERATED <<<']) {
    assert.ok(!out.includes(slot), `${slot} survived rendering`)
  }
  // Every fixed line of the template still appears verbatim.
  for (const line of TEMPLATE.split('\n')) {
    if (/BUSINESS_NAME|OWNER_NAME|NATE_SIGNATURE|GENERATED/.test(line) || !line.trim()) continue
    assert.ok(out.includes(line), `fixed line missing: ${line}`)
  }
})

test('the greeting name is omitted for a missing owner and for role addresses', () => {
  assert.match(render({ name: 'A', sentence: 's' }), /^Subject[\s\S]*\nHi,\n/)
  for (const email of ['info@a.test', 'office@a.test', 'contact@a.test', 'sales@a.test']) {
    assert.ok(isRoleAddress(email), email)
    assert.match(render({ name: 'A', ownerName: 'Dana', email, sentence: 's' }), /\nHi,\n/)
  }
  assert.ok(!isRoleAddress('dana@a.test'))
})

test('a rendered draft carries no em or en dash', () => {
  assert.ok(!/[—–]/.test(render({ name: 'A', ownerName: 'Dana', email: 'd@a.test', sentence: SENTENCE })))
})

test('draftedCount reads through selectable_businesses', () => {
  let text = ''
  const sql = (strings) => { text = strings.join('?'); return [{ count: 3 }] }
  draftedCount(sql)
  assert.match(text, /selectable_businesses/)
  assert.match(text, /stage = 'drafted'/)
  assert.doesNotThrow(() => assertSelectable(text))
})

// --- jobs/personalize.mjs --------------------------------------------------

test('exactly one Claude call per business', async () => {
  const h = harness({ rows: [biz(1), biz(2), biz(3)] })
  const res = await personalize(h.deps)
  assert.equal(h.prompts.length, 3)
  assert.equal(res.drafted, 3)
  assert.equal(h.updates.length, 3)
})

test('a missing claude dep writes a skipped event and returns', async () => {
  const h = harness({ rows: [biz(1)] })
  delete h.deps.claude
  const res = await personalize(h.deps)
  assert.equal(res.drafted, 0)
  assert.equal(h.updates.length, 0)
  assert.match(h.events.at(-1).detail.reason, /missing deps: claude/)
})

test('a business with fewer than three facts is skipped, not drafted thin', async () => {
  const thin = biz(1, { research: JSON.stringify({ facts: ['Family run since 1998', 'GAF certified'], fit: 'good' }) })
  const h = harness({ rows: [thin, biz(2)] })
  const res = await personalize(h.deps)
  assert.equal(res.skipped, 1)
  assert.equal(res.drafted, 1)
  assert.equal(h.prompts.length, 1, 'no Claude call for the thin row')
  assert.deepEqual(h.updates.map((u) => u.id), ['b2'], 'thin row was written anyway')
  const skip = h.events.find((e) => e.kind === 'skipped' && e.detail.business === 'b1')
  assert.match(skip.detail.reason, /fewer than three/)
})

for (const [label, bad] of [
  ['http', 'Most roofing owners end up at http://example.test for scheduling'],
  ['$', 'Most roofing owners end up quoting $500 jobs by hand'],
  ['demo is ready', 'Most roofing owners we talk to book by phone and your demo is ready'],
]) {
  test(`a draft containing ${label} is rejected and an error event written`, async () => {
    const h = harness({ rows: [biz(1)], answer: bad })
    const res = await personalize(h.deps)
    assert.equal(res.drafted, 0)
    assert.equal(res.errors, 1)
    assert.equal(h.updates.length, 0, 'a banned draft was written to the row')
    const err = h.events.find((e) => e.kind === 'error')
    assert.equal(err.detail.business, 'b1')
    assert.equal(err.detail.term, label)
    assert.ok(BANNED.includes(label))
  })
}

test('the buffer stops at 25 undelivered drafts', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => biz(i))
  const h = harness({ rows, drafted: 23 })
  const res = await personalize(h.deps)
  assert.equal(res.drafted, 2)
  assert.equal(h.updates.length, 2)
  assert.equal(h.prompts.length, 2, 'Claude was called past the buffer cap')

  const full = harness({ rows, drafted: 25 })
  const res2 = await personalize(full.deps)
  assert.equal(res2.drafted, 0)
  assert.equal(full.prompts.length, 0)
  assert.match(full.events.at(-1).detail.reason, /buffer full/)
})

test('the draft is stored beside the existing research keys, not over them', async () => {
  const h = harness({ rows: [biz(1)] })
  await personalize(h.deps)
  const patch = h.updates[0].patch
  assert.equal(patch.stage, 'drafted')
  const stored = JSON.parse(patch.research)
  assert.deepEqual(stored.facts, FACTS)
  assert.equal(stored.fit, 'good')
  assert.equal(stored.reason, 'no site')
  assert.ok(stored.draft.includes(SENTENCE))
})

test('missing voice rules log a skipped reason and the run continues', async () => {
  const h = harness({ rows: [biz(1)], voice: '' })
  const res = await personalize(h.deps)
  assert.equal(res.drafted, 1)
  assert.ok(h.events.some((e) => e.kind === 'skipped' && /voice rules absent/.test(e.detail.reason)))
  assert.ok(!h.prompts[0].includes('VOICE RULES'))

  const withVoice = harness({ rows: [biz(1)], voice: 'Write like Nate.' })
  await personalize(withVoice.deps)
  assert.match(withVoice.prompts[0], /VOICE RULES:\nWrite like Nate\./)
})

test('a multi-sentence answer is cut to one clause with no terminal period', async () => {
  const h = harness({ rows: [biz(1)], answer: `${SENTENCE}. We can help with that.` })
  await personalize(h.deps)
  const draft = JSON.parse(h.updates[0].patch.research).draft
  assert.ok(draft.includes(`sell you anything. ${SENTENCE} and I'd love`), draft)
  assert.ok(!draft.includes('We can help'))
})

test('a Claude failure is an error event and leaves the row at qualified', async () => {
  const h = harness({ rows: [biz(1)], answer: () => { throw new Error('CLI timeout') } })
  const res = await personalize(h.deps)
  assert.equal(res.errors, 1)
  assert.equal(h.updates.length, 0)
  assert.match(h.events.find((e) => e.kind === 'error').detail.error, /CLI timeout/)
})

test('an empty qualified backlog writes a skipped event', async () => {
  const h = harness({ rows: [] })
  const res = await personalize(h.deps)
  assert.equal(res.drafted, 0)
  assert.match(h.events.at(-1).detail.reason, /no businesses at stage qualified/)
})
