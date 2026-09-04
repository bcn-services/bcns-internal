// Item 22 — the SMTP transport, per mailbox. Pure: nodemailer is never
// touched, a fake `createTransport` records what it was asked to build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  mailboxEnvKey,
  resolveMailboxAuth,
  createMailboxTransport,
  MissingMailboxCredentials,
} from '../jobs/run.mjs'

const OUTREACH = 'outreach@send.bcn-services.com'
const OUTREACH_KEY = 'OUTREACH_SEND_BCN_SERVICES_COM'
const SECOND = 'outreach@bcns-mail.example'
const SECOND_KEY = 'OUTREACH_BCNS_MAIL_EXAMPLE'

test('mailboxEnvKey upper-cases and collapses every non-alphanumeric run', () => {
  assert.equal(mailboxEnvKey(OUTREACH), OUTREACH_KEY)
  assert.equal(mailboxEnvKey(SECOND), SECOND_KEY)
  assert.equal(mailboxEnvKey(''), '')
})

test('resolveMailboxAuth prefers the per-mailbox pair over the fallback', () => {
  const env = {
    [`SMTP_MAILBOX_${OUTREACH_KEY}_USER`]: 'per-mailbox-user',
    [`SMTP_MAILBOX_${OUTREACH_KEY}_PASS`]: 'per-mailbox-pass',
    SMTP_USER: 'fallback-user',
    SMTP_PASS: 'fallback-pass',
    MAIL_FROM: OUTREACH,
  }
  assert.deepEqual(resolveMailboxAuth(OUTREACH, env), { user: 'per-mailbox-user', pass: 'per-mailbox-pass' })
})

test('resolveMailboxAuth falls back to SMTP_USER/SMTP_PASS only for the address MAIL_FROM names', () => {
  const env = { SMTP_USER: 'nate', SMTP_PASS: 'app-password', MAIL_FROM: OUTREACH }
  assert.deepEqual(resolveMailboxAuth(OUTREACH, env), { user: 'nate', pass: 'app-password' })
  // A display-name form of MAIL_FROM still matches on the bare address.
  assert.deepEqual(resolveMailboxAuth(OUTREACH, { ...env, MAIL_FROM: `bcns <${OUTREACH}>` }), {
    user: 'nate',
    pass: 'app-password',
  })
})

test('resolveMailboxAuth honours SMTP_MAILBOX_DEFAULT over MAIL_FROM', () => {
  const env = {
    SMTP_USER: 'nate',
    SMTP_PASS: 'app-password',
    MAIL_FROM: 'bot@bcn-services.com',
    SMTP_MAILBOX_DEFAULT: OUTREACH,
  }
  assert.deepEqual(resolveMailboxAuth(OUTREACH, env), { user: 'nate', pass: 'app-password' })
  assert.equal(resolveMailboxAuth('bot@bcn-services.com', env), null)
})

// The load-bearing guarantee: a mailbox that matches NEITHER scheme gets
// nothing — never another mailbox's pair, however plausible-looking.
test('resolveMailboxAuth returns null for a mailbox with no credentials anywhere, never someone else\'s', () => {
  const env = {
    [`SMTP_MAILBOX_${OUTREACH_KEY}_USER`]: 'outreach-user',
    [`SMTP_MAILBOX_${OUTREACH_KEY}_PASS`]: 'outreach-pass',
    SMTP_USER: 'nate',
    SMTP_PASS: 'app-password',
    MAIL_FROM: OUTREACH,
  }
  // SECOND has no SMTP_MAILBOX_<key>_* pair, and it is not the MAIL_FROM /
  // SMTP_MAILBOX_DEFAULT address either.
  assert.equal(resolveMailboxAuth(SECOND, env), null)
})

test('createMailboxTransport builds one transport per address, caches it, and never crosses addresses', async () => {
  const env = {
    [`SMTP_MAILBOX_${OUTREACH_KEY}_USER`]: 'outreach-user',
    [`SMTP_MAILBOX_${OUTREACH_KEY}_PASS`]: 'outreach-pass',
    [`SMTP_MAILBOX_${SECOND_KEY}_USER`]: 'second-user',
    [`SMTP_MAILBOX_${SECOND_KEY}_PASS`]: 'second-pass',
    SMTP_HOST: 'smtp.test',
    SMTP_PORT: '465',
  }
  const built = []
  const fakeCreateTransport = async (opts) => {
    built.push(opts)
    return { auth: opts.auth, sendMail: async () => {} }
  }
  const transport = createMailboxTransport(env, fakeCreateTransport)

  const a = await transport({ address: OUTREACH })
  const b = await transport({ address: SECOND })
  assert.equal(a.auth.user, 'outreach-user')
  assert.equal(b.auth.user, 'second-user')
  assert.equal(built.length, 2, 'one construction per address so far')

  // Calling again for the same address reuses the cached transport.
  const aAgain = await transport({ address: OUTREACH })
  assert.equal(aAgain, a)
  assert.equal(built.length, 2, 'no second construction for an address already cached')
})

test('createMailboxTransport rejects a mailbox with no credentials, and never substitutes another one\'s', async () => {
  const env = {
    [`SMTP_MAILBOX_${OUTREACH_KEY}_USER`]: 'outreach-user',
    [`SMTP_MAILBOX_${OUTREACH_KEY}_PASS`]: 'outreach-pass',
  }
  const built = []
  const transport = createMailboxTransport(env, async (opts) => {
    built.push(opts)
    return { auth: opts.auth }
  })

  assert.equal(transport.hasCredentials(SECOND), false)
  await assert.rejects(transport({ address: SECOND }), MissingMailboxCredentials)
  assert.equal(built.length, 0, 'never constructed anything for the uncredentialed address')

  // The credentialed mailbox is unaffected by the other one's failure.
  const ok = await transport({ address: OUTREACH })
  assert.equal(ok.auth.user, 'outreach-user')
})

test('called with no mailbox at all, the factory keeps the old single-transport behaviour (poll/notify)', async () => {
  const env = { SMTP_USER: 'bot-user', SMTP_PASS: 'bot-pass' }
  const built = []
  const transport = createMailboxTransport(env, async (opts) => {
    built.push(opts)
    return { auth: opts.auth }
  })
  const first = await transport()
  const second = await transport()
  assert.equal(first.auth.user, 'bot-user')
  assert.equal(first, second, 'cached under its own slot, same as a single global transport')
  assert.equal(built.length, 1)
})

// Mutation check #2 (caution guardrail): no hardcoded @bcn-services.com
// address may survive as a credential default in the mailbox-transport
// section of jobs/run.mjs. Scoped to that section deliberately — IMAP_USER's
// and notifyFrom's bcn-services.com defaults are unrelated routing/IMAP
// concerns this item does not touch.
test('no literal @bcn-services.com credential default survives in the mailbox transport code', () => {
  const src = readFileSync(new URL('../jobs/run.mjs', import.meta.url), 'utf8')
  const start = src.indexOf('export function mailboxEnvKey')
  const end = src.indexOf('// Deps are built from the environment alone')
  assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate the mailbox-transport section')
  const section = src.slice(start, end)
  assert.ok(!/@bcn-services\.com/.test(section), 'a literal address default leaked back into credential resolution')
})
