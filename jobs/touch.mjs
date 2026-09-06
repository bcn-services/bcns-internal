// The sender. 14:00 on weekdays: first touches out of the `drafted` buffer,
// then bumps for rows whose next_touch_at has passed.
//
// Three things in here are load-bearing and none of them are conveniences:
//
//  1. The allow-list. Every send routes through `deliver()`, which refuses a
//     recipient that is not on the list BEFORE a transport is constructed, and
//     does so whether or not DRY_RUN is on. An empty list allows nobody. There
//     is no env default and no widening path — Nate edits the repo variable by
//     hand when he is ready to mail a stranger.
//  2. Claim-then-send. `claimMailboxSlot` increments `sent_today` conditionally
//     and returns the row; no row means the mailbox is at its cap. A concurrent
//     run cannot take the same last slot.
//  3. Exactly two bumps. touches 0 -> first send, 1 and 2 -> bumps, 3 -> the
//     row becomes `call_due` and no SMTP command is issued for it.

import { randomUUID } from 'node:crypto'
import { SIGNATURE, toHtml } from '../lib/template.mjs'

export const TOUCH_DAYS = 7
export const MAX_TOUCHES = 3

// Under forty words, and it makes no argument the first email did not.
export const BUMP_BODY = `Hi,

Floating this back to the top of your inbox in case it got buried. Happy to put
that mock-up together whenever you have a spare fifteen minutes.

Best,`

// The second bump is the last mail of the sequence; it says so and asks for
// nothing new. Two identical bumps a week apart read as a machine.
export const BUMP_BODY_2 = `Hi,

Last note from me on this. If a booking tool for the shop isn't worth fifteen
minutes right now, no hard feelings, I'll leave it here.

Best,`

export const BUMP_TAIL = `Reply "stop" and I won't write again.`

// Greet by name when the row knows one; the outreach skill's rule is to omit
// the name, never to invent one.
export const bumpBody = (touches, ownerName) =>
  (touches >= 2 ? BUMP_BODY_2 : BUMP_BODY).replace(/^Hi,/, ownerName ? `Hi ${ownerName},` : 'Hi,')

// Warming ramp: five sends a day in a mailbox's first week, plus five for each
// further week, never above its own daily_cap. No warmed_at is day zero.
export function warmedCap({ dailyCap = 0, warmedAt = null, now = new Date() } = {}) {
  const days = warmedAt ? Math.max(0, (now - new Date(warmedAt)) / 86_400_000) : 0
  return Math.max(0, Math.min(Number(dailyCap) || 0, 5 * (1 + Math.floor(days / 7))))
}

// Sends are spread across the hour rather than fired as a burst — a block of
// identical-timestamped messages from a cold subdomain is a filter signal.
// The window is the budget for the WHOLE run, so callers divide it by the
// number of rows they are about to walk: N due rows must still land inside the
// hour, not take N x 55min.
export const JITTER_WINDOW_MS = 55 * 60 * 1000
export function jitterMs(random = Math.random, windowMs = JITTER_WINDOW_MS) {
  return Math.floor(random() * windowMs)
}

export class RecipientRefused extends Error {}

