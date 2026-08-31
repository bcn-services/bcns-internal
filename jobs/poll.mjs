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
//  3. A command on bot@ is honoured only from NOTIFY_ALLOWED_RECIPIENTS. `won
//     2400` from anyone else changes nothing at all — it is forwarded, and a
//     human decides. Nothing on this path is guessed at.

import { assertAllowed, buildMime, RecipientRefused } from './touch.mjs'
import { SIGNATURE, toHtml } from '../lib/template.mjs'
import { randomUUID } from 'node:crypto'

// Stages past `replied`: a late prospect reply must not walk a won deal back.
export const ADVANCED_STAGES = ['meeting', 'quoted', 'won', 'lost']

// How long a "no answer" pushes the next call attempt out.
export const NO_ANSWER_DAYS = 2

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
  /^[ \t]*(?:please[ \t]+)?stop\b[^\n]{0,30}$/im, // a line that is just "STOP"
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
  if (/^yes\b/.test(lower)) return { command: 'yes' }
  if (/^no answer\b/.test(lower)) return { command: 'no answer' }
  if (/^no\b/.test(lower)) return { command: 'no' }
  if (/^stop\b/.test(lower)) return { command: 'stop' }
  const won = /^won[ \t]+\$?([\d,]+(?:\.\d+)?)\b/.exec(lower)
  if (won) return { command: 'won', amount: Number(won[1].replace(/,/g, '')) }
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
// forward can never leak a prospect's message to a prospect.
export function createNotifier({ transport, allowedRecipients = [], from, dryRun = true, uuid = randomUUID, now = new Date() }) {
  return async function notify({ to, subject, text }) {
    assertAllowed(to, allowedRecipients)
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

export function isAllowedSender(from, allowed) {
  try {
    assertAllowed(from, allowed)
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

export async function run({
  sql,
  db,
  imap = null,
  claude = null,
  notify = null,
  transport = null,
  allowedRecipients = [],
  notifyFrom = 'bot@bcn-services.com',
  outreachAddress = 'outreach@send.bcn-services.com',
  botAddress = 'bot@bcn-services.com',
  dryRun = true,
  now = new Date(),
  uuid = randomUUID,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'poll', kind, detail)
  const result = { read: 0, suppressed: 0, replied: 0, commands: 0, forwarded: 0, auto: 0, errors: 0 }

  if (!imap) {
    await log('skipped', { reason: 'missing deps: imap' })
    return result
  }

  const send =
    notify ??
    createNotifier({ transport, allowedRecipients, from: notifyFrom, dryRun, uuid, now })

  // A forward is a record first and an email second: if SMTP is down the human
  // still has the event, and nothing is silently dropped.
  const forward = async (message, reason, extra = {}) => {
    if (!allowedRecipients.length) {
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
    for (const to of allowedRecipients) {
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

  const client = await imap()
  let messages = []
  try {
    messages = (await client.messages()) ?? []
    if (!messages.length) {
      await log('skipped', { reason: 'no unread messages on the pipeline label' })
      return result
    }

    for (const message of messages) {
      try {
        result.read++
        const to = addr(message.deliveredTo)
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
        } else {
          await forward(message, 'unrecognised Delivered-To', { delivered_to: to })
        }

        // Seen only AFTER the handler returns. A crash mid-handle leaves the
        // message unseen so the next tick retries it: a duplicated forward is
        // visible and cheap, a silently dropped opt-out is neither. Re-applying
        // a retried message is safe — stage moves and `suppress` are
        // idempotent, and the `notes` append dedupes on the note itself.
        if (!dryRun) await client.markSeen?.(message.uid)
      } catch (err) {
        result.errors++
        await log('error', { uid: message?.uid, error: String(err?.message ?? err) })
      }
    }
  } finally {
    await client.close?.()
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
      return forward(message, 'opt-out — suppressed, do not mail this business again', {
        business: businessId,
      })
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
      return forward(message, 'opt-out — suppressed, do not mail this business again', {
        business: businessId,
      })
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
    if (!dryRun) await db.updateBusiness(sql, businessId, { stage: 'replied', next_touch_at: null })
    await log(dryRun ? 'would_reply' : 'replied', { business: businessId, category })
  }

  // --- teammate -----------------------------------------------------------
  async function handleTeammate({ message, businessId }) {
    if (!isAllowedSender(message.from, allowedRecipients)) {
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

    const patch = {}
    if (cmd.command === 'yes') patch.stage = 'approved'
    else if (cmd.command === 'no') patch.stage = 'lost'
    else if (cmd.command === 'no answer') {
      patch.stage = 'call_due'
      patch.next_touch_at = new Date(now.getTime() + NO_ANSWER_DAYS * 86_400_000)
    } else if (cmd.command === 'won') {
      patch.stage = 'won'
      patch.research = JSON.stringify({ ...parseResearch(row.research), won_amount: cmd.amount })
    } else if (cmd.command === 'notes') {
      const research = parseResearch(row.research)
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
}
