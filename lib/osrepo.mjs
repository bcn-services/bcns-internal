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

  for (const args of argv) await exec('git', args, { cwd: dir })
  return { dryRun: false, commands }
}
