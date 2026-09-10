import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run as pitch, slugFor, claimSlug } from '../jobs/pitch.mjs'
import { run as qualify, PAGE_TEXT_MAX } from '../jobs/qualify.mjs'

const RESEARCH = (over = {}) =>
  JSON.stringify({
    facts: ['no online booking', 'GAF certified'],
    fit: 'good',
    reason: 'dated site',
    page_text: 'Acme Roofing, family run since 1998.',
    ...over,
  })

const biz = (over = {}) => ({
  id: 'b1',
  name: 'Acme Roofing',
  town: 'Danbury',
  state: 'CT',
  place_id: 'ChIJabcdef123456',
  // PITCH_STAGES is `['replied']` — call_due rows get a call script from
  // notify instead (see jobs/notify.mjs CALL_SCRIPT).
  stage: 'replied',
  os_slug: null,
  research: RESEARCH(),
  ...over,
})

// The whole boundary set as fakes: no Claude CLI, no git, no database. The
// only real filesystem touched is a temp dir the test owns and removes.
function harness({ rows = [], runSkill, commitAndPush, updateThrows = null } = {}) {
  const events = []
  const updates = []
  const pushes = []
  const store = rows.map((r) => ({ ...r }))
  let dir = null

  const deps = {
    sql: {},
    db: {
      logEvent: (_s, job, kind, detail) => {
        events.push({ job, kind, detail })
        return Promise.resolve([])
      },
      businessesByStage: (_s, stage) => Promise.resolve(store.filter((r) => r.stage === stage)),
      updateBusiness: async (_s, id, patch) => {
        if (updateThrows) {
          const err = updateThrows(patch, updates.length)
          if (err) throw err
        }
        updates.push({ id, patch })
        Object.assign(store.find((r) => r.id === id), patch)
        return []
      },
    },
    osDir: '/w/os',
    // Live by default: the dry-run path is exercised explicitly by the tests
    // that set `dryRun: true`, and under it no skill call is made at all.
    dryRun: false,
    runSkill: runSkill ?? (async () => ({ wrote: ['/w/os/clients/x/pitch/call-script.md'], dryrun: [] })),
    // A live push by default: under `dryRun: true` nothing is pushed and the
    // job deliberately marks nothing (see lib/osrepo.mjs pushOrSkip), which
    // tests/quote.test.mjs covers for both jobs.
    commitAndPush:
      commitAndPush ?? (async (opts) => (pushes.push(opts), { dryRun: false, commands: [] })),
    mkTempDir: async () => (dir = await mkdtemp(join(tmpdir(), 'pitch-test-'))),
  }
  return { deps, events, updates, pushes, store, tmp: () => dir }
}

const kinds = (events) => events.map((e) => e.kind)

test('the /pitch command names the slug and both temp files, verbatim', async () => {
  const calls = []
  const h = harness({
    rows: [biz()],
    runSkill: async (opts) => (calls.push(opts), { wrote: ['/w/os/clients/a/pitch/x.md'], dryrun: [] }),
  })
  try {
    const out = await pitch(h.deps)
    assert.equal(out.pitched, 1)
    assert.equal(out.errors, 0)

    const dir = h.tmp()
    assert.equal(calls.length, 1)
    assert.equal(
      calls[0].command,
      `/pitch acme-roofing-danbury --facts ${join(dir, 'facts.json')} --page-text ${join(dir, 'page-text.txt')} --no-browse`
    )
    // The skill runs inside the ~/os clone, not this repo.
    assert.equal(calls[0].cwd, '/w/os')

    // Both files exist and carry what qualify stored, nothing invented.
    const facts = JSON.parse(await readFile(join(dir, 'facts.json'), 'utf8'))
    assert.equal(facts.name, 'Acme Roofing')
    assert.equal(facts.phone ?? null, null)
    assert.equal(facts.town, 'Danbury')
    // The skill contract names these three at the top level; null beats absent.
    assert.equal(facts.has_website, Boolean(facts.domain))
    assert.equal(facts.rating, null)
    assert.equal(facts.review_count, null)
    // research arrives parsed, not as a JSON string inside a JSON file.
    assert.deepEqual(facts.research.facts, ['no online booking', 'GAF certified'])
    assert.equal(facts.research.fit, 'good')
    assert.equal(
      await readFile(join(dir, 'page-text.txt'), 'utf8'),
      'Acme Roofing, family run since 1998.'
    )

    // What the skill wrote is what gets pushed, under the slug's message.
    assert.deepEqual(h.pushes, [
      { paths: ['/w/os/clients/a/pitch/x.md'], message: 'pitch: acme-roofing-danbury' },
    ])

    // The slug write, then the pitch_path write. The other research keys survive.
    assert.deepEqual(h.updates[0], { id: 'b1', patch: { os_slug: 'acme-roofing-danbury' } })
    const written = JSON.parse(h.updates[1].patch.research)
    assert.equal(written.pitch_path, 'clients/acme-roofing-danbury/pitch/')
    assert.equal(written.fit, 'good')
    assert.deepEqual(written.facts, ['no online booking', 'GAF certified'])
    assert.equal(h.updates[1].patch.stage, undefined, 'pitch moved the stage')

    assert.deepEqual(kinds(h.events), ['pitched'])
    assert.equal(h.events[0].detail.pitch_path, 'clients/acme-roofing-danbury/pitch/')
  } finally {
    await rm(h.tmp(), { recursive: true, force: true })
  }
})

