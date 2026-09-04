// Builds the bcns pitch for a business that has gone to phone.
//
// One pitch per business, ever. The marker is `research.pitch_path`: a row
// that has one is skipped forever, because a second /pitch run costs a Claude
// call and overwrites work a human may already have edited in ~/os.
//
// This job never fetches a website. Everything it hands the skill was already
// gathered by `qualify` and stored on the row — the facts it extracted and the
// page text it read — so a call task cannot re-crawl a site that has since
// gone dark, and the pitch is reproducible from the row alone.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pushOrSkip } from '../lib/osrepo.mjs'

// Postgres unique_violation. The only failure of the slug write we handle:
// anything else is a real database problem and belongs in the error event.
const UNIQUE_VIOLATION = '23505'

export function parseResearch(research) {
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

export function slugFor(row) {
  const kebab = [row.name, row.town]
    .filter(Boolean)
    .join(' ')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab || `business-${String(row.id).slice(-6)}`
}

// The slug is written to the funnel row before the skill runs, so a crash
// halfway through leaves the business pointing at the directory the next run
// will use rather than inventing a second one.
export async function claimSlug(sql, db, row) {
  if (row.os_slug) return row.os_slug
  const base = slugFor(row)
  try {
    await db.updateBusiness(sql, row.id, { os_slug: base })
    return base
  } catch (err) {
    if (err?.code !== UNIQUE_VIOLATION) throw err
    // Two businesses of the same name in the same town is normal. The place id
    // is the one thing Google guarantees is theirs alone.
    const suffix = String(row.place_id ?? row.id).slice(-6)
    const alt = `${base}-${suffix}`
    await db.updateBusiness(sql, row.id, { os_slug: alt })
    return alt
  }
}

export async function run({
  sql,
  db,
  runSkill,
  commitAndPush,
  osDir,
  dryRun = true,
  skillLimit,
  limit = skillLimit ?? 25,
  mkTempDir = () => mkdtemp(join(tmpdir(), 'bcns-pitch-')),
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'pitch', kind, detail)
  const result = { pitched: 0, errors: 0 }

  // A missing capability is a skipped event, never a throw: the poll tick runs
  // every twenty minutes whether or not ~/os was cloned onto the runner.
  const missing = [!osDir && 'osDir', !runSkill && 'runSkill', !commitAndPush && 'commitAndPush']
    .filter(Boolean)
  if (missing.length) {
    await log('skipped', { reason: `missing deps: ${missing.join(', ')}` })
    return { ...result, skipped: missing }
  }

  const rows = (await db.businessesByStage(sql, 'call_due', { limit })) ?? []
  const todo = rows.filter((row) => !parseResearch(row.research).pitch_path)
  if (!todo.length) {
    await log('skipped', { reason: 'no call_due row without a pitch' })
    return result
  }

  for (const row of todo) {
    let command = null
    try {
      const research = parseResearch(row.research)
      const slug = await claimSlug(sql, db, row)

      // Facts and page text go to disk rather than into the command line: a
      // page is thousands of characters and an argv is not the place for it.
      const dir = await mkTempDir()
      const factsPath = join(dir, 'facts.json')
      const pageTextPath = join(dir, 'page-text.txt')
      // The skill's documented `--facts` input is the businesses row plus its
      // research, not the fact strings alone: a call script needs the phone,
      // the town and the trade as much as it needs what qualify noticed.
      await writeFile(factsPath, JSON.stringify({ ...row, research }))
      await writeFile(pageTextPath, String(research.page_text ?? ''))

      command = `/pitch ${slug} --facts ${factsPath} --page-text ${pageTextPath} --no-browse`

      // The skill run is a paid Claude call and it rewrites files in the ~/os
      // clone. `pushOrSkip` below leaves the row unmarked on a dry tick, so a
      // call after this point is spent 37 times a weekday and marks nothing.
      // Check before, not after — same shape as jobs/onboard.mjs.
      if (dryRun) {
        await log('skipped', {
          business: row.id,
          slug,
          reason: 'dry run — no skill call, row left unmarked',
          command,
        })
        continue
      }

      const { wrote } = await runSkill({ command, cwd: osDir })
      // `git add` with no pathspec is a no-op and the commit that follows exits
      // non-zero every tick. A skill that wrote nothing is a real failure.
      if (!wrote?.length) {
        result.errors++
        await log('error', {
          business: row.id,
          slug,
          command,
          error: 'skill reported no written files — nothing to commit',
        })
        continue
      }

      const push = await pushOrSkip({
        commitAndPush,
        paths: wrote,
        message: `pitch: ${slug}`,
        log,
        detail: { business: row.id, slug },
      })
      // Nothing was pushed: leave the row unmarked so a live tick redoes it.
      if (!push) continue

      const pitchPath = `clients/${slug}/pitch/`
      await db.updateBusiness(sql, row.id, {
        research: JSON.stringify({ ...research, pitch_path: pitchPath }),
      })
      result.pitched++
      await log('pitched', {
        business: row.id,
        slug,
        pitch_path: pitchPath,
        wrote,
      })
    } catch (err) {
      result.errors++
      // The row keeps its stage and its research: the next tick tries again.
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
