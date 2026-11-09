// The daily call list. Cold email is off, so the pipeline's output is call
// tasks for Brandon: one email a day listing every business promoted to
// `call_due` since the last digest, best fit first. It replaces notify's old
// one-mail-per-lead call_due stage.
//
// Load-bearing:
//  1. Recipient is NOTIFY_TO and nothing else — never a fallback to
//     NOTIFY_ALLOWED_RECIPIENTS — and it must also be on that allow-list.
//     `assertAllowed` runs before any read or transport; `createNotifier` (the
//     only sender here) checks again, then short-circuits dry runs, then and
//     only then builds a transport.
//  2. The dedupe store is the `digested` event: `detail.ids` is the set of
//     business ids that mail listed, written only when EVERY NOTIFY_TO address
//     was really delivered. The next run lists none of them
//     (db.digestCandidates). A dry run (or a notifier that sent nothing)
//     writes `would_digest` and consumes nothing.
//  3. Writes no business row.
//  4. After a real `digested` marker, the same rows are appended to the Cold
//     Call Tracker's Leads tab (lib/sheet.mjs), deduped on place_id. Best
//     effort: the mail has already gone and the marker stands, so a
//     `sheet_failed` is NOT retried next run — a human backfills those ids.

import { randomUUID } from 'node:crypto'
import { createNotifier } from './poll.mjs'
import { parseResearch } from './pitch.mjs'
import { assertAllowed } from './touch.mjs'
import { dedupe, mapRow } from '../lib/sheet.mjs'

// America/New_York calendar date, YYYY-MM-DD ('en-CA' formats that way).
export const etDate = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)

// fit_score when B has written one, else the qualify label ('good'|'weak'|'no').
const score = (r) => {
  const n = Number(r.fit_score)
  return r.fit_score == null || r.fit_score === '' || Number.isNaN(n) ? null : n
}

export function sortRows(rows) {
  return rows
    .map((row) => ({ row, research: parseResearch(row.research) }))
    .sort((a, b) => {
      const sa = score(a.research)
      const sb = score(b.research)
      if (sa !== sb) {
        if (sa == null) return 1
        if (sb == null) return -1
        return sb - sa
      }
      return String(a.row.name ?? '').localeCompare(String(b.row.name ?? ''))
    })
}

function entry({ row, research }, i) {
  const fit = score(research) ?? research.fit
  const where = [row.town, row.state].filter(Boolean).join(', ')
  // os_slug is claimed before the pitch runs; pitch_path is written only on success
  const slug = research.pitch_path ? (row.os_slug || research.pitch_path) : undefined
  return [
    `${i + 1}. ${row.name}${row.phone ? ` — ${row.phone}` : ''}`,
    ...[
      where && `   Where: ${where}`,
      row.trade && `   Trade: ${row.trade}`,
      (fit != null || research.reason) &&
        `   Fit: ${[fit, research.reason].filter((x) => x != null && x !== '').join(' — ')}`,
      research.facts?.length && `   What we know:\n${research.facts.map((f) => `     - ${f}`).join('\n')}`,
      row.domain && `   Website: ${row.domain}`,
      row.email && `   Email: ${row.email}`,
      slug && `   Pitch folder: ${slug}`,
    ].filter(Boolean),
  ].join('\n')
}

export function digestMail(rows, date) {
  const sorted = sortRows(rows)
  const n = sorted.length
  return {
    subject: `[pipeline] ${n} calls for ${date}`,
    text: n ? sorted.map(entry).join('\n\n') : 'No new call tasks today',
    ids: sorted.map((s) => s.row.id),
  }
}

export async function run({
  sql,
  db,
  notify = null,
  transport = null,
  sheet = null,
  internalRecipients = [],
  notifyTo = [],
  notifyFrom = 'bot@bcn-services.com',
  dryRun = true,
  now = new Date(),
  uuid = randomUUID,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'digest', kind, detail)

  if (!notifyTo.length) {
    await log('error', { reason: 'NOTIFY_TO is unset — nothing mailed' })
    return { sent: 0, listed: 0 }
  }
  try {
    for (const to of notifyTo) assertAllowed(to, internalRecipients, 'NOTIFY_ALLOWED_RECIPIENTS')
  } catch (err) {
    await log('error', { error: String(err?.message ?? err) })
    return { sent: 0, listed: 0 }
  }

  const date = etDate(now)
  const { rows, sentToday } = await db.digestCandidates(sql, date)

  // A manual re-dispatch after the day's digest: nothing new, so say nothing.
  if (!rows.length && sentToday) {
    await log('skipped', { reason: 'nothing new since today\'s digest', date })
    return { sent: 0, listed: 0 }
  }

  const { ids, ...mail } = digestMail(rows, date)
  const send = notify ?? createNotifier({ transport, internalRecipients, from: notifyFrom, dryRun, uuid, now })
  let delivered = 0
  let dry = 0
  let failed = 0
  for (const to of notifyTo) {
    try {
      // createNotifier answers { dryRun: true } when it sent nothing (DRY_RUN, or
      // no SMTP credentials): that is not a delivery.
      const res = await send({ to, ...mail })
      if (res?.dryRun) dry++
      else delivered++
    } catch (err) {
      failed++
      await log('error', { to, error: String(err?.message ?? err) })
    }
  }
  // Any failed recipient leaves no marker: the next run re-lists every row (the
  // recipients who did get this mail get it again).
  if (failed) return { sent: delivered, listed: 0 }

  // `would_digest` is ignored by digestCandidates: a run that mailed nobody
  // must not consume the rows.
  const live = !(dryRun || dry)
  await log(live ? 'digested' : 'would_digest', { ids, date, subject: mail.subject })
  if (live && rows.length) await appendToSheet(sheet, rows, date, log)
  return { sent: delivered, listed: ids.length }
}

async function appendToSheet(sheet, rows, date, log) {
  if (!sheet) return log('sheet_skipped', { reason: 'no sheet capability (BCNS_SHEET or Google token unset)', date })
  try {
    const mapped = sortRows(rows).map((r) => mapRow(r, date))
    const fresh = dedupe(await sheet.placeIds(), mapped)
    if (fresh.length) await sheet.append(fresh)
    await log('sheet_appended', { count: fresh.length, skipped: mapped.length - fresh.length, date })
  } catch (err) {
    await log('sheet_failed', { error: String(err?.message ?? err), date })
  }
}
