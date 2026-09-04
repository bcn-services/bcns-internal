// The reader. Every 20 minutes it drains the `pipeline` label and turns each
// reply into either a suppression, a stage move, or a message for a human.
//
// The one failure that matters here is a FALSE NEGATIVE on an opt-out: a reply
// that means "stop emailing me" that this file does not recognise. Nobody ever
// sees that happen — the damage lands on a stranger weeks later. So:
//
//  1. `stripQuoted` runs first, so our own `Reply "stop"` footer coming back
//     inside a quoted region is never read as the prospect's own words.
//  2. `isOptOut` is weighted for RECALL, not precision, and it runs and COMMITS
//     before the classifier is constructed — a classifier that throws, hangs or
//     lies cannot cost us a suppression. A false positive here is visible (the
//     humans get the forwarded copy and can mail by hand); a false negative is
//     invisible forever. That asymmetry is the whole design.
//  3. A command on bot@ is honoured only from NOTIFY_ALLOWED_RECIPIENTS — the
//     INTERNAL humans, and deliberately NOT SEND_ALLOWED_RECIPIENTS, which is
//     the list of prospects `touch` may mail. `won 2400` from anyone else
//     changes nothing at all — it is forwarded, and a human decides. The same
//     internal list is the only set of addresses this file forwards to.
//     Nothing on this path is guessed at.

import { assertAllowed, buildMime, RecipientRefused } from './touch.mjs'
import { SIGNATURE, toHtml } from '../lib/template.mjs'
import { pushOrSkip } from '../lib/osrepo.mjs'
import { claimSlug } from './pitch.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Stages past `replied`: a late prospect reply must not walk a won deal back.
export const ADVANCED_STAGES = ['meeting', 'quoted', 'won', 'lost']

// How long a "no answer" pushes the next call attempt out.
export const NO_ANSWER_DAYS = 2

// Marking seen last means a message whose handling throws is retried next tick.
// That is right for a transient fault and wrong for a deterministic one: an
// oversized body or a constraint violation would re-forward to every human on
// every tick, forever. After this many failed attempts the message is marked
// seen and dead-lettered for a human to find in `events`.
export const MAX_ATTEMPTS = 3

// The ceiling on a countersigned contract PDF. Anything larger is not a
// contract we can file, and an unbounded attachment is a mail-sized write into
// the ~/os checkout. Refused, never truncated.
export const MAX_CONTRACT_BYTES = 10 * 1024 * 1024

export const CONTRACT_MIME = 'application/pdf'

// Draft PRs opened per day, across every fingerprint. Read from `events`
// (see `db.triageOpenedToday`), so there is no counter to reset at midnight.
export const TRIAGE_DAILY_CAP = 3