// The one gate. Not a helper the callers may forget: `deliver` is the only
// path to a transport, and this is its first statement.
// `listName` names the variable an operator must actually edit to widen the
// list. There are two of them — SEND_ALLOWED_RECIPIENTS gates who we may mail
// as a prospect, NOTIFY_ALLOWED_RECIPIENTS gates who we forward internal mail
// to — and a refusal naming the wrong one sends the fix to the wrong file.
export function assertAllowed(to, allowed, listName = 'SEND_ALLOWED_RECIPIENTS') {
  const list = (allowed ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean)
  // `*` opens the PROSPECT list to everyone — the "set it free" switch. It is
  // deliberately meaningless for NOTIFY_ALLOWED_RECIPIENTS: that list decides
  // whose one-word replies are obeyed as commands, and it never opens.
  if (listName === 'SEND_ALLOWED_RECIPIENTS' && list.includes('*')) return
  if (!list.includes(String(to ?? '').trim().toLowerCase())) {
    throw new RecipientRefused(
      `recipient ${to} is not in ${listName} — refused before any connection`
    )
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')

export function buildMime({ from, to, subject, text, html, messageId, date, inReplyTo = null, boundary }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  const part = (type, body) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n`
  return (
    `${headers.join('\r\n')}\r\n\r\n` +
    part('text/plain', text) +
    part('text/html', html) +
    `--${boundary}--\r\n`
  )
}

// The only place a transport is touched, and the only path to a send. The
// refusal is its first statement, so an address off the list never reaches a
// connection — and never burns a mailbox slot either, dry run or not.
//
// `transport(claimed)` — the claimed mailbox row, not a bare call — so the
// transport that gets built is always the one for the mailbox that was
// actually claimed. There is no other path to a mailer in this file.
async function deliver({ transport, dryRun, allowed, to, claim, build, beforeSend = async () => {} }) {
  assertAllowed(to, allowed)
  const claimed = await claim()
  if (!claimed) return { claimed: null }
  const { raw, from, messageId } = build(claimed)
  if (dryRun) return { claimed, messageId, dryRun: true }
  // Jitter belongs to the send, not to the row: a refused recipient, a capped
  // mailbox and a dry run all cost nothing and must not burn the window.
  await beforeSend()
  const mailer = await transport(claimed)
  await mailer.sendMail({ envelope: { from, to }, raw })
  return { claimed, messageId }
}

// personalize.mjs stores research as JSON; postgres hands it back either way.
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

// The draft's first line is `Subject: ...`, followed by a blank line.
export function splitDraft(draft) {
  const text = String(draft ?? '')
  const match = /^Subject:[ \t]*(.*)\r?\n\r?\n/.exec(text)
  if (!match) return { subject: null, body: text }
  return { subject: match[1].trim(), body: text.slice(match[0].length) }
}

export async function run({
  sql,
  db,
  transport = null,
  allowedRecipients = [],
  dryRun = true,
  now = new Date(),
  random = Math.random,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  uuid = randomUUID,
  limit = 50,
  jitterWindowMs = JITTER_WINDOW_MS,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'touch', kind, detail)
  const result = { sent: 0, bumped: 0, callDue: 0, refused: 0, wouldSend: 0, skipped: 0, errors: 0 }

  if (!dryRun && !transport) {
    await log('skipped', { reason: 'missing deps: transport' })
    return result
  }

  const rows = await db.dueTouches(sql, { now, limit })
  if (!rows.length) {
    await log('skipped', { reason: 'no rows due for a touch' })
    return result
  }

  const mailboxes = (await db.activeMailboxes(sql)) ?? []
  if (!mailboxes.length) {
    await log('skipped', { reason: 'no active mailboxes' })
    return result
  }

  let rr = 0

  for (const row of rows) {
    try {
      // Belt to the view's braces: a replied or suppressed row is never mailed.
      if (row.stage === 'replied' || row.suppressed_at) {
        result.skipped++
        continue
      }

      const touches = Number(row.touches ?? 0)

      // The third touch is a phone call, not a third email.
      if (touches >= MAX_TOUCHES) {
        await db.updateBusiness(sql, row.id, { stage: 'call_due', next_touch_at: null })
        result.callDue++
        await log('call_due', { business: row.id, touches })
        continue
      }

      const research = parseResearch(row.research)
      const { subject: draftSubject, body } = splitDraft(research.draft)
      const isBump = touches > 0

      if (!isBump && !body.trim()) {
        result.skipped++
        await log('skipped', { business: row.id, reason: 'no draft on a row at stage drafted' })
        continue
      }

      const [prior] = isBump ? ((await db.firstOutbound(sql, row.id)) ?? []) : []
      const inReplyTo = prior?.message_id ?? null
      const baseSubject = prior?.subject ?? draftSubject ?? `a question about ${row.name}`
      const subject = isBump ? `Re: ${baseSubject.replace(/^Re:\s*/i, '')}` : baseSubject
      const text = isBump ? `${bumpBody(touches, research.owner_name)}\n${SIGNATURE}\n\n${BUMP_TAIL}\n` : body

      // Claim first, send second. A mailbox that will not give up a slot is
      // out for the day and the next one is tried. In a dry run nothing is
      // claimed, because a dry run writes nothing.
      const claim = async () => {
        for (let i = 0; i < mailboxes.length; i++) {
          const mb = mailboxes[(rr + i) % mailboxes.length]
          const cap = warmedCap({ dailyCap: mb.daily_cap, warmedAt: mb.warmed_at, now })
          if (cap <= 0) continue
          // A mailbox with no resolvable credentials is skipped exactly like
          // one at cap — tried, logged, moved past — and is NEVER sent
          // through with another mailbox's transport instead.
          if (typeof transport?.hasCredentials === 'function' && !transport.hasCredentials(mb.address)) {
            await log('skipped', { mailbox: mb.address, reason: 'no SMTP credentials configured for this mailbox' })
            continue
          }
          const [got] = dryRun ? [mb] : ((await db.claimMailboxSlot(sql, { address: mb.address, cap })) ?? [])
          if (got) {
            rr = (rr + i + 1) % mailboxes.length
            return got
          }
        }
        return null
      }

      let messageId = null
      const build = (mb) => {
        messageId = `<${uuid()}@${mb.domain ?? 'send.bcn-services.com'}>`
        return {
          from: mb.address,
          messageId,
          raw: buildMime({
            from: mb.address,
            to: row.email,
            subject,
            text,
            html: toHtml(text),
            messageId,
            date: now,
            inReplyTo,
            boundary: `bcns-${uuid()}`,
          }),
        }
      }

      const { claimed } = await deliver({
        transport,
        dryRun,
        allowed: allowedRecipients,
        to: row.email,
        claim,
        build,
        beforeSend: () => sleep(jitterMs(random, jitterWindowMs / rows.length)),
      })

      if (!claimed) {
        result.skipped++
        await log('skipped', { business: row.id, reason: 'every mailbox is at its warmed cap' })
        continue
      }

      if (dryRun) {
        result.wouldSend++
        await log('would_send', { business: row.id, to: row.email, subject, bump: isBump })
        continue
      }

      // The thread row, the touch counter and the stage move together or not
      // at all: a half-written send is a duplicate send next run.
      await sql.begin(async (tx) => {
        await db.recordThread(tx, {
          messageId,
          businessId: row.id,
          direction: 'outbound',
          mailbox: claimed.address,
          subject,
        })
        await db.updateBusiness(tx, row.id, {
          stage: 'sent',
          touches: touches + 1,
          next_touch_at: new Date(now.getTime() + TOUCH_DAYS * 86_400_000),
        })
      })

      if (isBump) result.bumped++
      else result.sent++
      await log('sent', { business: row.id, message_id: messageId, mailbox: claimed.address, bump: isBump })
    } catch (err) {
      if (err instanceof RecipientRefused) {
        result.refused++
        await log('refused', { business: row.id, to: row.email, reason: String(err.message) })
        continue
      }
      result.errors++
      await log('error', { business: row.id, error: String(err?.message ?? err) })
    }
  }

  return result
}
