// Onboard: the intake run, the markers, and the one-recipient handover mail.
//
// Every boundary is a fake. The Claude CLI is never spawned, and the only
// filesystem touched is a temp dir standing in for the ~/os clone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run as onboard, bumpReadmeStatus } from '../jobs/onboard.mjs'
import { run as notify, onboardedEmail, TEMPLATES, NOTIFY_STAGES } from '../jobs/notify.mjs'
import { commitDefaults } from '../jobs/run.mjs'
import { commitAndPush } from '../lib/osrepo.mjs'

const SLUG = 'acme-roofing-danbury'

// What ~/os/clients/_TEMPLATE.md produces: frontmatter first, `status: lead`.
const README = `---
name: Acme Roofing
slug: ${SLUG}
status: lead
---

# Acme Roofing

Their status: lead line in the body is prose and must survive untouched.
`

const RESEARCH = (over = {}) =>
  JSON.stringify({
    facts: ['no online booking'],
    owner_name: 'Dana Acme',
    notes: ['wants a portal for his crews'],
    quote_path: `clients/${SLUG}/quote/`,
    ...over,
  })

const biz = (over = {}) => ({
  id: 'b1',
  name: 'Acme Roofing',
  domain: 'acmeroofing.example',
  town: 'Danbury',
  state: 'CT',
  trade: 'roofing',
  place_id: 'ChIJabcdef123456',
  stage: 'won',
  os_slug: null,
  research: RESEARCH(),
  ...over,
})

const client = (over = {}) => ({
  business_id: 'b1',
  slug: SLUG,
  signed_at: '2026-08-30T15:04:00Z',
  contract_path: 'clients/acme/contract.pdf',
  ...over,
})

// The fake skill runner. Its output is built from the SKILL.md contract:
// `/intake` prints the checklist and the request email. The README already
// exists here (as it would from an earlier `/pitch` run); `/intake` only
// creates it when one is missing, which onboard.mjs doesn't depend on either
// way — it just needs the README to exist by the time it reads it.
function fakeSkills(osDir, calls) {
  return async ({ command, cwd }) => {
    calls.push({ command, cwd })
    return {
      wrote: [
        join(osDir, 'clients', SLUG, 'intake/checklist.md'),
        join(osDir, 'clients', SLUG, 'intake/request-email.md'),
      ],
      dryrun: [],
    }
  }
}

async function harness({ rows = [biz()], clients = [client()], dryRun = false, push = { dryRun: false, commands: [] } } = {}) {
  const osDir = await mkdtemp(join(tmpdir(), 'onboard-os-'))
  const temps = [osDir]
  // The README exists already, as it would from an earlier /pitch run.
  await mkdir(join(osDir, 'clients', SLUG), { recursive: true })
  await writeFile(join(osDir, 'clients', SLUG, 'README.md'), README)
  const events = []
  const calls = []
  const pushes = []
  const clientPatches = []
  const store = rows.map((r) => ({ ...r }))
  const roster = clients.map((c) => ({ ...c }))

  const deps = {
    sql: {},
    db: {
      logEvent: (_s, job, kind, detail) => (events.push({ job, kind, detail }), Promise.resolve([])),
      businessesByStage: (_s, stage) => Promise.resolve(store.filter((r) => r.stage === stage)),
      updateBusiness: async (_s, id, patch) => {
        Object.assign(store.find((r) => r.id === id), patch)
        return []
      },
      clientByBusiness: async (_s, id) => roster.filter((c) => c.business_id === id),
      updateClient: async (_s, id, patch) => {
        clientPatches.push({ id, patch })
        Object.assign(roster.find((c) => c.business_id === id), patch)
        return []
      },
    },
    osDir,
    dryRun,
    runSkill: fakeSkills(osDir, calls),
    commitAndPush: async (opts) => (pushes.push(opts), push),
  }
  return {
    deps,
    osDir,
    events,
    calls,
    pushes,
    clientPatches,
    store,
    roster,
    cleanup: () => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))),
  }
}

const kinds = (events) => events.map((e) => e.kind)
const commands = (calls) => calls.map((c) => c.command)

// --- the happy path ---------------------------------------------------------

