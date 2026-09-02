import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run as quote } from '../jobs/quote.mjs'
import { run as pitch } from '../jobs/pitch.mjs'
import { quoteReadyEmail } from '../jobs/notify.mjs'

const RESEARCH = (over = {}) =>
  JSON.stringify({
    facts: ['no online booking'],
    fit: 'good',
    owner_name: 'Dana Acme',
    // exactly the shape poll writes: unique non-empty strings
    notes: ['standard build, ~$4k', 'wants online booking'],
    ...over,
  })

const biz = (over = {}) => ({
  id: 'b1',
  name: 'Acme Roofing',
  town: 'Danbury',
  state: 'CT',
  place_id: 'ChIJabcdef123456',
  stage: 'quoting',
  os_slug: null,
  email: 'dana@acme.example',
  research: RESEARCH(),
  ...over,
})

// Every boundary is a fake: no Claude CLI, no git, no database. `updateBusiness`
// really applies the patch, so a second run sees the state the first left.
function harness({ rows = [], runSkill, push = { dryRun: false, commands: [] }, clients = [] } = {}) {
  const events = []
  const updates = []
  const pushes = []
  const inserts = []
  const store = rows.map((r) => ({ ...r }))
  const dirs = []

  const deps = {
    sql: {},
    dryRun: false,
    db: {
      logEvent: (_s, job, kind, detail) => (events.push({ job, kind, detail }), Promise.resolve([])),
      businessesByStage: (_s, stage) => Promise.resolve(store.filter((r) => r.stage === stage)),
      updateBusiness: async (_s, id, patch) => {
        updates.push({ id, patch })
        Object.assign(store.find((r) => r.id === id), patch)
        return []
      },
      clientByBusiness: async (_s, id) => clients.filter((c) => c.business_id === id),
      insertClient: async (_s, row) => (inserts.push(row), clients.push(row), [row]),
    },
    osDir: '/w/os',
    runSkill:
      runSkill ?? (async () => ({ wrote: ['/w/os/clients/a/quote/2026-09-01-a.pdf'], dryrun: [] })),
    commitAndPush: async (opts) => (pushes.push(opts), push),
    mkTempDir: async () => {
      const d = await mkdtemp(join(tmpdir(), 'quote-test-'))
      dirs.push(d)
      return d
    },
  }
  const cleanup = () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  return { deps, events, updates, pushes, inserts, store, dirs, cleanup }
}

const kinds = (events) => events.map((e) => e.kind)

test('the /quote command names the slug, the notes file and --yes, verbatim', async () => {
  const calls = []
  const h = harness({
    rows: [biz()],
    runSkill: async (opts) => (calls.push(opts), { wrote: ['/w/os/clients/a/quote/q.pdf'], dryrun: [] }),
  })
  try {
    const out = await quote(h.deps)
    assert.deepEqual(out, { quoted: 1, errors: 0 })

    assert.equal(calls.length, 1)
    assert.equal(
      calls[0].command,
      `/quote acme-roofing-danbury --notes ${join(h.dirs[0], 'notes.md')} --yes`
    )
    assert.equal(calls[0].cwd, '/w/os')

    // The notes file carries Brandon's notes and nothing invented.
    assert.equal(
      await readFile(join(h.dirs[0], 'notes.md'), 'utf8'),
      '- standard build, ~$4k\n- wants online booking\n'
    )

    assert.deepEqual(h.pushes, [
      { paths: ['/w/os/clients/a/quote/q.pdf'], message: 'quote: acme-roofing-danbury' },
    ])

    // slug claim, then the stage move that carries quote_path. Siblings survive.
    assert.deepEqual(h.updates[0], { id: 'b1', patch: { os_slug: 'acme-roofing-danbury' } })
    assert.equal(h.updates[1].patch.stage, 'quoted')
    const written = JSON.parse(h.updates[1].patch.research)
    assert.equal(written.quote_path, 'clients/acme-roofing-danbury/quote/')
    assert.equal(written.fit, 'good')
    assert.deepEqual(written.notes, ['standard build, ~$4k', 'wants online booking'])
    assert.equal(written.owner_name, 'Dana Acme')

    // No money is invented on the clients row.
    assert.deepEqual(h.inserts, [
      { slug: 'acme-roofing-danbury', display_name: 'Acme Roofing', business_id: 'b1' },
    ])
    assert.equal(h.inserts[0].monthly_rate_cents, undefined)
    assert.equal(h.inserts[0].build_fee_cents, undefined)

    assert.deepEqual(kinds(h.events), ['quoted'])
    assert.equal(h.events[0].detail.quote_path, 'clients/acme-roofing-danbury/quote/')
  } finally {
    await h.cleanup()
  }
})

