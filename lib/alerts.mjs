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

function parseGithub({ subject, text, html, fromNotifications = true }) {
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
    // Two independent signals must both say "not an incident" before this
    // mail is written off: it did not come from notifications@ AND its
    // subject is not a run-failed shape. Either one alone would be a way to
    // drop a real run failure (GitHub can route it through a non-notifications
    // path; a subject alone can't rule out a forwarded or spoofed mail).
    notice:
      !runFailed && !prRunFailed && !fromNotifications
        ? 'github account mail — sender is not notifications@ and the subject is not a run-failed notice'
        : null,
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
    // Two independent signals: no issues/<id> link in the body AND the
    // subject didn't name a project. Real issue-alert mail always has one or
    // the other (usually both) per the shapes above; account, billing and
    // digest mail has neither.
    notice:
      !issueId && !project
        ? 'sentry account mail — no issue link and the subject does not name a project'
        : null,
    refs,
  }
}

function parseUptimeRobot({ subject, text, fromAlertSender = true }) {
  // The parenthesised URL is optional: the older template appended it to the
  // monitor's friendly name, the current one sends the name alone. Both shapes
  // have to parse. An unparsed DOWN subject leaves `refs` empty, so
  // resolveRepo finds no host to match a client README against and the outage
  // is filed against the ALERT_REPO fallback; an unparsed UP subject looks
  // like a brand new DOWN and burns a second PR on the recovery.
  const m = subject.match(/^Monitor is (DOWN|UP):\s*(.+?)\s*(?:\(\s*(\S+)\s*\))?\s*$/i)
  let monitorName, monitorUrl, host
  const resolved = !!m && /^up$/i.test(m[1])
  if (m) {
    monitorName = m[2].trim()
    monitorUrl = m[3]?.trim()
    if (monitorUrl) {
      try {
        host = new URL(monitorUrl).hostname
      } catch {
        host = monitorUrl
      }
    } else {
      // With no URL in the subject the name is all there is, and UptimeRobot
      // defaults a monitor's name to the address it checks — so a name shaped
      // like a host (with or without a path) still yields the host that
      // resolveRepo matches against a client README's `site:`.
      const fromName = monitorName.match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[:\/?#]|$)/i)
      if (fromName) host = fromName[1].toLowerCase()
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
    // Name second: a monitor whose name is not a host still needs a stable
    // seed, or two mails about one outage hash their differing first lines
    // into two fingerprints and open two PRs.
    fingerprintSeed: host ? `uptimerobot:${host}` : monitorName ? `uptimerobot:${monitorName.toLowerCase()}` : null,
    resolved,
    // Two independent signals must both say "not an incident" before this
    // mail is written off: it did not come from the alerting sender AND its
    // subject is not a monitor state change. Either one alone would be a way
    // to drop a real outage (the vendor renames a sender; it alerts on an SSL
    // expiry, which has its own subject shape).
    notice:
      !m && !fromAlertSender
        ? 'uptimerobot account mail — sender is not alert@ and the subject is not a monitor state change'
        : null,
    refs,
  }
}

export function parseAlert({ from = '', subject = '', text = '', html = '' } = {}) {
  // A forwarded alert keeps its subject shape but not its sender, so the
  // GitHub check also accepts the subject alone.
  subject = subject.replace(/^(?:(?:fwd?|fw)\s*:\s*)+/i, '').trim()
  // Any sender on github.com, not just notifications@: account mail (a PAT
  // added/regenerated, a sudo code, an email address added) is real mail from
  // the vendor that otherwise fell through to the `unknown` passthrough —
  // fallback repo, fixer, draft PR, for mail that is not an incident.
  // `fromNotifications` is what tells the two apart inside parseGithub.
  if (/@(?:[\w-]+\.)*github\.com\b/i.test(from) || /^\[[^\]]+]\s*(?:PR )?run failed:/i.test(subject)) {
    return parseGithub({ subject, text, html, fromNotifications: /(?:^|[\s<])notifications@github\.com\b/i.test(from) })
  }
  if (/@sentry\.io$/i.test(from) || /noreply@md\.getsentry\.com/i.test(from)) return parseSentry({ subject, text, html })
  // Any sender on the vendor's domain, not just the alerting one: signing the
  // monitors up with alerts@ means the welcome, billing and product mail lands
  // there too, and left unrecognised it fell through to the `unknown`
  // passthrough — fallback repo, fixer, draft PR, for mail that is not an
  // incident. `fromAlertSender` is what tells the two apart.
  if (/@(?:[\w-]+\.)*uptimerobot\.com\b/i.test(from)) {
    return parseUptimeRobot({ subject, text, fromAlertSender: /(?:^|[\s<])alert@uptimerobot\.com\b/i.test(from) })
  }

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

// Whether an alert on `repo` is a regression worth a fixer or build-out noise.
// CI history cannot tell the two apart (a repo goes green early, then red for
// weeks while it is built), and GitHub carries no production marker for these
// repos, so the signal is the client README's `status:` — the one place a
// human already says whether the thing is shipped. Repos named explicitly in
// ALERT_REPO / ALERT_REPO_MAP are an opt-in and always proceed. For GitHub mail
// a red on any branch but main/master is work in progress (the fixer's own
// `alert/*` branches included, which is what stops a fix loop).
// Returns a skip reason, or null to proceed.
export const LIVE_STATUSES = new Set(['complete', 'active', 'dormant'])

export function createAlertGate({ clients = [], map = {}, fallback = null } = {}) {
  const explicit = new Set([fallback, ...Object.values(map)].filter(Boolean).map((r) => r.toLowerCase()))
  return function gate(parsed, repo) {
    if (parsed?.source === 'github') {
      const { branch } = parsed.refs ?? {}
      if (!branch) return 'github: no branch in subject (PR run) — not a default-branch regression'
      if (!/^(main|master)$/i.test(branch)) return `github: ${branch} is not the default branch`
    }
    if (!repo || explicit.has(repo.toLowerCase())) return null
    const client = clientFor(repo, clients)
    if (!client) return null
    if (!LIVE_STATUSES.has(String(client.status || '').toLowerCase())) {
      return `client ${client.name} is ${client.status || 'unset'} in its README, not live — build-out noise`
    }
    return null
  }
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
      out.push({ name: fm.name || d.name, github: fm.github || null, repo: fm.repo || null, site: fm.site || null, status: fm.status || null, readme })
    }
    return out
  } catch {
    return []
  }
}