// Normalized subject + first body line, hashed. Loose on purpose: two alerts
// that read the same to a human should collapse to one PR, not two — a
// fingerprint keyed on raw bytes would miss the retried copy an alerting tool
// sends seconds later with a different message id.
export function alertFingerprint(message = {}) {
  const subject = String(message.subject ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const firstLine = stripQuoted(message.text).split('\n')[0]?.trim().toLowerCase().replace(/\s+/g, ' ') ?? ''
  return createHash('sha256').update(`${subject}\n${firstLine}`).digest('hex')
}

// --- quoted regions --------------------------------------------------------
// Truncate at the first quote marker, then drop any surviving `>` lines. Kept
// deliberately narrow: over-eager stripping deletes the sentence that would
// have matched an opt-out, which is the failure mode this file exists to avoid.
const CUT_MARKERS = [
  /^On\b[\s\S]{0,300}?\bwrote:[ \t]*$/m, // Gmail/Apple attribution, wrapped or not
  /^-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  /^_{10,}[ \t]*$/m, // Outlook's rule
  /^From:[ \t].+\r?\n(?:Sent|To|Date|Subject):[ \t]/m, // Outlook header block
  /^>/m,
]

export function stripQuoted(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n')
  let cut = text.length
  for (const re of CUT_MARKERS) {
    const m = re.exec(text)
    if (m && m.index < cut) cut = m.index
  }
  return text
    .slice(0, cut)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()
}

// --- opt-out ---------------------------------------------------------------
// Recall first. Every pattern here is allowed to be loose; the cost of a wrong
// match is one lead we stop mailing, and the humans still get the forward.
export const OPT_OUT_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bopt(?:ing)?[ -]?out\b/i,
  /\btake (?:me|us|my name|our name|my email|this) off\b/i,
  /\bremove (?:me|us)\b/i,
  /\bremove (?:my|our) (?:name|e-?mail|address|details|info|contact)/i,
  /\bdelete (?:my|our) (?:name|e-?mail|address|details|info|data|contact)/i,
  /\b(?:get|take|be) (?:me|us) off\b/i,
  /\bget off (?:this|your|the|these)\b/i,
  /\bhow (?:do|can|would) i (?:get off|opt out|unsubscribe|stop)/i,
  /\b(?:do ?n[o']?t|never|no longer|stop|quit|cease|please stop) (?:ever )?(?:e-?mail|contact|message|write|mail|reach(?:ing)? out|call)/i,
  /\b(?:stop|quit|cease)(?:ing)? (?:e-?mailing|contacting|messaging|mailing|writing|calling)/i,
  /\bno (?:more|further) (?:e-?mails?|contact|messages?|communication)\b/i,
  /\bnot interested\b/i,
  /\bleave (?:me|us) alone\b/i,
  /\bdo not (?:wish|want) to (?:receive|be contacted|hear)/i,
  // A line (or subject) built ONLY from "stop"/"please"/"now" plus punctuation,
  // and containing at least one "stop". Anchored at both ends because the open
  // slot after `stop` is a verb, not a preposition, and no enumeration closes
  // it: `Stop press: we are hiring` is an ordinary subject and suppression has
  // no undo. The stop/please/now alternation keeps the real bare-stop replies
  // a prospect actually sends — `STOP PLEASE`, `stop now`, `stop stop stop` —
  // which a bare `^stop$` anchor silently dropped. Longer opt-out phrasings are
  // carried by the other patterns.
  /^(?=[^\n]*\bstop\b)[ \t]*(?:(?:stop|please|now)[ \t.,!]*)+$/im,
  /\bstop\b[^\n]{0,25}\b(?:list|e-?mails?)\b/i,
  // Measured recall gaps: "remove this email address from your distribution",
  // "remove from your list", "cease all communication", "we don't want any more
  // emails", "do not send us anything further".
  /\bremove\b[^\n]{0,40}\b(?:list|distribution|database|mailing)/i,
  /\bcease\b[^\n]{0,20}\b(?:communication|contact)/i,
  /\bdo ?n[o']?t (?:want|need)\b[^\n]{0,25}\b(?:e-?mails?|contact)/i,
  /\b(?:do ?n[o']?t) send\b[^\n]{0,25}\b(?:anything|any)\b[^\n]{0,15}\b(?:further|more|else)/i,
]

export function isOptOut(text) {
  // One normalisation choke point instead of a curly-quote alternative in every
  // pattern: `don\u2019t` and `don\u02bct` are the same word as `don't`, and a
  // future pattern gets that for free. The forwarded copy keeps the original
  // characters — only the match is normalised.
  const clean = stripQuoted(text).replace(/[\u2019\u02bc]/g, "'")
  return OPT_OUT_PATTERNS.some((re) => re.test(clean))
}

// A subject-only "UNSUBSCRIBE" is an opt-out too — the subject is unquoted by
// construction, so it is read alongside the stripped body, the same way
// `isAutoReply` already reads it.
export function isOptOutMessage(message = {}) {
  return isOptOut(`${message.subject ?? ''}\n${message.text ?? ''}`)
}

// --- auto-replies ----------------------------------------------------------
// An out-of-office is not a reply. It moves no stage and spends no Claude call.
const AUTO_PATTERNS = [
  /\bout of (?:the )?office\b/i,
  /\bauto(?:matic|mated)?[ -]?(?:reply|response|responder)\b/i,
  /\bon (?:vacation|holiday|leave|annual leave)\b/i,
  /\baway from (?:the |my )?(?:office|desk|email)\b/i,
  /\bi(?:'| a)?m currently (?:away|out|unavailable)\b/i,
  /\bwill (?:be back|return) (?:on|to the office)\b/i,
  /\bundeliverable\b|\bdelivery (?:has )?failed\b|\bmail delivery (?:subsystem|failed)\b/i,
]

export function isAutoReply(message = {}) {
  const h = message.headers ?? {}
  const header = String(h['auto-submitted'] ?? h['x-autoreply'] ?? h['x-autorespond'] ?? '')
  if (header && header.toLowerCase() !== 'no') return true
  const clean = stripQuoted(message.text)
  return AUTO_PATTERNS.some((re) => re.test(clean)) || AUTO_PATTERNS.some((re) => re.test(String(message.subject ?? '')))
}

// --- teammate commands -----------------------------------------------------
// The first line, and only the first line. Anything unrecognised is not a
// command and is never guessed at.
export function parseCommand(body) {
  const first = stripQuoted(body).split('\n')[0]?.trim() ?? ''
  const line = first.replace(/[.!]+$/, '')
  const lower = line.toLowerCase()
  // No `yes`: there is no approval step, so nothing is waiting to be approved.
  // A `yes` reply is an unrecognised first line and is forwarded to a human.
  if (/^no answer\b/.test(lower)) return { command: 'no answer' }
  if (/^no\b/.test(lower)) return { command: 'no' }
  if (/^stop\b/.test(lower)) return { command: 'stop' }
  const won = /^won[ \t]+\$?([\d,]+(?:\.\d+)?)\b/.exec(lower)
  if (won) return { command: 'won', amount: Number(won[1].replace(/,/g, '')) }
  if (/^signed\b/.test(lower)) return { command: 'signed' }
  if (/^notes\b/.test(lower)) return { command: 'notes', notes: stripQuoted(body).replace(/^\s*notes\b[:\s]*/i, '').trim() }
  return null
}

// --- classification --------------------------------------------------------
export const CATEGORIES = ['opt_out', 'interested', 'not_now', 'out_of_office', 'other']

export function classifyPrompt(text) {
  return [
    'Classify this reply to a cold sales email. Answer with exactly one word from:',
    CATEGORIES.join(', '),
    '',
    'opt_out means the person wants no further contact of any kind.',
    'Reply with the single word and nothing else.',
    '',
    '--- reply ---',
    text.slice(0, 4000),
  ].join('\n')
}

export function readCategory(answer) {
  const text = String(answer ?? '').toLowerCase()
  return CATEGORIES.find((c) => text.includes(c)) ?? 'other'
}

// --- forwarding ------------------------------------------------------------
// The same gate the sender uses: `assertAllowed` first, transport second, so a
// forward can never leak a prospect's message to a prospect. The list here is
// the INTERNAL one, so the refusal names NOTIFY_ALLOWED_RECIPIENTS.
export function createNotifier({ transport, internalRecipients = [], from, dryRun = true, uuid = randomUUID, now = new Date() }) {
  return async function notify({ to, subject, text }) {
    assertAllowed(to, internalRecipients, 'NOTIFY_ALLOWED_RECIPIENTS')
    if (dryRun || !transport) return { dryRun: true }
    const messageId = `<${uuid()}@bcn-services.com>`
    const body = `${text}\n\n${SIGNATURE}\n`
    const mailer = await transport()
    await mailer.sendMail({
      envelope: { from, to },
      raw: buildMime({
        from,
        to,
        subject,
        text: body,
        html: toHtml(body),
        messageId,
        date: now,
        boundary: `bcns-${uuid()}`,
      }),
    })
    return { messageId }
  }
}

// --- the job ---------------------------------------------------------------

const addr = (v) => String(v ?? '').trim().toLowerCase()

// `allowed` is always the INTERNAL list: a prospect on the send list must never
// be able to issue a command.
export function isAllowedSender(from, allowed) {
  try {
    assertAllowed(from, allowed, 'NOTIFY_ALLOWED_RECIPIENTS')
    return true
  } catch (err) {
    if (err instanceof RecipientRefused) return false
    throw err
  }
}

// In-Reply-To first, then References newest-first: the closest ancestor wins.
export function threadIds(message = {}) {
  const ids = []
  const push = (v) => {
    for (const id of String(v ?? '').match(/<[^>]+>/g) ?? []) if (!ids.includes(id)) ids.push(id)
  }
  push(message.inReplyTo ?? message.headers?.['in-reply-to'])
  const refs = String(message.references ?? message.headers?.references ?? '').match(/<[^>]+>/g) ?? []
  for (const id of refs.reverse()) push(id)
  return ids
}

function parseResearch(research) {
  if (!research) return {}
  if (typeof research === 'string') {
    try {
      return JSON.parse(research)
    } catch {
      return {}
    }
  }
  return research
}

// A uid identifies a message only within one mailbox at one uidvalidity, so a
// failure counter keyed on uid alone charges a NEW message for a dead-lettered
// predecessor's failures. Message-ID is globally unique, stable across ticks,
// and already this pipeline's thread key.
export function messageKey(message = {}) {
  // ponytail: falls back to the uid for a message with no Message-ID (rare and
  // non-conformant). The forward-before-mark-seen below is what keeps even a
  // wrong key visible; key on mailbox + uidvalidity if that ever shows up.
  return String(message?.messageId ?? '').trim() || `uid:${message?.uid}`
}

export async function run({
  sql,
  db,
  imap = null,
  claude = null,
  notify = null,
  transport = null,
  internalRecipients = [],
  notifyFrom = 'bot@bcn-services.com',
  outreachAddress = 'outreach@send.bcn-services.com',
  botAddress = 'bot@bcn-services.com',
  alertsAddress = 'alerts@bcn-services.com',
  github = null,
  osDir = null,
  commitAndPush = null,
  dryRun = true,
  now = new Date(),
  uuid = randomUUID,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'poll', kind, detail)
  const result = { read: 0, suppressed: 0, replied: 0, commands: 0, forwarded: 0, auto: 0, errors: 0, triaged: 0 }
  // Alert events log under job 'triage', not 'poll' — the daily cap and the
  // dedupe-hit trail are this job's own record, independent of the poller's.
  const logTriage = (kind, detail) => db.logEvent(sql, 'triage', kind, detail)

  // Tonight `imap` is a single factory (one account, bot@/outreach@ as
  // aliases); once outreach mailboxes get their own accounts it is a list —
  // `[].concat` treats either shape the same way.
  const sources = [].concat(imap).filter(Boolean)
  if (!sources.length) {
    await log('skipped', { reason: 'missing deps: imap' })
    return result
  }

  const send =
    notify ??
    createNotifier({ transport, internalRecipients, from: notifyFrom, dryRun, uuid, now })

  // A forward is a record first and an email second: if SMTP is down the human
  // still has the event, and nothing is silently dropped.
  const forward = async (message, reason, extra = {}) => {
    if (!internalRecipients.length) {
      // Nobody to forward to is a failure, not a forward: an unmatched opt-out
      // would otherwise be counted as delivered and reach no human at all.
      result.errors++
      await log('error', {
        stage: 'forward',
        reason: 'no allow-listed recipient',
        forward_reason: reason,
        from: message.from,
        subject: message.subject,
        ...extra,
      })
      return
    }
    await log('forwarded', { reason, from: message.from, subject: message.subject, ...extra })
    let delivered = false
    for (const to of internalRecipients) {
      try {
        await send({
          to,
          subject: `[pipeline] needs a human: ${message.subject ?? '(no subject)'}`,
          text: `Forwarded because: ${reason}\n\nFrom: ${message.from}\nDelivered-To: ${message.deliveredTo}\n\n${stripQuoted(message.text)}`,
        })
        delivered = true
      } catch (err) {
        result.errors++
        await log('error', { stage: 'forward', to, error: String(err?.message ?? err) })
      }
    }
    if (delivered) result.forwarded++
  }

  // Connect every source and pool its messages before any routing runs. One
  // source failing to connect (or to list its messages) never drops the
  // others — it is an `error` event naming the account, and the loop moves on.
  // A message_id seen twice (two mailboxes, one thread) keeps only the first
  // sighting to handle; the rest are recorded so their own connection still
  // gets its `markSeen` once the first sighting is done with it.
  const clients = []
  const inbox = new Map() // messageKey -> { message, client, account, duplicates }
  for (const source of sources) {
    const account = source?.account ?? 'unknown'
    let client
    try {
      client = await source()
    } catch (err) {
      result.errors++
      await log('error', { stage: 'connect', account, error: String(err?.message ?? err) })
      continue
    }
    clients.push(client)
    try {
      const messages = (await client.messages()) ?? []
      for (const message of messages) {
        const key = messageKey(message)
        const existing = inbox.get(key)
        if (existing) existing.duplicates.push({ client, uid: message.uid })
        else inbox.set(key, { message, client, account, duplicates: [] })
      }
    } catch (err) {
      result.errors++
      await log('error', { stage: 'fetch', account, error: String(err?.message ?? err) })
    }
  }

  try {
    if (!inbox.size) {
      await log('skipped', { reason: 'no unread messages on any mailbox' })
      return result
    }

    // Seen only AFTER the handler returns. A crash mid-handle leaves the
    // message unseen so the next tick retries it: a duplicated forward is
    // visible and cheap, a silently dropped opt-out is neither. Re-applying
    // a retried message is safe — stage moves and `suppress` are idempotent,
    // and the `notes` append dedupes on the note itself. A duplicate sighting
    // is marked seen on its own connection right alongside the original, so
    // it is never re-read (and re-deduped) forever.
    const markSeen = async (client, uid, duplicates) => {
      if (dryRun) return
      await client.markSeen?.(uid)
      for (const dup of duplicates) {
        try {
          await dup.client.markSeen?.(dup.uid)
        } catch {
          // best effort — a stuck duplicate just gets re-deduped next tick
        }
      }
    }

    for (const { message, client, duplicates } of inbox.values()) {
      try {
        result.read++
        // Delivered-To is empty for a reply sent to bot@ from the very
        // account bot@ is aliased under (no real SMTP delivery happens, so
        // Gmail never stamps it) — fall back to the typed To: line, still
        // matched as a full address, never a bare local-part.
        const toCandidates = message.deliveredTo
          ? [message.deliveredTo]
          : message.toAddresses ?? []
        const to =
          toCandidates.map(addr).find((a) => a === addr(botAddress) || a === addr(outreachAddress)) ??
          addr(message.deliveredTo)
        const ids = threadIds(message)
        const [thread] = ids.length ? ((await db.threadByMessageIds(sql, ids)) ?? []) : []
        const businessId = thread?.business_id ?? null

        // Full addresses only. A bare local-part match let
        // `bot@anything.example` take the teammate path; anything unrecognised
        // now falls through to a human.
        if (to === addr(botAddress)) {
          await handleTeammate({ message, businessId })
        } else if (to === addr(outreachAddress)) {
          await handleProspect({ message, businessId })
        } else if (to === addr(alertsAddress)) {
          await handleAlert({ message })
        } else {
          await forward(message, 'unrecognised Delivered-To', { delivered_to: to })
        }

        await markSeen(client, message.uid, duplicates)
      } catch (err) {
        result.errors++
        // Bookkeeping for one bad message must never take the rest of the
        // tick's messages down with it, so this is its own try.
        try {
          const key = messageKey(message)
          await log('error', { uid: message?.uid, message_key: key, error: String(err?.message ?? err) })
          // `events` is already the poller's only marker store: prior failures
          // for this message are counted there rather than in new state.
          const [row] = (await db.messageFailureCount?.(sql, key)) ?? []
          const attempts = Number(row?.count ?? 0)
          if (attempts >= MAX_ATTEMPTS) {
            // A dead letter is never a silent drop: the humans get the message
            // BEFORE it is marked seen, so an opt-out we could not handle is
            // still read by someone. If the forward is itself what keeps
            // failing, say so in the event and mark seen anyway — a message
            // retried forever re-forwards to every human on every tick.
            let forwardError = null
            try {
              await forward(message, `handling failed ${attempts} times — dead-lettered, read this one by hand`, {
                uid: message?.uid,
                message_key: key,
              })
            } catch (ferr) {
              forwardError = String(ferr?.message ?? ferr)
            }
            await log('dead_letter', {
              uid: message?.uid,
              message_key: key,
              attempts,
              forwarded: forwardError === null,
              ...(forwardError === null ? {} : { forward_error: forwardError }),
            })
            await markSeen(client, message?.uid, duplicates)
          }
        } catch {
          // nothing left to do but keep going
        }
      }
    }
  } finally {
    for (const client of clients) {
      try {
        await client.close?.()
      } catch {
        // best effort — a close failure must not mask the tick's real result
      }
    }
  }

  return result

  // --- prospect -----------------------------------------------------------
  async function handleProspect({ message, businessId }) {
    if (!businessId) return forward(message, 'no thread matched this prospect reply')

    // FIRST, and committed before anything that can fail. The classifier is not
    // constructed, called or trusted until this has already run.
    if (isOptOutMessage(message)) {
      result.suppressed++
      if (!dryRun) await db.suppress(sql, businessId, 'reply opt-out')
      await log(dryRun ? 'would_suppress' : 'suppressed', { business: businessId, by: 'keyword' })
      return
    }

    if (isAutoReply(message)) {
      result.auto++
      await log('auto_reply', { business: businessId })
      return
    }

    const body = stripQuoted(message.text)
    // An empty body is not a classifiable reply — it is an html part we could
    // not read, or an attachment-only message. Never guessed at.
    if (!body) {
      await forward(message, 'reply body is empty — read this one by hand', { business: businessId })
      return
    }

    let category = 'other'
    if (claude) {
      try {
        category = readCategory(await claude.ask(classifyPrompt(body)))
      } catch (err) {
        // A dead classifier is not a reason to lose the reply.
        await log('error', { stage: 'classify', business: businessId, error: String(err?.message ?? err) })
        await forward(message, 'classifier failed — read this one by hand', { business: businessId })
      }
    } else {
      // Without a classifier the regex is the only opt-out defence. Say so, and
      // put every reply in front of a human rather than filing it silently.
      await log('degraded', { business: businessId, reason: 'no classifier — keyword opt-out is the only defence' })
      await forward(message, 'no classifier configured — read this one by hand', { business: businessId })
    }

    if (category === 'opt_out') {
      result.suppressed++
      if (!dryRun) await db.suppress(sql, businessId, 'classified opt-out')
      await log(dryRun ? 'would_suppress' : 'suppressed', { business: businessId, by: 'classifier' })
      return
    }
    if (category === 'out_of_office') {
      result.auto++
      await log('auto_reply', { business: businessId, by: 'classifier' })
      return
    }

    const [row] = (await db.businessById(sql, businessId)) ?? []
    if (!row) {
      await log('skipped', { business: businessId, reason: 'row is suppressed or gone' })
      return
    }
    if (ADVANCED_STAGES.includes(row.stage)) {
      await log('skipped', { business: businessId, reason: `stage ${row.stage} is past replied` })
      return
    }

    result.replied++
    if (!dryRun) {
      await db.updateBusiness(sql, businessId, {
        stage: 'replied',
        next_touch_at: null,
        research: JSON.stringify({ ...parseResearch(row.research), last_reply: body }),
      })
    }
    await log(dryRun ? 'would_reply' : 'replied', { business: businessId, category })
  }

  // --- teammate -----------------------------------------------------------
  async function handleTeammate({ message, businessId }) {
    if (!isAllowedSender(message.from, internalRecipients)) {
      return forward(message, 'sender is not in NOTIFY_ALLOWED_RECIPIENTS — no command honoured', {
        from: message.from,
      })
    }
    const cmd = parseCommand(message.text)
    if (!cmd) return forward(message, 'no command in the first line', { business: businessId })
    if (!businessId) return forward(message, 'command had no thread to apply to', { command: cmd.command })

    const [row] = (await db.businessById(sql, businessId)) ?? []
    if (!row) {
      await log('skipped', { business: businessId, reason: 'row is suppressed or gone' })
      return
    }

    if (cmd.command === 'signed') return handleSigned({ message, businessId, row })

    const patch = {}
    if (cmd.command === 'no') patch.stage = 'lost'
    else if (cmd.command === 'no answer') {
      patch.stage = 'call_due'
      patch.next_touch_at = new Date(now.getTime() + NO_ANSWER_DAYS * 86_400_000)
    } else if (cmd.command === 'won') {
      patch.stage = 'won'
      patch.research = JSON.stringify({ ...parseResearch(row.research), won_amount: cmd.amount })
    } else if (cmd.command === 'notes') {
      const research = parseResearch(row.research)
      // Notes are what the quote job runs on, so a note on a row still in
      // conversation hands it to `quote`. A row already at or past quoting only
      // gains the note.
      if (!['quoting', 'quoted', 'won', 'onboarded', 'lost'].includes(row.stage)) patch.stage = 'quoting'
      patch.research = JSON.stringify({
        ...research,
        notes: [...new Set([...(research.notes ?? []), cmd.notes])].filter(Boolean),
      })
    }

    result.commands++
    if (cmd.command === 'stop') {
      result.suppressed++
      if (!dryRun) await db.suppress(sql, businessId, 'teammate stop')
      await log(dryRun ? 'would_suppress' : 'suppressed', { business: businessId, by: 'teammate' })
      return
    }

    if (!dryRun) await db.updateBusiness(sql, businessId, patch)
    await log(dryRun ? 'would_command' : 'command', {
      business: businessId,
      command: cmd.command,
      ...(cmd.amount === undefined ? {} : { amount: cmd.amount }),
    })
  }

  // --- alert triage ---------------------------------------------------------
  // Fed from the same IMAP stream poll already drains — a separate job would
  // need its own connection and would reimplement the fetch/seen/dead-letter
  // loop above for no reason. The cap is checked BEFORE anything is written:
  // a fourth alert on a cap-full day touches neither `alerts` nor `github`.
  async function handleAlert({ message }) {
    const [row] = (await db.triageOpenedToday(sql)) ?? []
    if (Number(row?.count ?? 0) >= TRIAGE_DAILY_CAP) {
      await logTriage('skipped', {
        reason: `triage daily cap of ${TRIAGE_DAILY_CAP} reached`,
        subject: message.subject,
      })
      return
    }

    if (dryRun) {
      await logTriage('would_triage', { subject: message.subject })
      return
    }

    const fingerprint = alertFingerprint(message)
    const [alert] = await db.upsertAlert(sql, { fingerprint, repo: null, source: 'alerts@' })
    result.triaged++

    // Already seen before today's count was checked, or on a prior day — either
    // way an open PR for this fingerprint already exists, so `hits` alone
    // decides, not the cap.
    if (Number(alert?.hits ?? 1) > 1) {
      await logTriage('duplicate', { fingerprint, hits: alert.hits })
      return
    }

    if (!github) {
      await logTriage('error', { reason: 'missing deps: github', fingerprint })
      return
    }

    const pr = await github({
      title: `alert: ${message.subject ?? '(no subject)'}`,
      body: stripQuoted(message.text),
      branch: `alert/${fingerprint.slice(0, 12)}`,
    })
    await db.setAlertPr(sql, fingerprint, pr?.url ?? null)
    await logTriage('opened', { fingerprint, pr_url: pr?.url ?? null })
  }

  // --- signed contract ------------------------------------------------------
  // A countersigned PDF mailed back by one of the internal humans. The four
  // refusals below are deliberately four separate checks: each one is the only
  // thing standing between a hostile or malformed attachment and a write into
  // the ~/os checkout, so none of them may be folded into another.
  async function handleSigned({ message, businessId, row }) {
    const parts = message.attachments ?? []

    // (d) `signed` with nothing attached. Forwarded, never applied, and NOT an
    // error — a human mailing the word without the file is an ordinary slip.
    if (parts.length === 0) {
      return forward(message, 'signed with no attachment — nothing filed', { business: businessId })
    }

    const refuse = async (reason, detail = {}) => {
      result.errors++
      await log('error', { stage: 'contract', business: businessId, reason, ...detail })
      await forward(message, `signed contract refused: ${reason}`, { business: businessId, ...detail })
    }

    // (b) more than one part: which one is the contract is a guess, and this
    // path does not guess.
    if (parts.length > 1) {
      return refuse('more than one attachment', { attachments: parts.length })
    }
    const [part] = parts
    // (a) only a PDF is ever written to disk.
    if (part.contentType !== CONTRACT_MIME) {
      return refuse('attachment is not a pdf', { content_type: part.contentType })
    }
    // (c) size ceiling, read off the real part.
    if (part.size > MAX_CONTRACT_BYTES) {
      return refuse('attachment is over the size limit', { size: part.size, limit: MAX_CONTRACT_BYTES })
    }

    if (row.stage !== 'quoted') {
      return forward(message, `signed on a business at stage ${row.stage}, not quoted`, {
        business: businessId,
      })
    }
    if (!osDir || !commitAndPush) {
      return refuse('no ~/os checkout on this runner', {
        missing: [!osDir && 'osDir', !commitAndPush && 'commitAndPush'].filter(Boolean),
      })
    }

    const slug = await claimSlug(sql, db, row)
    const contractPath = `clients/${slug}/contract/${now.toISOString().slice(0, 10)}-signed.pdf`
    const absolute = join(osDir, contractPath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, part.content)

    const push = await pushOrSkip({
      commitAndPush,
      paths: [contractPath],
      message: `contract: ${slug}`,
      log,
      detail: { business: businessId, slug },
    })
    // Nothing pushed: the row keeps its stage and the message stays unseen, so
    // the next live tick files the contract for real.
    if (!push) return

    const existing = (await db.clientByBusiness(sql, businessId)) ?? []
    if (!existing.length) {
      await db.insertClient(sql, { slug, display_name: row.name, business_id: businessId })
    }
    await db.updateClient(sql, businessId, { signed_at: now, contract_path: contractPath })
    await db.updateBusiness(sql, businessId, { stage: 'won' })
    result.commands++
    await log('signed', { business: businessId, slug, contract_path: contractPath })
  }
}
