// One-off pipeline status report. Not on the clock — dispatched manually
// (workflow_dispatch `job: verify-status`) whenever a human wants proof the
// pipeline is alive and sending sane copy, without waiting on the next
// scheduled job or being at a laptop to check.
//
// Deliberately does not judge draft quality itself: it mails the actual sent
// text back to a human, who reads three real emails faster and more reliably
// than any heuristic this job could write.

import { createNotifier } from './poll.mjs'

export async function run({
  sql,
  db,
  transport,
  internalRecipients = [],
  notifyFrom = 'bot@bcn-services.com',
  dryRun = true,
  notify,
  hours = 24,
  sampleSize = 3,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'verify-status', kind, detail)

  if (!internalRecipients.length) {
    await log('skipped', { reason: 'no internal recipients configured' })
    return { sent: 0 }
  }

  const send = notify ?? createNotifier({ transport, internalRecipients, from: notifyFrom, dryRun })

  const counts = await db.eventCounts(sql, hours)
  const drafts = await db.recentSentDrafts(sql, hours, sampleSize)

  const tally = counts.length
    ? counts.map((r) => `${r.job}/${r.kind}: ${r.count}`).join('\n')
    : '(no events at all in this window — the clock may be dark)'

  const sample = drafts.length
    ? drafts.map((d) => `--- ${d.name} <${d.email}> ---\n${d.draft ?? '(no draft text on this row)'}`).join('\n\n')
    : '(nothing sent by touch in this window)'

  const text =
    `Event counts, last ${hours}h:\n${tally}\n\n` +
    `Sent draft sample (${drafts.length}):\n\n${sample}`

  let sent = 0
  for (const to of internalRecipients) {
    await send({ to, subject: `bcns pipeline status check`, text })
    sent++
  }

  await log('sent', { hours, recipients: sent, events: counts.length, drafts: drafts.length })
  return { sent }
}