test('a throwing runSkill writes an error event and leaves the row alone', async () => {
  const h = harness({
    rows: [biz()],
    runSkill: async () => {
      throw Object.assign(
        new Error('skill run failed for "/pitch acme-roofing-danbury": exit 1'),
        { stderr: 'claude: command not found' }
      )
    },
  })
  try {
    const out = await pitch(h.deps)
    assert.equal(out.pitched, 0)
    assert.equal(out.errors, 1)

    assert.deepEqual(kinds(h.events), ['error'])
    const detail = h.events[0].detail
    assert.match(detail.error, /skill run failed for "\/pitch acme-roofing-danbury"/)
    assert.match(detail.command, /^\/pitch acme-roofing-danbury --facts /)
    assert.equal(detail.stderr, 'claude: command not found')

    // The row keeps its stage and its research: only the slug was claimed.
    const row = h.store[0]
    assert.equal(row.stage, 'replied')
    assert.equal(row.research, RESEARCH())
    assert.equal(JSON.parse(row.research).pitch_path, undefined)
    assert.deepEqual(h.updates.map((u) => Object.keys(u.patch)), [['os_slug']])
    assert.deepEqual(h.pushes, [], 'a failed pitch still pushed to ~/os')
  } finally {
    await rm(h.tmp(), { recursive: true, force: true })
  }
})

test('a row that already has a pitch_path is never pitched a second time', async () => {
  let called = 0
  const h = harness({
    rows: [biz({ research: RESEARCH({ pitch_path: 'clients/acme-roofing-danbury/pitch/' }) })],
    runSkill: async () => (called++, { wrote: [], dryrun: [] }),
  })
  const out = await pitch(h.deps)
  assert.equal(called, 0)
  assert.deepEqual(out, { pitched: 0, errors: 0 })
  assert.deepEqual(h.updates, [])
  assert.deepEqual(h.pushes, [])
  assert.deepEqual(kinds(h.events), ['skipped'])
})

test('a taken slug is retried once with the tail of the place id', async () => {
  const h = harness({
    rows: [biz()],
    updateThrows: (patch) =>
      patch.os_slug === 'acme-roofing-danbury'
        ? Object.assign(new Error('duplicate key value'), { code: '23505' })
        : null,
  })
  try {
    const out = await pitch(h.deps)
    assert.equal(out.pitched, 1)
    assert.equal(h.updates[0].patch.os_slug, 'acme-roofing-danbury-123456')
    assert.equal(
      JSON.parse(h.updates[1].patch.research).pitch_path,
      'clients/acme-roofing-danbury-123456/pitch/'
    )
  } finally {
    await rm(h.tmp(), { recursive: true, force: true })
  }
})

test('a slug already on the row is reused, never re-claimed', async () => {
  const updates = []
  const slug = await claimSlug({}, { updateBusiness: (_s, id, p) => updates.push(p) }, biz({ os_slug: 'kept-slug' }))
  assert.equal(slug, 'kept-slug')
  assert.deepEqual(updates, [])
})