test('the intake skill runs once and its paths are stored on the row', async () => {
  const h = await harness()
  try {
    const out = await onboard(h.deps)

    assert.equal(out.onboarded, 1)
    assert.equal(out.errors, 0)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(commands(h.calls), [`/intake ${SLUG} --yes`])
    for (const c of h.calls) assert.equal(c.cwd, h.osDir)

    // No repo — onboard never touches the client row any more.
    assert.deepEqual(h.clientPatches, [])
    assert.equal(h.store[0].stage, 'onboarded')

    // notify reads these two off the row, so onboard has to write them.
    const research = JSON.parse(h.store[0].research)
    assert.equal(research.intake_checklist_path, `clients/${SLUG}/intake/checklist.md`)
    assert.equal(research.request_email_path, `clients/${SLUG}/intake/request-email.md`)
    // The sibling keys the other jobs wrote are still there.
    assert.equal(research.quote_path, `clients/${SLUG}/quote/`)
    assert.deepEqual(research.notes, ['wants a portal for his crews'])

    assert.deepEqual(kinds(h.events), ['onboarded'])
    assert.equal(h.pushes.length, 1)
    assert.equal(h.pushes[0].message, `onboard: ${SLUG}`)
    assert.ok(h.pushes[0].paths.includes(join(h.osDir, 'clients', SLUG, 'README.md')))
    assert.ok(h.pushes[0].paths.includes(join(h.osDir, 'clients', SLUG, 'intake/checklist.md')))
  } finally {
    await h.cleanup()
  }
})

test('the README frontmatter status moves to in-progress and the body is left alone', async () => {
  const h = await harness()
  try {
    await onboard(h.deps)
    const text = await readFile(join(h.osDir, 'clients', SLUG, 'README.md'), 'utf8')
    assert.match(text, /^status: in-progress$/m)
    assert.ok(!/^status: lead$/m.test(text))
    assert.match(text, /Their status: lead line in the body/)
  } finally {
    await h.cleanup()
  }
})

test('bumpReadmeStatus rewrites only the frontmatter, and only status: lead/active', () => {
  assert.match(bumpReadmeStatus(README), /^status: in-progress$/m)
  // A repo built under the legacy per-client model stamped `active`; that
  // still moves too, for any client onboarded before this change.
  assert.match(bumpReadmeStatus(README.replace('status: lead', 'status: active')), /^status: in-progress$/m)
  // Already moved on: nothing to do, and no second rewrite.
  const done = README.replace('status: lead', 'status: in-progress')
  assert.equal(bumpReadmeStatus(done), done)
  // No frontmatter at all is returned untouched rather than half-rewritten.
  assert.equal(bumpReadmeStatus('# Acme\n\nstatus: lead\n'), '# Acme\n\nstatus: lead\n')
})

// --- what must not happen twice ---------------------------------------------

test('a second run over the same row makes zero skill calls and writes nothing', async () => {
  const h = await harness()
  try {
    await onboard(h.deps)
    const after = h.calls.length
    h.events.length = 0
    h.clientPatches.length = 0
    h.pushes.length = 0
    // The row is at `onboarded` now; put it back at `won` with its
    // intake_checklist_path to pin the research gate itself rather than the
    // stage read.
    h.store[0].stage = 'won'

    const second = await onboard(h.deps)

    assert.equal(second.onboarded, 0)
    assert.equal(second.errors, 0)
    assert.equal(h.calls.length, after, 'a second run called a skill again')
    assert.deepEqual(h.pushes, [])
    assert.deepEqual(h.clientPatches, [])
    assert.deepEqual(kinds(h.events), ['skipped'])
    assert.equal(h.store[0].stage, 'won', 'a second run moved the stage anyway')
  } finally {
    await h.cleanup()
  }
})

test('a won row with no signed_at is skipped, never onboarded', async () => {
  // Exactly what the manual `won 2400` command leaves behind: stage moved,
  // no contract, no signed_at.
  const h = await harness({ clients: [client({ signed_at: null, contract_path: null })] })
  try {
    const out = await onboard(h.deps)

    assert.equal(out.onboarded, 0)
    assert.deepEqual(h.calls, [], 'a skill ran for an unsigned row')
    assert.deepEqual(h.pushes, [])
    assert.deepEqual(h.clientPatches, [])
    assert.equal(h.store[0].stage, 'won')
    assert.deepEqual(kinds(h.events), ['skipped'])
    assert.match(h.events[0].detail.reason, /signed_at/)
  } finally {
    await h.cleanup()
  }
})

test('a won row with no client row is skipped', async () => {
  const h = await harness({ clients: [] })
  try {
    const out = await onboard(h.deps)
    assert.equal(out.onboarded, 0)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(kinds(h.events), ['skipped'])
  } finally {
    await h.cleanup()
  }
})

// --- dry run costs nothing ---------------------------------------------------

