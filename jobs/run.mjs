// The dispatcher. One entry point for every scheduled and manual run.
//
// It never catches a job's error: a failed job must fail the workflow run, or
// a broken pipeline looks green forever.

import { existsSync } from 'node:fs'

export const SCHEDULES = {
  // Read the inbox, then tell the humans what it left behind. Notify runs at
  // the end of the tick because it reports on what poll just wrote.
  // pitch/quote/onboard sit between them: each reads what poll just wrote and
  // notify reports on what they left behind. A module that is not built yet is
  // skipped by main(), not a failed tick.
  '*/20 8-20 * * 1-5': ['poll', 'pitch', 'quote', 'onboard', 'notify'],
  '0 14 * * 1-5': 'touch',
  // The Monday tick is a chain: source finds businesses, qualify reads the
  // ones it just wrote. Order is the contract, so it lives in this list.
  '0 13 * * 1': ['source', 'qualify'],
  // Half an hour after Monday's source+qualify and thirty minutes before the
  // 14:00 touch, so a row qualified this morning is drafted before touch looks
  // for something to send. Weekdays, not Mondays only: a retry of a draft that
  // failed validation needs a tick of its own.
  '30 13 * * 1-5': 'personalize',
}

export function jobNames({ schedule = '', job = '' } = {}) {
  const names = job.trim() ? [job.trim()] : [SCHEDULES[schedule.trim()] ?? []].flat()
  if (!names.length) {
    throw new Error(
      `no job for schedule ${JSON.stringify(schedule)} and input ${JSON.stringify(job)}`
    )
  }
  return names
}

export function jobName(input) {
  return jobNames(input)[0]
}

