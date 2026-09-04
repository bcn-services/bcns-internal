import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATE, SIGNATURE, render, isRoleAddress } from '../lib/template.mjs'
import {
  run as personalize,
  BANNED,
  parseFactReaction,
  composeCompliment,
} from '../jobs/personalize.mjs'
import { assertSelectable, draftedCount } from '../lib/db.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FACTS = ['Family run since 1998', 'Serves Milford and Stratford', 'GAF certified']
const REACTION = 'that is a long time to keep a family business going'
const ANSWER = `FACT: ${FACTS[0]}\nREACTION: ${REACTION}`
const SENTENCE = composeCompliment('Acme Roofing 1', FACTS[0], REACTION)
// render() hard-wraps the opener at ~78 cols, so assertions compare unwrapped text.
const unwrap = (s) => s.replace(/\n/g, ' ')

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

function harness({ rows, drafted = 0, answer = ANSWER, voice = null } = {}) {
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
  assert.ok(unwrap(out).includes(`doing well. ${SENTENCE}`))
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

for (const [label, reaction] of [
  ['http', 'http://example.test has the details'],
  ['$', 'it runs about $500 either way'],
  ['demo is ready', 'your demo is ready to see'],
]) {
  test(`a draft containing ${label} is rejected and an error event written`, async () => {
    const bad = `FACT: ${FACTS[0]}\nREACTION: ${reaction}`
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
  assert.ok(unwrap(stored.draft).includes(SENTENCE))
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

test('a FACT that is not verbatim from research is rejected as an error, not fixed up', async () => {
  const h = harness({
    rows: [biz(1)],
    answer: `FACT: Fairfield's go-to shop for color correction\nREACTION: that took real work to earn`,
  })
  const res = await personalize(h.deps)
  assert.equal(res.drafted, 0)
  assert.equal(res.errors, 1)
  assert.equal(h.updates.length, 0)
  assert.match(h.events.find((e) => e.kind === 'error').detail.reason, /compliment failed verification/)
})

test('parseFactReaction pulls the two labeled lines and strips dashes', () => {
  const out = parseFactReaction('FACT: GAF certified\nREACTION: that told me you take the work seriously.')
  assert.deepEqual(out, { fact: 'GAF certified', reaction: 'that told me you take the work seriously' })
  assert.deepEqual(parseFactReaction('no labels here'), { fact: '', reaction: '' })
})

test('composeCompliment inserts the right copula for verb, number, and adjective leads', () => {
  assert.equal(
    composeCompliment('Acme', 'Offers comprehensive maintenance plans', 'that takes real effort'),
    'I noticed Acme offers comprehensive maintenance plans, and that takes real effort.'
  )
  assert.equal(
    composeCompliment('Acme', '25+ years in business', 'that is a long run'),
    'I noticed Acme has 25+ years in business, and that is a long run.'
  )
  assert.equal(
    composeCompliment('Acme', 'Family run since 1998', 'that takes commitment'),
    'I noticed Acme is family run since 1998, and that takes commitment.'
  )
  // The shapes the runner actually produced on 2026-09-04, which the old
  // copula rule turned into "is has" and "is over 30,000 roofs".
  assert.equal(
    composeCompliment('Acme', 'has customer testimonials from Sean B.', 'real customers vouching means more than any ad'),
    'I noticed Acme has customer testimonials from Sean B., and real customers vouching means more than any ad.'
  )
  assert.equal(
    composeCompliment('Acme', 'over 30,000 roofs installed', 'that is a lot of roofs'),
    'I noticed Acme has over 30,000 roofs installed, and that is a lot of roofs.'
  )
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

// lib/template.mjs is a byte-copy of the fenced block under "## The template"
// in ~/os/skills/outreach/SKILL.md, and the comment there says never to edit
// one side alone. Nothing enforced that until this test. It needs the ~/os
// clone, which CI does not always have, so it skips rather than fails when
// OS_DIR is unset or the skill is absent.
test('lib/template.mjs still matches the /outreach skill template block', (t) => {
  const skill = process.env.OS_DIR && join(process.env.OS_DIR, 'skills/outreach/SKILL.md')
  if (!skill || !existsSync(skill)) return t.skip('no ~/os clone: set OS_DIR to run this check')

  const block = /## The template[\s\S]*?```\n([\s\S]*?)```/.exec(readFileSync(skill, 'utf8'))
  assert.ok(block, 'no fenced template block found under "## The template" in the outreach skill')
  assert.equal(
    block[1],
    TEMPLATE,
    'lib/template.mjs and the /outreach skill template have drifted — edit the skill, then re-copy'
  )
})