test('slugFor kebabs the name and the town and drops punctuation', () => {
  assert.equal(slugFor({ name: "O'Brien & Sons Roofing, LLC", town: 'New Haven' }), 'o-brien-sons-roofing-llc-new-haven')
  assert.equal(slugFor({ id: 'abcdef123456', name: '', town: '' }), 'business-123456')
})

test('a non-unique-violation database error is not swallowed as a slug clash', async () => {
  const h = harness({
    rows: [biz()],
    updateThrows: () => Object.assign(new Error('connection terminated'), { code: '08006' }),
  })
  const out = await pitch(h.deps)
  assert.equal(out.errors, 1)
  assert.match(h.events[0].detail.error, /connection terminated/)
})

test('no ~/os clone is a skipped event, never a throw', async () => {
  const h = harness({ rows: [biz()] })
  const out = await pitch({ ...h.deps, osDir: undefined, runSkill: undefined, commitAndPush: undefined })
  assert.deepEqual(out.skipped, ['osDir', 'runSkill', 'commitAndPush'])
  assert.deepEqual(kinds(h.events), ['skipped'])
  assert.match(h.events[0].detail.reason, /missing deps/)
})

// --- qualify stores what pitch reads back ----------------------------------

test('qualify persists the page text it read, capped, alongside the facts', async () => {
  // An email in the text so the pre-Claude EMAIL_RE scan doesn't short-circuit
  // straight to `no_email` — this test is about page_text capping, not the
  // no-email path (see the qualify.test.mjs no-email-text tests for that).
  const long = 'Acme Roofing. hello@acme.example ' + 'x'.repeat(60_000)
  const updates = []
  let asked = ''
  const deps = {
    sql: {},
    db: {
      logEvent: () => {},
      sourcedBacklog: async () => [{ id: 'b1', name: 'Acme', domain: 'acme.example' }],
      updateBusiness: async (_s, id, patch) => (updates.push(patch), []),
      promotedToday: async () => [{ count: 0 }],
      promoteNoEmail: async () => [],
    },
    fetchPage: async (url) => (url.endsWith('.example') ? `<p>${long}</p>` : ''),
    claude: {
      ask: async (prompt) => {
        asked = prompt
        return JSON.stringify({ email: null, facts: ['f1'], fit: 'good', reason: 'r' })
      },
    },
  }
  await qualify(deps)
  const research = JSON.parse(updates[0].research)
  // What was stored is exactly what the model was shown, capped. `trim` already
  // bounds a page well under the cap, so this is a ceiling, not a trim.
  assert.ok(research.page_text.length > 0 && research.page_text.length <= PAGE_TEXT_MAX)
  assert.equal(research.page_text, asked.slice(asked.indexOf('PAGE TEXT:\n') + 11, PAGE_TEXT_MAX))
  assert.match(research.page_text, /^Acme Roofing\./)
  // The keys the rest of the pipeline reads are untouched.
  assert.deepEqual(research.facts, ['f1'])
  assert.equal(research.fit, 'good')
  assert.equal(research.reason, 'r')
})

test('a replied row is pitched, a call_due row is not — call_due gets the call script instead', async () => {
  const h = harness({
    rows: [biz({ id: 'r1', name: 'Reply Co', stage: 'replied' }), biz({ id: 'c1', stage: 'call_due' })],
    runSkill: async () => ({ wrote: ['/w/os/clients/a/pitch/x.md'], dryrun: [] }),
  })
  try {
    const out = await pitch(h.deps)
    assert.equal(out.pitched, 1)
    const marked = h.updates.filter((u) => u.patch.research).map((u) => u.id)
    assert.deepEqual(marked, ['r1'])
    // The row keeps its stage: pitch never moves a replied row anywhere.
    assert.equal(h.store.find((r) => r.id === 'r1').stage, 'replied')
    // call_due never entered PITCH_STAGES — untouched.
    assert.equal(h.store.find((r) => r.id === 'c1').stage, 'call_due')
    assert.deepEqual(h.updates.filter((u) => u.id === 'c1'), [])
  } finally {
    await rm(h.tmp(), { recursive: true, force: true })
  }
})
