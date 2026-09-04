// Turns a signed business into a client repo and a ~/os index.
//
// WHY DRY RUN IS A DIFFERENT PATH HERE. `/pitch` and `/quote` write files into
// a clone that is never pushed on a dry run, so running them dry costs a Claude
// call and nothing else. `/new-client-repo` creates a GitHub repository — an
// irreversible side effect no `pushOrSkip` guard can undo. So a dry run calls
// `/new-client-repo ... --dry-run`, which creates nothing and prints only the
// `gh repo create` line it would have run, logs that as a `skipped` event, and
// stops there: no `/intake`, no README rewrite, no marker. Live mode is the
// only path that runs the two real commands and reaches `pushOrSkip`.
//
// The markers are `clients.repo_url` and `stage = 'onboarded'`, and both are
// written only after a real push, so a tick that pushed nothing leaves the row
// exactly as it found it.
//
// Row selection is three independent gates: a client row must exist, it must
// have a `signed_at` (the manual `won <amount>` command moves a business to
// `won` without one — that is a human's note, not a signed contract), and it
// must not already have a `repo_url`.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { parseResearch, claimSlug } from './pitch.mjs'
import { pushOrSkip } from '../lib/osrepo.mjs'

// What the new repo's README is seeded from. Everything here is already on the
// row: this job fetches nothing.
export function briefMarkdown(row, research = {}) {
  const notes = [research.notes ?? []].flat().filter(Boolean)
  const facts = [research.facts ?? []].flat().filter(Boolean)
  const where = [row.town, row.state].filter(Boolean).join(', ')
  return [
    `# ${row.name ?? 'Unnamed client'}`,
    '',
    ...[
      where && `- City: ${where}`,
      row.domain && `- Site: ${row.domain}`,
      row.trade && `- Trade: ${row.trade}`,
      research.owner_name && `- Contact: ${research.owner_name}`,
      research.quote_path && `- Quote: ${research.quote_path}`,
    ].filter(Boolean),
    ...(facts.length ? ['', '## What we know', ...facts.map((f) => `- ${f}`)] : []),
    ...(notes.length ? ['', '## Notes from the call', ...notes.map((n) => `- ${n}`)] : []),
    '',
  ].join('\n')
}

// Only the frontmatter's own `status:` line. A `status: lead` in the body of
// the README is prose about something else and is left alone.
export function bumpReadmeStatus(text) {
  return String(text).replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (_all, open, front, close) =>
    open + front.replace(/^status:[ \t]*lead[ \t]*$/m, 'status: in-progress') + close
  )
}

const relativise = (osDir, path) => (path ? relative(osDir, path) || path : null)

export async function run({
  sql,
  db,
  runSkill,
  commitAndPush,
  osDir,
  dryRun = true,
  skillLimit,
  limit = skillLimit ?? 25,
  mkTempDir = () => mkdtemp(join(tmpdir(), 'bcns-onboard-')),
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
    if (client.repo_url) continue
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

      const dir = await mkTempDir()
      const briefPath = join(dir, 'brief.md')
      await writeFile(briefPath, briefMarkdown(row, research))

      if (dryRun) {
        command = `/new-client-repo ${slug} --brief ${briefPath} --yes --dry-run`
        const { dryrun } = await runSkill({ command, cwd: osDir })
        await log('skipped', {
          business: row.id,
          slug,
          reason: 'dry run — no repo created, row left unmarked',
          command,
          dryrun,
        })
        continue
      }

      command = `/new-client-repo ${slug} --brief ${briefPath} --yes`
      const { repo, wrote: repoWrote } = await runSkill({ command, cwd: osDir })
      // No REPO: line means the repo was not created. Marking the row now would
      // strand it forever with a null repo_url.
      if (!repo) throw new Error(`/new-client-repo printed no REPO: line for ${slug}`)

      command = `/intake ${slug} --yes`
      const { wrote: intakeWrote } = await runSkill({ command, cwd: osDir })
      const found = (suffix) => intakeWrote.find((p) => p.endsWith(suffix)) ?? null
      const checklistPath = relativise(osDir, found('intake/checklist.md'))
      const requestEmailPath = relativise(osDir, found('intake/request-email.md'))

      const readmePath = join(osDir, 'clients', slug, 'README.md')
      const before = await readFile(readmePath, 'utf8')
      const after = bumpReadmeStatus(before)
      if (after !== before) await writeFile(readmePath, after)

      // Absolute, like the paths the skills report — these go to `git add`.
      const paths = [...new Set([...repoWrote, ...intakeWrote, readmePath])]
      const push = await pushOrSkip({
        commitAndPush,
        paths,
        message: `onboard: ${slug}`,
        log,
        detail: { business: row.id, slug, repo },
      })
      // Nothing pushed: no marker, so the next live tick redoes it.
      if (!push) continue

      await db.updateClient(sql, row.id, { repo_url: repo })
      // notify reads these three off the row, so it needs no client read.
      await db.updateBusiness(sql, row.id, {
        stage: 'onboarded',
        research: JSON.stringify({
          ...research,
          repo_url: repo,
          intake_checklist_path: checklistPath,
          request_email_path: requestEmailPath,
        }),
      })
      result.onboarded++
      await log('onboarded', {
        business: row.id,
        slug,
        repo,
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
