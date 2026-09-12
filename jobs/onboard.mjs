// Turns a signed business into a ~/os intake folder.
//
// Onboarding used to also create a per-client GitHub repo (`/new-client-repo`).
// bcns moved to a shared-data-layer platform (one shared app, client_id-scoped)
// so there is no new repo to create — this job now only runs `/intake`, which
// writes files into the ~/os clone and is safe on a dry run the same way
// `/pitch` and `/quote` are: nothing is pushed, so nothing needs undoing.
//
// The marker is `stage = 'onboarded'`, written only after a real push, so a
// tick that pushed nothing leaves the row exactly as it found it. The
// idempotency read is `research.intake_checklist_path`: once `/intake` has
// run for a row, a repeat tick is a no-op, the same shape `jobs/quote.mjs`
// uses for `research.quote_path`.
//
// Row selection is three independent gates: a client row must exist, it must
// have a `signed_at` (the manual `won <amount>` command moves a business to
// `won` without one — that is a human's note, not a signed contract), and it
// must not already have run intake.

import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { parseResearch, claimSlug } from './pitch.mjs'
import { pushOrSkip } from '../lib/osrepo.mjs'

// Only the frontmatter's own `status:` line. A `status: lead` in the body of
// the README is prose about something else and is left alone. `/intake`
// creates the README from `_TEMPLATE.md` (status: lead) when one doesn't
// already exist; onboarding is the moment the build starts, so both move to
// in-progress.
export function bumpReadmeStatus(text) {
  return String(text).replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (_all, open, front, close) =>
    open + front.replace(/^status:[ \t]*(lead|active)[ \t]*$/m, 'status: in-progress') + close
  )
}

// The skill prints paths relative to its own cwd (osDir) as often as
// absolute ones; resolve against osDir, never process.cwd().
const relativise = (osDir, path) => (path ? relative(osDir, resolve(osDir, path)) || path : null)

export async function run({
  sql,
  db,
  runSkill,
  commitAndPush,
  osDir,
  dryRun = true,
  skillLimit,
  limit = skillLimit ?? 25,
} = {}) {
  let logged = 0
  const log = (kind, detail) => (logged++, db.logEvent(sql, 'onboard', kind, detail))
  const result = { onboarded: 0, errors: 0 }

  const missing = [!osDir && 'osDir', !runSkill && 'runSkill', !commitAndPush && 'commitAndPush']
    .filter(Boolean)
  if (missing.length) {
    await log('skipped', { reason: `missing deps: ${missing.join(', ')}` })
    return { ...result, skipped: missing }
  }

  const rows = (await db.businessesByStage(sql, 'won', { limit })) ?? []

  const todo = []
  for (const row of rows) {
    const client = (await db.clientByBusiness(sql, row.id))?.[0] ?? null
    if (!client) {
      await log('skipped', { business: row.id, reason: 'won with no client row' })
      continue
    }
    if (!client.signed_at) {
      await log('skipped', {
        business: row.id,
        reason: 'won with no signed_at — the manual `won` command, not a signed contract',
      })
      continue
    }
    // Already onboarded on an earlier tick. Silent: a repeat is the normal
    // steady state, not something a human needs told about.
    const research = parseResearch(row.research)
    if (research.intake_checklist_path) continue
    todo.push(row)
  }

  if (!todo.length) {
    if (!logged) await log('skipped', { reason: 'no won row ready to onboard' })
    return result
  }

  for (const row of todo) {
    let command = null
    try {
      const research = parseResearch(row.research)
      const slug = await claimSlug(sql, db, row)

      command = `/intake ${slug} --yes`

      // Same shape as jobs/quote.mjs: the guard runs before the skill call,
      // so a dry run costs nothing and marks nothing.
      if (dryRun) {
        await log('skipped', {
          business: row.id,
          slug,
          reason: 'dry run — no skill call, row left unmarked',
          command,
        })
        continue
      }

      const { wrote: intakeWrote, text, denials } = await runSkill({ command, cwd: osDir })
      // No pathspec means `git add` is a no-op and the commit fails every tick.
      if (!intakeWrote?.length) {
        result.errors++
        await log('error', {
          business: row.id,
          slug,
          command,
          error: 'skill reported no written files — nothing to commit',
          denials,
          said: text,
        })
        continue
      }
      const found = (suffix) => intakeWrote.find((p) => p.endsWith(suffix)) ?? null
      const checklistPath = relativise(osDir, found('intake/checklist.md'))
      const requestEmailPath = relativise(osDir, found('intake/request-email.md'))

      const readmePath = join(osDir, 'clients', slug, 'README.md')
      const before = await readFile(readmePath, 'utf8')
      const after = bumpReadmeStatus(before)
      if (after !== before) await writeFile(readmePath, after)

      // Absolute — these go to `git add`. The skill reports relative paths too.
      const paths = [...new Set([...intakeWrote, readmePath].map((p) => resolve(osDir, p)))]
      const push = await pushOrSkip({
        commitAndPush,
        paths,
        message: `onboard: ${slug}`,
        log,
        detail: { business: row.id, slug },
      })
      // Nothing pushed: no marker, so the next live tick redoes it.
      if (!push) continue

      // notify reads these two off the row, so it needs no client read.
      await db.updateBusiness(sql, row.id, {
        stage: 'onboarded',
        research: JSON.stringify({
          ...research,
          intake_checklist_path: checklistPath,
          request_email_path: requestEmailPath,
        }),
      })
      result.onboarded++
      await log('onboarded', {
        business: row.id,
        slug,
        intake_checklist_path: checklistPath,
        request_email_path: requestEmailPath,
        wrote: paths,
      })
    } catch (err) {
      result.errors++
      await log('error', {
        business: row.id,
        command,
        error: String(err?.message ?? err),
        stderr: String(err?.stderr ?? ''),
      })
    }
  }

  return result
}