// Turn a mailbox address into the KEY half of `SMTP_MAILBOX_<KEY>_USER` /
// `SMTP_MAILBOX_<KEY>_PASS` — upper-cased, every run of non-alphanumerics
// collapsed to one underscore. `outreach@send.bcn-services.com` becomes
// `OUTREACH_SEND_BCN_SERVICES_COM`. See docs/NOTIFICATIONS.md.
export function mailboxEnvKey(address) {
  return String(address || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

// MAIL_FROM / SMTP_MAILBOX_DEFAULT may carry a display name; only the address
// is ever compared.
function bareAddress(value) {
  const m = /<([^>]+)>/.exec(String(value ?? ''))
  return (m ? m[1] : String(value ?? '')).trim().toLowerCase()
}

// Per-mailbox SMTP credentials, resolved from the environment and never
// mixed across addresses. Two sources, tried in this order — the scheme is
// documented in docs/NOTIFICATIONS.md:
//
//   1. `SMTP_MAILBOX_<KEY>_USER` / `SMTP_MAILBOX_<KEY>_PASS`, keyed by
//      `mailboxEnvKey(address)`.
//   2. `SMTP_USER` + `SMTP_PASS` — but ONLY for the one address already
//      wired tonight: the mailbox `SMTP_MAILBOX_DEFAULT` names, or
//      `MAIL_FROM`'s address when that variable is unset. This is what lets
//      the existing single mailbox keep sending with zero new secrets.
//
// Anything else is `null`. There is no third path: a mailbox matching
// neither has no credentials, full stop — never another mailbox's pair.
export function resolveMailboxAuth(address, env = process.env) {
  const key = mailboxEnvKey(address)
  const user = env[`SMTP_MAILBOX_${key}_USER`]
  const pass = env[`SMTP_MAILBOX_${key}_PASS`]
  if (user && pass) return { user, pass }

  const fallbackAddress = bareAddress(env.SMTP_MAILBOX_DEFAULT || env.MAIL_FROM)
  if (env.SMTP_USER && env.SMTP_PASS && fallbackAddress && fallbackAddress === bareAddress(address)) {
    return { user: env.SMTP_USER, pass: env.SMTP_PASS }
  }
  return null
}

export class MissingMailboxCredentials extends Error {
  constructor(address) {
    super(`no SMTP credentials configured for mailbox ${address}`)
    this.name = 'MissingMailboxCredentials'
    this.address = address
  }
}

async function defaultCreateTransport(opts) {
  const { default: nodemailer } = await import('nodemailer')
  return nodemailer.createTransport(opts)
}

// One nodemailer transport per mailbox address, built lazily and cached —
// never reused across addresses. Called with no mailbox at all (poll/notify's
// internal mail, which sends as `notifyFrom` rather than any row in
// `mailboxes`), it keeps today's behaviour exactly: one transport from
// SMTP_USER/SMTP_PASS, cached under its own slot. `createTransport` is
// injectable so tests can record what a transport was built with instead of
// touching nodemailer at all.
export function createMailboxTransport(env = process.env, createTransport = defaultCreateTransport) {
  const cache = new Map()
  const host = env.SMTP_HOST || 'smtp.gmail.com'
  const port = Number(env.SMTP_PORT) || 465

  const transport = async (mailbox) => {
    const address = mailbox?.address ?? null
    if (cache.has(address)) return cache.get(address)
    const auth = address
      ? resolveMailboxAuth(address, env)
      : env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : null
    if (!auth) throw new MissingMailboxCredentials(address ?? '(default)')
    const built = await createTransport({ host, port, secure: port === 465, auth })
    cache.set(address, built)
    return built
  }
  // Lets touch's mailbox picker skip an uncredentialed mailbox BEFORE
  // claiming its send slot, without constructing anything.
  transport.hasCredentials = (address) => Boolean(resolveMailboxAuth(address, env))
  return transport
}

// Deps are built from the environment alone, so what a job is handed is
// inspectable without a database or a Google token in sight. A missing
// credential means the job simply is not given that capability; jobs decide
// what to do about it and write their own skipped event.
export async function buildDeps(env = process.env, exists = existsSync) {
  const deps = {}
  if (env.DATABASE_URL) {
    const [{ default: postgres }, db] = await Promise.all([
      import('postgres'),
      import('../lib/db.mjs'),
    ])
    deps.sql = postgres(env.DATABASE_URL)
    deps.db = db
    deps.logEvent = db.logEvent
    // The grid lives in code; the table only tracks run state, so every run
    // reconciles the two before reading.
    const { GRID } = await import('../lib/grid.mjs')
    deps.loadCells = async () => {
      await db.upsertCells(deps.sql, GRID)
      return db.allCells(deps.sql)
    }
    deps.saveCell = (cell) => db.saveCell(deps.sql, cell)
  }

  // Keyless: the workflow's auth step mints this token, and mints nothing when
  // GCP is unconfigured. No token means no `places`/`readBudget` on deps at
  // all, so source writes a skipped event rather than spending blind.
  const token = env.CLOUDSDK_AUTH_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN || ''
  const project = env.GCP_PROJECT || ''
  if (token && project) {
    const [{ createPlaces }, { createReadBudget }] = await Promise.all([
      import('../lib/places.mjs'),
      import('../lib/budget.mjs'),
    ])
    deps.places = createPlaces({ token, project })
    deps.readBudget = createReadBudget({
      token,
      project,
      cap: Number(env.BCNS_PLACES_MONTHLY_CAP) || undefined,
    })
  }

  // No credential of its own, but capped on purpose: qualify feeds whatever
  // comes back into a prompt, so an unbounded page is an unbounded bill.
  deps.fetchPage = createFetchPage()

  // The CLI bills against the subscription through this OAuth token. There is
  // no API key path — no token means qualify has no `claude` and skips.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    const { claudeClient } = await import('../lib/claude.mjs')
    deps.claude = claudeClient()
  }

  // Verification needs an envelope sender to put in MAIL FROM; without one
  // there is no probe, and qualify simply trusts what it found.
  if (env.MAIL_FROM) {
    const [{ verifyEmail, smtpSession }, { resolveMx }, net] = await Promise.all([
      import('../lib/verify.mjs'),
      import('node:dns/promises'),
      import('node:net'),
    ])
    deps.verify = (address) =>
      verifyEmail(address, {
        resolveMx,
        from: env.MAIL_FROM,
        connect: (host) =>
          new Promise((resolve, reject) => {
            const socket = net.connect(25, host)
            socket.once('error', reject)
            socket.once('connect', () => resolve(smtpSession(socket)))
          }),
      })
  }

  // Two lists, deliberately not one. `allowedRecipients` is the hard gate the
  // touch job applies to every PROSPECT recipient, dry run or not.
  // `internalRecipients` is the set of internal humans poll/notify forward to,
  // and the only senders whose one-word commands (`no`, `won 2400`, `stop`)
  // are obeyed. Merging them means going live delivers every internal call task
  // and meeting alert to a prospect, forwards a prospect's own opt-out back to
  // them, and lets that prospect drive the pipeline.
  //
  // Both are unset means nobody is reachable — never everybody. Widening either
  // is a manual edit of the repo variable, never a default here.
  const list = (v) =>
    String(v || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
  deps.allowedRecipients = list(env.SEND_ALLOWED_RECIPIENTS)
  deps.internalRecipients = list(env.NOTIFY_ALLOWED_RECIPIENTS)
  // A third list of exactly one, and deliberately not part of either. The
  // `onboarded` mail hands over a signed client and goes to one person; unset
  // means notify mails nobody about it, never the internal list.
  deps.onboardRecipient = String(env.ONBOARD_NOTIFY_TO || '').trim()

  // SMTP is a capability like any other: no credentials, no transport, and
  // touch writes a skipped event instead of half-sending. The transport is a
  // per-MAILBOX factory (createMailboxTransport, above) and nothing connects
  // until a send has already cleared the allow-list gate. A global SMTP_PASS
  // OR any SMTP_MAILBOX_*_PASS is enough to build the factory — which
  // mailbox actually has credentials is resolveMailboxAuth's call, not this
  // one's.
  const hasMailboxCreds =
    Boolean(env.SMTP_PASS) ||
    Object.keys(env).some((k) => k.startsWith('SMTP_MAILBOX_') && k.endsWith('_PASS'))
  if (hasMailboxCreds) {
    deps.transport = createMailboxTransport(env)
  }

  // IMAP is the poller's only input. Same app password as SMTP, one label.
  // No password means poll writes a skipped event rather than a half-read inbox.
  if (env.IMAP_PASS) {
    deps.imap = createImap({
      host: env.IMAP_HOST || 'imap.gmail.com',
      port: Number(env.IMAP_PORT) || 993,
      user: env.IMAP_USER || 'nseluga@bcn-services.com',
      pass: env.IMAP_PASS,
      mailbox: env.IMAP_MAILBOX || 'pipeline',
    })
  }
  deps.notifyFrom = env.NOTIFY_FROM || 'bot@bcn-services.com'
  deps.outreachAddress = env.SMTP_USER || 'outreach@send.bcn-services.com'

  // The voice rules are a capability like SMTP: clock.yml clones ~/os and sets
  // OS_DIR, and without that clone personalize has nothing to read. No OS_DIR
  // means no reader, which is the case personalize already logs and drafts
  // through — an unvoiced draft, never a failed run. Same path authcheck
  // reports on, so one dispatch tells you whether this will work.
  //
  // The probe is the directory, not the variable: clock.yml sets OS_DIR
  // unconditionally, so a failed or skipped clone leaves the variable pointing
  // at nothing. Resolving it once here is what makes every `!osDir` skip
  // downstream honest — a missing ~/os is a `skipped` event, never a throw.
  const osDir = env.OS_DIR && exists(env.OS_DIR) ? env.OS_DIR : null

  if (osDir) {
    deps.readVoiceRules = async () => {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return readFile(join(osDir, 'knowledge/library/bcns-voice/voice-rules.md'), 'utf8')
    }
  }

  deps.dryRun = env.DRY_RUN !== 'false'

  // The skill runner and the ~/os push helper. Both only make sense against
  // the clone, so both appear only when OS_DIR does — same rule as the voice
  // rules above. commitAndPush is bound to this run's dryRun so no module
  // reads process.env to decide whether it is allowed to push.
  if (osDir) {
    deps.osDir = osDir
    const [{ runSkill }, { commitAndPush }] = await Promise.all([
      import('../lib/skills.mjs'),
      import('../lib/osrepo.mjs'),
    ])
    deps.runSkill = (opts) => runSkill({ cwd: osDir, ...opts })
    // `...opts` last on purpose, so a caller can override — but the defaults
    // must be complete on their own: a missing `exec` here made every live
    // push call undefined(). commitDefaults is where that is asserted.
    const defaults = await commitDefaults(env, deps.dryRun)
    deps.commitAndPush = (opts) => commitAndPush({ ...defaults, ...opts })
  }

  return deps
}

// The default options every ~/os push is made with. Exported so the wiring can
// be asserted without executing a push: `exec` going missing here is the whole
// bug this exists to catch.
export async function commitDefaults(env = process.env, dryRun = env.DRY_RUN !== 'false') {
  const { run: exec } = await import('../lib/claude.mjs')
  return { exec, dir: env.OS_DIR, dryRun }
}

// mailparser only html→text converts when the html node is the root or a
// text/plain part exists, so an html-only `multipart/related` reply (an Outlook
// or Gmail reply carrying an inline image) arrives with `parsed.text ===
// undefined`. An empty body reads as "not an opt-out", which is precisely the
// invisible false negative this pipeline cannot afford, so the text is derived
// from the html here instead. No new dependency: html-to-text is only a
// mailparser transitive and importing it directly would make it undeclared.
const BLOCK = /<\/?(?:br|p|div|tr|td|th|li|h[1-6]|table|blockquote)\b[^>]*>/gi
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // rsquo only: it is the apostrophe in `don&rsquo;t`, which patterns match on.
  // No pattern reads a double or opening quote, so the other three earn nothing.
  rsquo: '\u2019',
}

export function htmlToText(html) {
  return String(html ?? '')
    // The inner run may not cross a second opener: an unbalanced `<style>` (or
    // `<!--`) otherwise lets the strip run on to the NEXT one and delete the
    // real body in between — a silently missed opt-out, the exact failure this
    // file exists to avoid.
    .replace(/<(script|style)\b[^>]*>(?:(?!<\1\b)[\s\S])*?<\/\1>/gi, ' ')
    .replace(/<!--(?:(?!<!--)[\s\S])*?-->/g, ' ')
    .replace(BLOCK, '\n')
    // Inline tags close up rather than separate: `<b>un</b>subscribe` must read
    // as one word, or the opt-out pattern misses it. Block tags above already
    // supplied the break.
    // ponytail: regex tag strip — an unbalanced <style> or <!-- now leaks its
    // own text rather than eating the body after it, and an attribute
    // containing a literal `>` leaks attribute text. Both are additive noise in
    // a body we only pattern-match; reach for a real parser if either ever
    // produces a false opt-out.
    .replace(/<[^>]*>/g, '')
    // Numeric entities decode by code point, so hex (`&#x27;`) works alongside
    // decimal (`&#39;`); a curly apostrophe that survives is folded to ASCII by
    // the opt-out matcher.
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
      // Out-of-range code points throw a RangeError out of String.fromCodePoint,
      // and this runs inside the poller's message drain: one `&#x110000;` from a
      // stranger would stall every tick forever. Anything outside Unicode (and
      // the lone surrogates, which are unusable output) stays literal text.
      const n = Number(e[1].toLowerCase() === 'x' ? `0x${e.slice(2)}` : e.slice(1))
      return n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The plain object the poller sees. Pure, so the html-only case is testable
// without a mailbox.
export function toMessage(parsed, uid, header) {
  const get = header ?? ((name) => {
    const v = parsed.headers?.get?.(name)
    return Array.isArray(v) ? v[0] : v
  })
  return {
    uid,
    from: parsed.from?.value?.[0]?.address ?? '',
    deliveredTo: String(get('delivered-to') ?? get('x-original-to') ?? ''),
    subject: parsed.subject ?? '',
    text: parsed.text || htmlToText(parsed.html),
    messageId: parsed.messageId ?? '',
    inReplyTo: parsed.inReplyTo ?? '',
    references: [parsed.references ?? []].flat().join(' '),
    headers: Object.fromEntries(
      ['auto-submitted', 'x-autoreply', 'x-autorespond'].map((n) => [n, String(get(n) ?? '')])
    ),
    // Always an array. mailparser gives `{ contentType, size, content: Buffer,
    // filename }`; a real contentType carries parameters and arbitrary case
    // (`Application/PDF; name=x.pdf`), so it is normalised once here rather
    // than at every place a consumer compares it.
    attachments: [...(parsed.attachments ?? [])].map((a) => ({
      contentType: String(a?.contentType ?? '').split(';')[0].trim().toLowerCase(),
      size: Number(a?.size ?? a?.content?.length ?? 0),
      filename: a?.filename ?? '',
      content: a?.content ?? null,
    })),
  }
}

// One tick is bounded: an unbounded drain can outrun the 20-minute cron and let
// two pollers work the same backlog. The remainder waits for the next tick.
export const MAX_MESSAGES_PER_TICK = 100

export async function drainMessages(source, parse, limit = MAX_MESSAGES_PER_TICK) {
  const out = []
  for await (const msg of source) {
    out.push(toMessage(await parse(msg.source), msg.uid))
    if (out.length >= limit) break
  }
  return out
}

// The IMAP boundary, kept as thin as it can be: connect, hand back plain
// objects, close. Everything downstream of this is a pure function of those
// objects, which is what lets the poller be tested without a mailbox.
export function createImap({ host, port, user, pass, mailbox }) {
  return async function imap() {
    const [{ ImapFlow }, { simpleParser }] = await Promise.all([
      import('imapflow'),
      import('mailparser'),
    ])
    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass },
      logger: false,
    })
    await client.connect()
    let lock
    try {
      lock = await client.getMailboxLock(mailbox)
    } catch (err) {
      await client.logout()
      throw err
    }
    return {
      messages: () =>
        drainMessages(client.fetch({ seen: false }, { uid: true, source: true }), simpleParser),
      markSeen: (uid) => client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true }),
      async close() {
        lock.release()
        await client.logout()
      },
    }
  }
}

