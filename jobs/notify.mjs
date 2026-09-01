// The internal mailer. Runs at the end of every poll tick and writes to Nate
// and Brandon only — never to a prospect, and never to the pipeline's own
// outreach mailbox.
//
// Three things are load-bearing:
//
//  1. The allow-list — NOTIFY_ALLOWED_RECIPIENTS, the internal humans, never
//     SEND_ALLOWED_RECIPIENTS, the prospects `touch` may mail. Every send goes
//     through `createNotifier` from poll.mjs, whose first statement is
//     `assertAllowed`. There is no second sender in this file and no transport
//     is constructed before that check has run.
//  2. Notify writes no business row. It has no `updateBusiness` call at all:
//     the stages it reads are whatever `poll` and `touch` already wrote, and a
//     notification that moved a stage would be a pipeline that mails itself.
//  3. One notification per row per stage. The marker is an `events` row
//     (`job = 'notify'`, `kind = 'notified'`, `detail.key`) — the only dedupe
//     store there is. See `notifyKey` for what makes a second notification.

import { randomUUID } from 'node:crypto'
import { createNotifier } from './poll.mjs'

// Read in this order every tick. `drafted` is deliberately absent: there is no
// approval step, so a draft is not a task for a human — `touch` sends it at
// 14:00 without anyone being asked.
export const NOTIFY_STAGES = ['call_due', 'replied', 'quoting']

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

// What counts as "already notified". Business + stage for three of the four —
// but `call_due` is a stage a row RE-ENTERS: poll's `no answer` command leaves
// the stage alone and pushes `next_touch_at` out two days. Folding that
// timestamp into the key is what makes the second call task a new notification
// instead of a permanent silence.
export function notifyKey(row) {
  if (row.stage !== 'call_due') return `${row.id}:${row.stage}`
  const at = row.next_touch_at ? new Date(row.next_touch_at).toISOString() : 'none'
  return `${row.id}:call_due:${at}`
}

const line = (label, value) => (value ? `${label}: ${value}` : null)
const where = (row) => [row.town, row.state].filter(Boolean).join(', ')
const facts = (research) => (research.facts ?? []).map((f) => `  - ${f}`)

// --- the three templates ---------------------------------------------------
// Each returns `{ subject, text }`. None of them chooses a recipient: the
// caller pairs the body with an allow-listed address, so no prospect address
// can become a `to` no matter what a row contains.

export function callTaskEmail(row) {
  const research = parseResearch(row.research)
  const text = [
    `${row.name} has stopped replying to email. Call them.`,
    '',
    ...[
      line('Phone', row.phone),
      line('Owner', research.owner_name),
      line('Trade', row.trade),
      line('Where', where(row) || row.address),
      line('Site', row.domain),
      line('Email', row.email),
    ].filter(Boolean),
    ...(research.facts?.length ? ['', 'What we know:', ...facts(research)] : []),
    '',
    // The pitch job builds this folder on the poll tick before notify runs, so
    // a call task normally names a folder that already exists in ~/os.
    research.pitch_path
      ? `Pitch folder: ${research.pitch_path}`
      : 'Pitch folder: none yet — the pitch job has not reached this row.',
    '',
    'Reply "no answer" to push the call two days, or "stop" to drop them.',
  ].join('\n')
  return { subject: `[pipeline] call ${row.name}${row.phone ? ` — ${row.phone}` : ''}`, text }
}

export function meetingEmail(row, thread = null) {
  const research = parseResearch(row.research)
  const text = [
    `${row.name} replied. Book the meeting.`,
    '',
    ...[
      line('Contact', research.owner_name),
      line('Email', row.email),
      line('Phone', row.phone),
      line('Trade', row.trade),
      line('Where', where(row)),
      line('Thread', thread?.subject),
      line('Message-ID', thread?.message_id),
    ].filter(Boolean),
    ...(research.facts?.length ? ['', 'What we know:', ...facts(research)] : []),
    '',
    'Reply on their own thread when the meeting is set.',
  ].join('\n')
  return { subject: `[pipeline] ${row.name} replied — book the meeting`, text }
}

export function quoteEmail(row) {
  const research = parseResearch(row.research)
  const notes = [research.notes ?? []].flat().filter(Boolean)
  const text = [
    `${row.name} is ready for a quote. Over to the quote.`,
    '',
    ...[
      line('Contact', research.owner_name),
      line('Email', row.email),
      line('Phone', row.phone),
      line('Trade', row.trade),
      line('Where', where(row)),
    ].filter(Boolean),
    '',
    ...(notes.length
      ? ["Brandon's notes:", ...notes.map((n) => `  - ${n}`)]
      : ["Brandon left no notes on this one — ask before quoting."]),
  ].join('\n')
  return { subject: `[pipeline] quote ${row.name}`, text }
}

// --- the job ---------------------------------------------------------------

export async function run({
  sql,
  db,
  notify = null,
  transport = null,
  internalRecipients = [],
  notifyFrom = 'bot@bcn-services.com',
  dryRun = true,
  now = new Date(),
  uuid = randomUUID,
  limit = 50,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'notify', kind, detail)
  const result = { call_due: 0, replied: 0, quoting: 0, emails: 0, errors: 0 }

  // Nobody on the list is not "mail everybody" — it is a job with nothing to do.
  if (!internalRecipients.length) {
    await log('skipped', { reason: 'no allow-listed recipient' })
    return result
  }

  const send =
    notify ?? createNotifier({ transport, internalRecipients, from: notifyFrom, dryRun, uuid, now })

  for (const stage of NOTIFY_STAGES) {
    const rows = (await db.businessesByStage(sql, stage, { limit })) ?? []
    if (!rows.length) continue
    const done = new Set(
      ((await db.notifiedKeys(sql, rows.map(notifyKey))) ?? []).map((r) => r.key)
    )
    const fresh = rows.filter((row) => !done.has(notifyKey(row)))
    if (!fresh.length) continue

    // One email per row: each is a task somebody picks up individually.
    const batches = await Promise.all(
      fresh.map(async (row) => ({
        rows: [row],
        mail:
          stage === 'call_due'
            ? callTaskEmail(row)
            : stage === 'replied'
              ? meetingEmail(row, (await db.firstOutbound(sql, row.id))?.[0] ?? null)
              : quoteEmail(row),
      }))
    )

    for (const batch of batches) {
      let delivered = false
      for (const to of internalRecipients) {
        try {
          await send({ to, ...batch.mail })
          delivered = true
        } catch (err) {
          result.errors++
          await log('error', { stage, to, error: String(err?.message ?? err) })
        }
      }
      // ponytail: one marker for the whole batch — if the second recipient
      // failed, the retry next tick re-mails the first one. A duplicate
      // internal email is cheap; a task nobody was ever told about is not.
      if (!delivered) continue
      result.emails++
      for (const row of batch.rows) {
        result[stage]++
        // Dry runs write `would_notify`, which the dedupe read does not match:
        // a run that mailed nobody must not consume the row's one notification.
        await log(dryRun ? 'would_notify' : 'notified', {
          business: row.id,
          stage,
          key: notifyKey(row),
        })
      }
    }
  }

  return result
}