test('a dry run makes no skill call and marks nothing', async () => {
  const h = await harness({ dryRun: true })
  try {
    const out = await onboard(h.deps)

    assert.equal(out.onboarded, 0)
    assert.equal(out.errors, 0)
    assert.deepEqual(h.calls, [], 'a dry run called a skill')
    assert.deepEqual(h.pushes, [], 'a dry run pushed')
    assert.deepEqual(h.clientPatches, [])
    assert.equal(h.store[0].stage, 'won')
    assert.deepEqual(kinds(h.events), ['skipped'])
    assert.match(h.events[0].detail.command, /^\/intake acme-roofing-danbury --yes$/)
  } finally {
    await h.cleanup()
  }
})

test('a push that turns out to be a dry run leaves the row unmarked', async () => {
  const h = await harness({ push: { dryRun: true, commands: ['git push'] } })
  try {
    const out = await onboard(h.deps)
    assert.equal(out.onboarded, 0)
    assert.deepEqual(h.clientPatches, [])
    assert.equal(h.store[0].stage, 'won')
    assert.deepEqual(kinds(h.events), ['skipped'])
  } finally {
    await h.cleanup()
  }
})

test('an /intake run with no wrote: list is an error, not a half-onboard', async () => {
  const h = await harness()
  try {
    h.deps.runSkill = async ({ command }) => {
      h.calls.push({ command })
      return { wrote: [], dryrun: [] }
    }
    const out = await onboard(h.deps)
    assert.equal(out.errors, 1)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.pushes, [])
    assert.equal(h.store[0].stage, 'won')
    assert.deepEqual(kinds(h.events), ['error'])
    assert.match(h.events[0].detail.error, /nothing to commit/)
  } finally {
    await h.cleanup()
  }
})

test('onboard writes a skipped event when it has no ~/os to work in', async () => {
  const events = []
  const out = await onboard({
    sql: {},
    db: { logEvent: (_s, job, kind, detail) => (events.push({ kind, detail }), Promise.resolve([])) },
  })
  assert.equal(out.onboarded, 0)
  assert.deepEqual(kinds(events), ['skipped'])
})

// --- the handover mail ------------------------------------------------------

// Literals, never the module's own values: a widened list has to fail here.
const INTERNAL = ['nseluga@bcn-services.com', 'bchung@bcn-services.com']
const ONBOARD_TO = 'ops@bcn-services.com'

const onboardedRow = (over = {}) => ({
  id: 'b9',
  name: 'Acme Roofing',
  email: 'dana@acmeroofing.example',
  phone: '203-555-0142',
  town: 'Danbury',
  state: 'CT',
  stage: 'onboarded',
  next_touch_at: null,
  research: RESEARCH({
    intake_checklist_path: `clients/${SLUG}/intake/checklist.md`,
    request_email_path: `clients/${SLUG}/intake/request-email.md`,
  }),
  ...over,
})

function notifyHarness({
  rows = [onboardedRow()],
  onboardRecipient = ONBOARD_TO,
  internalRecipients = INTERNAL,
} = {}) {
  const events = []
  const sent = []
  const store = rows.map((r) => ({ ...r }))
  const deps = {
    sql: {},
    db: {
      unnotifiedByStage: (_s, stage) => Promise.resolve(store.filter((r) => r.stage === stage)),
      notifiedKeys: async () => [],
      firstOutbound: async () => [],
      logEvent: (_s, job, kind, detail) => (events.push({ job, kind, detail }), Promise.resolve([])),
      recordThread: async () => [],
      updateBusiness: () => {
        throw new Error('notify must never write a business row')
      },
    },
    // The real notifier, not an injected send: the allow-list gate has to run.
    transport: async () => ({ sendMail: async (m) => sent.push(m) }),
    internalRecipients,
    onboardRecipient,
    notifyFrom: 'bot@bcn-services.com',
    dryRun: false,
    now: new Date('2026-09-02T09:00:00Z'),
  }
  return { deps, events, sent }
}

test('the onboarded mail has exactly one recipient, the ONBOARD_NOTIFY_TO address', async () => {
  const h = notifyHarness()

  const out = await notify(h.deps)

  assert.equal(out.onboarded, 1)
  assert.equal(out.errors, 0)
  assert.equal(h.sent.length, 1, 'the handover mail went to more than one address')
  // A literal, not the module's variable.
  assert.deepEqual(h.sent[0].envelope.to, 'ops@bcn-services.com')
  for (const internal of ['nseluga@bcn-services.com', 'bchung@bcn-services.com']) {
    assert.ok(!h.sent.some((m) => m.envelope.to === internal), `${internal} got the handover mail`)
  }
  // The Subject header is literal in the MIME; the bodies are base64 parts.
  assert.match(h.sent[0].raw, /^Subject: Signed: Acme Roofing — your turn$/m)
  assert.equal(h.events.filter((e) => e.kind === 'notified').length, 1)
})

