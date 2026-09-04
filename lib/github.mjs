// Opens a draft PR for one triaged alert. Never merges — there is no merge
// call anywhere in this file, on purpose, matching the item's guardrail.
//
// Same exec-injection shape as `lib/osrepo.mjs`'s `commitAndPush`: `exec` is a
// parameter so a test asserts the `gh` command without a token or a real repo,
// and `dryRun` runs nothing at all, returning the command instead.
//
// ponytail: assumes `branch` already carries a commit worth reviewing — this
// item is the triage/cap/dedupe logic (jobs/poll.mjs), not "turn an alert
// email into a diff". Wire that up when an alert has real content to commit.
export function createGithubPr({ exec, repo, dryRun = true } = {}) {
  return async function openDraftPr({ title, body, branch }) {
    const argv = ['pr', 'create', '--draft', '--repo', repo, '--title', title, '--body', body, '--head', branch]
    if (dryRun) return { dryRun: true, command: `gh ${argv.join(' ')}` }
    if (typeof exec !== 'function') {
      throw new Error('createGithubPr needs an exec to run gh with — none was wired in')
    }
    const { stdout } = await exec('gh', argv)
    return { url: String(stdout ?? '').trim() }
  }
}
