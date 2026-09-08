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