test('an unset ONBOARD_NOTIFY_TO mails nobody and writes an error event', async () => {
  const h = notifyHarness({ onboardRecipient: '' })

  const out = await notify(h.deps)

  assert.deepEqual(h.sent, [], 'the handover mail went out with no recipient configured')
  assert.equal(out.onboarded, 0)
  assert.equal(out.emails, 0)
  assert.equal(out.errors, 1)
  assert.deepEqual(kinds(h.events), ['error'])
  assert.match(h.events[0].detail.reason, /ONBOARD_NOTIFY_TO/)
  // Nothing was marked, so a run with the variable set still mails it.
  assert.equal(h.events.filter((e) => e.kind === 'notified').length, 0)
})

// Fix 4 — the handover mail has its own independent allow-list, so an empty
// NOTIFY_ALLOWED_RECIPIENTS must not take it down with the internal mail. The
// failure this pins is silent: the early return logged a generic `skipped`
// and the fail-closed error below it never ran.
test('an empty internal allow-list still delivers the onboarded handover mail', async () => {
  const h = notifyHarness({ internalRecipients: [] })

  const out = await notify(h.deps)

  assert.equal(out.onboarded, 1)
  assert.equal(out.errors, 0)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0].envelope.to, 'ops@bcn-services.com')
  assert.ok(!kinds(h.events).includes('skipped'))
  assert.equal(h.events.filter((e) => e.kind === 'notified').length, 1)
})

// Both lists empty is genuinely nobody to mail: the early return stands, and
// the handover mail must not fall back to the internal list it never uses.
test('no internal allow-list and no ONBOARD_NOTIFY_TO mails nobody', async () => {
  const h = notifyHarness({ internalRecipients: [], onboardRecipient: '' })

  const out = await notify(h.deps)

  assert.deepEqual(h.sent, [])
  assert.equal(out.onboarded, 0)
  assert.equal(out.emails, 0)
  assert.deepEqual(kinds(h.events), ['skipped'])
  assert.match(h.events[0].detail.reason, /no allow-listed recipient/)
})

test('the onboarded body names the checklist and the request email', () => {
  const mail = onboardedEmail(onboardedRow())
  assert.equal(mail.subject, 'Signed: Acme Roofing — your turn')
  assert.match(mail.text, new RegExp(`Intake checklist: clients/${SLUG}/intake/checklist.md`))
  assert.match(mail.text, new RegExp(`Request email: clients/${SLUG}/intake/request-email.md`))

  // A row that reached `onboarded` without those keys still renders.
  const bare = { id: 'x', name: 'Bare Co', stage: 'onboarded', research: null }
  assert.equal(onboardedEmail(bare).subject, 'Signed: Bare Co — your turn')
  assert.ok(!/undefined|null|\[object/.test(onboardedEmail(bare).text))
})

test('the template lookup routes every stage to its own body', () => {
  assert.deepEqual(Object.keys(TEMPLATES), NOTIFY_STAGES)
  const row = { id: 'z', name: 'Acme Roofing', stage: 'x', research: null }
  assert.match(TEMPLATES.call_due(row).subject, /^\[pipeline\] call Acme Roofing/)
  assert.match(TEMPLATES.quoting(row).subject, /^\[pipeline\] quote Acme Roofing$/)
  assert.match(TEMPLATES.quoted(row).subject, /^\[pipeline\] quote ready for Acme Roofing$/)
  assert.match(TEMPLATES.onboarded(row).subject, /^Signed: Acme Roofing/)
})

// --- the push wiring --------------------------------------------------------

test('the ~/os push defaults carry an exec, so a live push has something to run git with', async () => {
  const opts = await commitDefaults({ OS_DIR: '/w/os', DRY_RUN: 'false' })
  assert.equal(typeof opts.exec, 'function', 'buildDeps wires commitAndPush without an exec')
  assert.equal(opts.dir, '/w/os')
  assert.equal(opts.dryRun, false)
  // Unset DRY_RUN is a dry run, the same default buildDeps applies.
  assert.equal((await commitDefaults({ OS_DIR: '/w/os' })).dryRun, true)
})

test('a live push with no exec wired in says so instead of calling undefined', async () => {
  await assert.rejects(
    () => commitAndPush({ dir: '/w/os', paths: ['a'], message: 'm', dryRun: false }),
    /needs an exec/
  )
  // A dry run still executes nothing at all and needs no exec.
  const dry = await commitAndPush({ dir: '/w/os', paths: ['a'], message: 'm' })
  assert.equal(dry.dryRun, true)
})
