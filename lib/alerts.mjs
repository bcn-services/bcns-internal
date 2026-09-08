// Turns an `alerts@` inbound mail into a normalized shape jobs/poll.mjs can
// dedupe and cap on. One parser per known sender, a passthrough for anything
// else. No network, no fs here — loadClientMap is the only fs touch and it
// never throws (a missing ~/os is a normal, expected state for this repo).

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const clip = (s) => String(s || '').slice(0, 600).trim()

// README `github:` is either a full URL or a bare `org/repo`.
function githubActionsRepo(url) {
  const m = String(url || '').match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i)
  return m ? m[1] : null
}

function parseGithub({ subject, text, html }) {
  let repo = null
  let workflow, branch, sha

  const runFailed = subject.match(/^\[([^\]]+)]\s*Run failed:\s*(.+?)\s*-\s*(\S+?)\s*\(([0-9a-f]{6,40})\)\s*$/i)
  const prRunFailed = subject.match(/^\[([^\]]+)]\s*PR run failed:\s*(.+?)\s*-\s*(.+)$/i)

  if (runFailed) {
    ;[, repo, workflow, branch, sha] = runFailed
    workflow = workflow.trim()
  } else if (prRunFailed) {
    ;[, repo, workflow] = prRunFailed
    workflow = workflow.trim()
  } else {
    const bracket = subject.match(/^\[([^\]]+)]/)
    if (bracket) repo = bracket[1]
  }

  const body = `${html || ''}\n${text || ''}`
  const runMatch = body.match(/https:\/\/github\.com\/[^\s"'<>]+\/actions\/runs\/(\d+)/)

  const refs = {}
  if (runMatch) {
    refs.runUrl = runMatch[0]
    refs.runId = runMatch[1]
  }
  if (workflow) refs.workflow = workflow
  if (branch) refs.branch = branch
  if (sha) refs.sha = sha

  return {
    source: 'github',
    repo,
    title: subject.replace(/^\[[^\]]+]\s*/, '').trim(),
    summary: clip(text),
    fingerprintSeed: repo && workflow ? `github:${repo}:${workflow}:${branch || ''}` : null,
    refs,
  }
}

function parseSentry({ subject, text, html }) {
  const body = `${html || ''}\n${text || ''}`
  const issueMatch = body.match(/https?:\/\/([a-z0-9-]+)\.sentry\.io\/issues\/(\d+)/i)
  const issueId = issueMatch ? issueMatch[2] : null

  let project, title
  let m
  if ((m = subject.match(/^\[Sentry]\s*\[([^\]]+)]\s*(.+)$/i))) {
    ;[, project, title] = m
  } else if ((m = subject.match(/^New alert from\s+(.+?):\s*(.+)$/i))) {
    ;[, project, title] = m
  } else if ((m = subject.match(/^\[([^\]]+)]\s*(?:\w+:\s*)?(.+)$/))) {
    ;[, project, title] = m
  } else {
    title = subject
  }
  project = project ? project.trim() : undefined
  title = (title || subject).trim()

  const refs = {}
  if (project) refs.project = project
  if (issueMatch) refs.issueUrl = `https://${issueMatch[1]}.sentry.io/issues/${issueId}/`

  return {
    source: 'sentry',
    repo: null,
    title,
    summary: clip(text),
    fingerprintSeed: issueId ? `sentry:${issueId}` : project ? `sentry:${project}:${title}` : null,
    refs,
  }
}

