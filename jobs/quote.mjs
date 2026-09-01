// Drafts the bcns quote for a business Brandon has taken to the quoting stage.
//
// The trigger is a human's note, not a model's judgement: `poll` writes
// `research.notes` from a teammate's `notes ...` reply, and a `quoting` row
// without one has nothing to quote from, so it waits.
//
// One quote per business: `research.quote_path` is the marker, and the stage
// moves to `quoted`, so neither a re-run nor a second tick pays for the skill
// twice. Nothing here mails the prospect — the quote reaches the client by
// Brandon's hand, and `notify` only tells the internal allow-list it exists.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseResearch, claimSlug } from './pitch.mjs'
import { pushOrSkip } from '../lib/osrepo.mjs'

export const notesOf = (research) => [research.notes ?? []].flat().filter(Boolean)

export async function run({
  sql,
  db,
  runSkill,
  commitAndPush,
  osDir,
  limit = 25,
  mkTempDir = () => mkdtemp(join(tmpdir(), 'bcns-quote-')),
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'quote', kind, detail)
  const result = { quoted: 0, errors: 0 }

  const missing = [!osDir && 'osDir', !runSkill && 'runSkill', !commitAndPush && 'commitAndPush']
    .filter(Boolean)
  if (missing.length) {
    await log('skipped', { reason: `missing deps: ${missing.join(', ')}` })
    return { ...result, skipped: missing }
  }

  const rows = (await db.businessesByStage(sql, 'quoting', { limit })) ?? []
  const todo = rows.filter((row) => {
    const research = parseResearch(row.research)
    return !research.quote_path && notesOf(research).length
  })
  if (!todo.length) {
    await log('skipped', { reason: 'no quoting row with notes and no quote' })
    return result
  }

  for (const row of todo) {
    let command = null
    try {
      const research = parseResearch(row.research)
      const slug = await claimSlug(sql, db, row)

      // The notes file replaces the skill's interview entirely, so it is the
      // only thing the headless run is told beyond the slug.
      const dir = await mkTempDir()
      const notesPath = join(dir, 'notes.md')
      await writeFile(notesPath, `${notesOf(research).map((n) => `- ${n}`).join('\n')}\n`)

      command = `/quote ${slug} --notes ${notesPath} --yes`
      const { wrote } = await runSkill({ command, cwd: osDir })

      const push = await pushOrSkip({
        commitAndPush,
        paths: wrote,
        message: `quote: ${slug}`,
        log,
        detail: { business: row.id, slug },
      })
      // Nothing was pushed: the row keeps its stage and its research so the
      // next live tick quotes it for real.
      if (!push) continue

      // One won business is one client. The read is the guard; 0020's unique
      // business_id is what holds if two runs ever overlap.
      const existing = (await db.clientByBusiness(sql, row.id)) ?? []
      if (!existing.length) {
        await db.insertClient(sql, {
          slug,
          display_name: row.name,
          business_id: row.id,
        })
      }

      const quotePath = `clients/${slug}/quote/`
      await db.updateBusiness(sql, row.id, {
        stage: 'quoted',
        research: JSON.stringify({ ...research, quote_path: quotePath }),
      })
      result.quoted++
      await log('quoted', { business: row.id, slug, quote_path: quotePath, wrote })
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