// A page fetch with both ends capped: a deadline, and a byte ceiling read off
// the body stream so a hostile or broken server cannot stream forever.
export function createFetchPage({
  fetchImpl = fetch,
  timeoutMs = 10_000,
  maxBytes = 512 * 1024,
} = {}) {
  return async function fetchPage(url) {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'user-agent': 'bcns-outreach/1.0' },
    })
    if (!res.ok) throw new Error(`fetch ${url} returned ${res.status}`)
    const text = await res.text()
    return text.length > maxBytes ? text.slice(0, maxBytes) : text
  }
}

export async function main(env = process.env, load = (n) => import(`./${n}.mjs`)) {
  const names = jobNames({ schedule: env.SCHEDULE, job: env.JOB })

  // A job below the stop marker is not built yet. That is not a failure: the
  // clock is deliberately standing before the jobs it will drive, and a red X
  // every twenty minutes would train everyone to ignore this workflow. A job
  // that EXISTS and throws still fails the run, which is the case that matters.
  let deps = null
  const results = []
  try {
    for (const name of names) {
      let mod
      try {
        mod = await load(name)
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
        console.log(`job ${name} is not built yet — nothing to run`)
        results.push({ skipped: 'not-built', job: name })
        continue
      }
      if (typeof mod.run !== 'function') throw new Error(`job ${name} exports no run()`)
      deps ??= await buildDeps(env)
      results.push(await mod.run(deps))
    }
  } finally {
    await deps?.sql?.end({ timeout: 5 })
  }
  return results.length === 1 ? results[0] : results
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
