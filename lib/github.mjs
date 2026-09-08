// Opens a draft PR for one triaged alert. Never merges — there is no merge
// call anywhere in this file, on purpose, matching the item's guardrail.
//
// Same exec-injection shape as `lib/osrepo.mjs`'s `commitAndPush`: `exec` is a
// parameter so a test asserts the `gh` command without a token or a real repo,
// and `dryRun` runs nothing at all, returning the command instead.
//
// `branch` is pushed by lib/fixer.mjs before this runs; without a fixer the
// call fails at `gh` and poll logs an error event.
export function createGithubPr({ exec, repo, dryRun = true } = {}) {
  // `repo` per call wins: the parser names the alerting repo, the factory's is
  // the fallback for an alert nothing could map.
  return async function openDraftPr({ title, body, branch, repo: target = repo }) {
    const argv = ['pr', 'create', '--draft', '--repo', target, '--title', title, '--body', body, '--head', branch]
    if (dryRun) return { dryRun: true, command: `gh ${argv.join(' ')}` }
    if (typeof exec !== 'function') {
      throw new Error('createGithubPr needs an exec to run gh with — none was wired in')
    }
    const { stdout } = await exec('gh', argv)
    return { url: String(stdout ?? '').trim() }
  }
}

// Decides whether a GitHub run-failed alert is a regression worth a fixer or
// build-out noise. A CI pipeline being built fails on purpose, over and over;
// a workflow that has never once passed on the default branch is still being
// built, and a red on any other branch is somebody's work in progress (the
// fixer's own `alert/*` branches included, which is what stops a fix loop).
// Returns a skip reason, or null to proceed. Non-GitHub alerts always proceed.
export function createGithubGate({ exec } = {}) {
  return async function gate(parsed, repo) {
    if (parsed?.source !== 'github') return null
    const { workflow, branch } = parsed.refs ?? {}
    if (!branch) return 'github: no branch in subject (PR run) — not a default-branch regression'
    if (!/^(main|master)$/i.test(branch)) return `github: ${branch} is not the default branch`
    if (!workflow || !repo || typeof exec !== 'function') return null
    try {
      const { stdout } = await exec('gh', ['run', 'list', '--repo', repo, '--workflow', workflow, '--branch', branch,
        '--status', 'success', '--limit', '1', '--json', 'databaseId'])
      if (JSON.parse(String(stdout || '[]')).length === 0) return `github: ${workflow} has never passed on ${branch} — still being built`
    } catch {
      // ponytail: fail open — a gh hiccup must not hide a real regression; the
      // 3/day cap bounds the cost of a wasted fixer run.
    }
    return null
  }
}
