// Pushes what a skill wrote back to ~/os. Only ever touches the $OS_DIR
// checkout — never this repo, and never `main` of this repo.
//
// No force push, ever: a rejected push means someone else moved the branch,
// and the fix is a human looking at it, not overwriting their work. Under dry
// run nothing is executed at all — the would-be commands are returned so a
// caller can log exactly what a live run would have done.

const quote = (a) => a.map((x) => (/[^\w@%+=:,./-]/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : x))

export async function commitAndPush({ exec, dir, paths = [], message, dryRun = true } = {}) {
  const argv = [
    ['add', ...paths],
    ['commit', '-m', message],
    ['pull', '--rebase'],
    ['push'],
  ]
  const commands = argv.map((args) => `git ${quote(args).join(' ')}`)

  if (dryRun) return { dryRun: true, commands }

  // A live push with no runner is a wiring bug, not a git failure. Say so here
  // rather than throwing `exec is not a function` four frames down.
  if (typeof exec !== 'function') {
    throw new Error('commitAndPush needs an exec to run git with — none was wired in')
  }

  await exec('git', ['add', ...paths], { cwd: dir })

  // `git add` stages nothing when a skill rewrote a file byte-identically, and
  // `git commit` then exits non-zero — which execFile turns into a throw that
  // kills the job before its caller can mark the row done, so the row retries
  // forever. Nothing staged is not a failure: the content is already in the
  // repo. `diff --cached --quiet` exits 1 when there is something staged.
  let staged = false
  try {
    await exec('git', ['diff', '--cached', '--quiet'], { cwd: dir })
  } catch {
    staged = true
  }
  if (staged) await exec('git', ['commit', '-m', message], { cwd: dir })

  await exec('git', ['pull', '--rebase'], { cwd: dir })
  await exec('git', ['push'], { cwd: dir })
  return { dryRun: false, commands }
}

// The one way a job is allowed to persist "this is done".
//
// `commitAndPush` under DRY_RUN (the default) executes nothing and returns
// `{ dryRun: true }`. A caller that wrote its completion marker anyway — the
// pitch job did — marked every row done while pushing nothing, and the row
// filters then skipped those rows forever. So the marker write, the stage
// move and the success event all live behind this guard: null means nothing
// was pushed, leave the row exactly as it was found and try again next tick.
export async function pushOrSkip({ commitAndPush, paths, message, log, detail = {} }) {
  const push = await commitAndPush({ paths, message })
  if (push?.dryRun) {
    await log('skipped', {
      reason: 'dry run — nothing pushed, row left unmarked',
      message,
      paths,
      commands: push.commands,
      ...detail,
    })
    return null
  }
  return push
}