test('the clients insert happens exactly once across two runs on the same row', async () => {
  const h = harness({ rows: [biz()] })
  try {
    await quote(h.deps)
    const second = await quote(h.deps)

    assert.equal(h.inserts.length, 1)
    assert.deepEqual(second, { quoted: 0, errors: 0 })
    // Re-running on a `quoted` row is a no-op with a skipped event.
    assert.equal(h.store[0].stage, 'quoted')
    assert.deepEqual(kinds(h.events), ['quoted', 'skipped'])
    assert.equal(h.pushes.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a clients row already there for the business is not inserted again', async () => {
  const h = harness({
    rows: [biz()],
    clients: [{ slug: 'acme-roofing-danbury', display_name: 'Acme Roofing', business_id: 'b1' }],
  })
  try {
    await quote(h.deps)
    assert.deepEqual(h.inserts, [])
    assert.equal(h.store[0].stage, 'quoted')
  } finally {
    await h.cleanup()
  }
})

test('a quoting row with no notes waits instead of quoting from nothing', async () => {
  let called = 0
  const h = harness({
    rows: [biz({ research: RESEARCH({ notes: [] }) })],
    runSkill: async () => (called++, { wrote: [], dryrun: [] }),
  })
  const out = await quote(h.deps)
  assert.equal(called, 0)
  assert.deepEqual(out, { quoted: 0, errors: 0 })
  assert.deepEqual(kinds(h.events), ['skipped'])
  assert.deepEqual(h.updates, [])
})

test('a throwing runSkill writes an error event and leaves the row at quoting', async () => {
  const h = harness({
    rows: [biz()],
    runSkill: async () => {
      throw Object.assign(new Error('skill run failed'), { stderr: 'claude: not found' })
    },
  })
  try {
    const out = await quote(h.deps)
    assert.deepEqual(out, { quoted: 0, errors: 1 })
    assert.deepEqual(kinds(h.events), ['error'])
    assert.match(h.events[0].detail.command, /^\/quote acme-roofing-danbury --notes /)
    assert.equal(h.store[0].stage, 'quoting')
    assert.deepEqual(h.pushes, [])
    assert.deepEqual(h.inserts, [])
  } finally {
    await h.cleanup()
  }
})

test('no ~/os clone is a skipped event, never a throw', async () => {
  const h = harness({ rows: [biz()] })
  const out = await quote({ ...h.deps, osDir: undefined, runSkill: undefined, commitAndPush: undefined })
  assert.deepEqual(out.skipped, ['osDir', 'runSkill', 'commitAndPush'])
  assert.match(h.events[0].detail.reason, /missing deps/)
})

// --- the dry-run marker rule, driven through both real jobs -----------------

test('a dry-run quote tick marks nothing and leaves the row quotable next tick', async () => {
  const h = harness({ rows: [biz()], push: { dryRun: true, commands: ['git push'] } })
  try {
    const out = await quote(h.deps)
    assert.deepEqual(out, { quoted: 0, errors: 0 })
    // Only the slug claim was written — no stage move, no quote_path, no client.
    assert.deepEqual(h.updates.map((u) => Object.keys(u.patch)), [['os_slug']])
    assert.equal(h.store[0].stage, 'quoting')
    assert.equal(JSON.parse(h.store[0].research).quote_path, undefined)
    assert.deepEqual(h.inserts, [])
    assert.deepEqual(kinds(h.events), ['skipped'])
    assert.match(h.events[0].detail.reason, /dry run/)
    assert.deepEqual(h.events[0].detail.commands, ['git push'])

    // The second tick, live this time, quotes it for real.
    h.deps.commitAndPush = async (opts) => (h.pushes.push(opts), { dryRun: false, commands: [] })
    const live = await quote(h.deps)
    assert.deepEqual(live, { quoted: 1, errors: 0 })
    assert.equal(h.store[0].stage, 'quoted')
    assert.equal(h.inserts.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a dry-run pitch tick marks nothing and leaves the row pitchable next tick', async () => {
  const h = harness({
    rows: [biz({ stage: 'call_due' })],
    push: { dryRun: true, commands: ['git push'] },
  })
  try {
    const out = await pitch(h.deps)
    assert.deepEqual(out, { pitched: 0, errors: 0 })
    assert.deepEqual(h.updates.map((u) => Object.keys(u.patch)), [['os_slug']])
    assert.equal(JSON.parse(h.store[0].research).pitch_path, undefined)
    assert.deepEqual(kinds(h.events), ['skipped'])
    assert.match(h.events[0].detail.reason, /dry run/)

    h.deps.commitAndPush = async (opts) => (h.pushes.push(opts), { dryRun: false, commands: [] })
    const live = await pitch(h.deps)
    assert.deepEqual(live, { pitched: 1, errors: 0 })
    assert.equal(JSON.parse(h.store[0].research).pitch_path, 'clients/acme-roofing-danbury/pitch/')
  } finally {
    await h.cleanup()
  }
})

// --- fix 1: the dry-run guard sits before the paid skill call ---------------
//
// `pushOrSkip` leaving the row unmarked is the second line of defence, tested
// above. These prove the first: under DRY_RUN nothing is ever handed to the
// Claude CLI, so a row cannot cost 37 sonnet runs a weekday forever.

test('a DRY_RUN quote tick makes no skill call at all, and stays quotable', async () => {
  const calls = []
  const h = harness({
    rows: [biz()],
    runSkill: async (opts) => (calls.push(opts), { wrote: ['/w/os/x.pdf'], dryrun: [] }),
  })
  h.deps.dryRun = true
  try {
    const out = await quote(h.deps)
    assert.deepEqual(out, { quoted: 0, errors: 0 })

    // Observable state, not just the mock: nothing ran, nothing was pushed.
    assert.deepEqual(calls, [])
    assert.deepEqual(h.pushes, [])
    assert.deepEqual(h.inserts, [])
    assert.equal(h.store[0].stage, 'quoting')
    assert.equal(JSON.parse(h.store[0].research).quote_path, undefined)
    // Only the slug claim, which is deliberately idempotent.
    assert.deepEqual(h.updates.map((u) => Object.keys(u.patch)), [['os_slug']])

    // The skipped event carries the command a live tick would have run.
    assert.deepEqual(kinds(h.events), ['skipped'])
    assert.match(h.events[0].detail.reason, /dry run/)
    assert.equal(
      h.events[0].detail.command,
      `/quote acme-roofing-danbury --notes ${join(h.dirs[0], 'notes.md')} --yes`
    )

    // The row is untouched, so the next live tick quotes it for real.
    h.deps.dryRun = false
    assert.deepEqual(await quote(h.deps), { quoted: 1, errors: 0 })
    assert.equal(calls.length, 1)
    assert.equal(h.store[0].stage, 'quoted')
  } finally {
    await h.cleanup()
  }
})

test('a DRY_RUN pitch tick makes no skill call at all, and stays pitchable', async () => {
  const calls = []
  const h = harness({
    rows: [biz({ stage: 'call_due' })],
    runSkill: async (opts) => (calls.push(opts), { wrote: ['/w/os/x.md'], dryrun: [] }),
  })
  h.deps.dryRun = true
  try {
    const out = await pitch(h.deps)
    assert.deepEqual(out, { pitched: 0, errors: 0 })

    assert.deepEqual(calls, [])
    assert.deepEqual(h.pushes, [])
    assert.equal(h.store[0].stage, 'call_due')
    assert.equal(JSON.parse(h.store[0].research).pitch_path, undefined)
    assert.deepEqual(h.updates.map((u) => Object.keys(u.patch)), [['os_slug']])

    assert.deepEqual(kinds(h.events), ['skipped'])
    assert.match(h.events[0].detail.reason, /dry run/)
    assert.match(h.events[0].detail.command, /^\/pitch acme-roofing-danbury --facts /)

    h.deps.dryRun = false
    assert.deepEqual(await pitch(h.deps), { pitched: 1, errors: 0 })
    assert.equal(calls.length, 1)
    assert.equal(
      JSON.parse(h.store[0].research).pitch_path,
      'clients/acme-roofing-danbury/pitch/'
    )
  } finally {
    await h.cleanup()
  }
})

// --- fix 3: a skill that wrote nothing is an error, not a push -------------
//
// `git add` with no pathspec is a no-op and the `git commit` after it exits
// non-zero, so pushing an empty `wrote` is a permanent failing loop.

test('a quote skill run that wrote nothing is an error event and no push', async () => {
  const h = harness({ rows: [biz()], runSkill: async () => ({ wrote: [], dryrun: [] }) })
  try {
    const out = await quote(h.deps)
    assert.deepEqual(out, { quoted: 0, errors: 1 })
    assert.deepEqual(h.pushes, [])
    assert.deepEqual(h.inserts, [])
    assert.equal(h.store[0].stage, 'quoting')
    assert.deepEqual(kinds(h.events), ['error'])
    assert.match(h.events[0].detail.error, /no written files/)
    assert.match(h.events[0].detail.command, /^\/quote acme-roofing-danbury /)
    assert.equal(h.events[0].detail.business, 'b1')
  } finally {
    await h.cleanup()
  }
})

test('a pitch skill run that wrote nothing is an error event and no push', async () => {
  const h = harness({
    rows: [biz({ stage: 'call_due' })],
    runSkill: async () => ({ wrote: [], dryrun: [] }),
  })
  try {
    const out = await pitch(h.deps)
    assert.deepEqual(out, { pitched: 0, errors: 1 })
    assert.deepEqual(h.pushes, [])
    assert.equal(JSON.parse(h.store[0].research).pitch_path, undefined)
    assert.deepEqual(kinds(h.events), ['error'])
    assert.match(h.events[0].detail.error, /no written files/)
    assert.match(h.events[0].detail.command, /^\/pitch acme-roofing-danbury /)
  } finally {
    await h.cleanup()
  }
})

// --- the mail ---------------------------------------------------------------

test('the quoted mail names the quote path and asks for a signed reply', () => {
  const mail = quoteReadyEmail(
    biz({ stage: 'quoted', research: RESEARCH({ quote_path: 'clients/acme-roofing-danbury/quote/' }) })
  )
  assert.equal(mail.subject, '[pipeline] quote ready for Acme Roofing')
  assert.match(mail.text, /^Quote ready for Acme Roofing\./)
  assert.match(mail.text, /clients\/acme-roofing-danbury\/quote\//)
  assert.match(mail.text, /\bsigned\b/)
  assert.match(mail.text, /Send it to the client yourself/)
  // Not one prospect address is chosen here; the caller pairs it with the
  // internal allow-list.
  assert.equal(mail.to, undefined)
})