function parseUptimeRobot({ subject, text }) {
  const m = subject.match(/^Monitor is (DOWN|UP):\s*(.+?)\s*\(\s*(\S+)\s*\)\s*$/i)
  let monitorName, monitorUrl, host
  const resolved = !!m && /^up$/i.test(m[1])
  if (m) {
    monitorName = m[2].trim()
    monitorUrl = m[3].trim()
    try {
      host = new URL(monitorUrl).hostname
    } catch {
      host = monitorUrl
    }
  }

  const refs = {}
  if (monitorName) refs.monitorName = monitorName
  if (monitorUrl) refs.monitorUrl = monitorUrl
  if (host) refs.host = host

  return {
    source: 'uptimerobot',
    repo: null,
    title: monitorName ? `${resolved ? 'UP' : 'DOWN'}: ${monitorName}` : subject,
    summary: clip(text),
    fingerprintSeed: host ? `uptimerobot:${host}` : null,
    resolved,
    refs,
  }
}

export function parseAlert({ from = '', subject = '', text = '', html = '' } = {}) {
  // A forwarded alert keeps its subject shape but not its sender, so the
  // GitHub check also accepts the subject alone.
  subject = subject.replace(/^(?:(?:fwd?|fw)\s*:\s*)+/i, '').trim()
  if (/notifications@github\.com/i.test(from) || /^\[[^\]]+]\s*(?:PR )?run failed:/i.test(subject)) {
    return parseGithub({ subject, text, html })
  }
  if (/@sentry\.io$/i.test(from) || /noreply@md\.getsentry\.com/i.test(from)) return parseSentry({ subject, text, html })
  if (/alert@uptimerobot\.com/i.test(from)) return parseUptimeRobot({ subject, text })

  return {
    source: 'unknown',
    repo: null,
    title: subject,
    summary: clip(text),
    fingerprintSeed: null,
    refs: {},
  }
}

export function resolveRepo(parsed, { clients = [], map = {}, fallback = null } = {}) {
  // A repo named by the mail itself (GitHub subject bracket) is only trusted
  // when it is one we already know — otherwise a forged subject would point
  // the fixer's clone/push at any repo the token can reach.
  if (parsed?.repo) {
    const known = new Set(
      [fallback, ...Object.values(map), ...clients.map((c) => githubActionsRepo(c.github))].filter(Boolean).map((r) => r.toLowerCase())
    )
    if (known.has(parsed.repo.toLowerCase())) return parsed.repo
  }

  const refs = parsed?.refs || {}
  const mapLower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
  const keys = [refs.project, refs.monitorName, refs.host, parsed?.repo].filter(Boolean)
  for (const k of keys) {
    const hit = mapLower.get(k.toLowerCase())
    if (hit) return hit
  }

  for (const c of clients) {
    if (refs.host && c.site) {
      try {
        if (new URL(c.site).hostname.toLowerCase() === refs.host.toLowerCase()) {
          return githubActionsRepo(c.github)
        }
      } catch {
        /* bad site URL in a README — skip it */
      }
    }
    const name = (c.name || '').toLowerCase()
    if (name && [refs.project, refs.monitorName].filter(Boolean).some((v) => v.toLowerCase() === name)) {
      return githubActionsRepo(c.github)
    }
  }

  return null
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    let val = kv[2].trim().replace(/^"(.*)"$/, '$1')
    out[kv[1]] = val === 'null' || val === '' ? null : val
  }
  return out
}

// The client whose README points at `repo`, so the fixer can be told where
// to read about it instead of exploring ~/os.
export function clientFor(repo, clients = []) {
  const want = String(repo || '').toLowerCase()
  return clients.find((c) => githubActionsRepo(c.github)?.toLowerCase() === want) ?? null
}

export function loadClientMap(osDir) {
  try {
    const clientsDir = join(osDir, 'clients')
    if (!existsSync(clientsDir)) return []
    const dirs = readdirSync(clientsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    const out = []
    for (const d of dirs) {
      const readme = join(clientsDir, d.name, 'README.md')
      if (!existsSync(readme)) continue
      const fm = parseFrontmatter(readFileSync(readme, 'utf8'))
      out.push({ name: fm.name || d.name, github: fm.github || null, repo: fm.repo || null, site: fm.site || null, readme })
    }
    return out
  } catch {
    return []
  }
}
