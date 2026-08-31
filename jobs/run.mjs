// The dispatcher. One entry point for every scheduled and manual run.
//
// It never catches a job's error: a failed job must fail the workflow run, or
// a broken pipeline looks green forever.

export const SCHEDULES = {
  '*/20 8-20 * * 1-5': 'poll',
  '0 14 * * 1-5': 'touch',
  '0 13 * * 1': 'source',
}

export function jobName({ schedule = '', job = '' } = {}) {
  const name = job.trim() || SCHEDULES[schedule.trim()]
  if (!name) {
    throw new Error(
      `no job for schedule ${JSON.stringify(schedule)} and input ${JSON.stringify(job)}`
    )
  }
  return name
}

// Deps are built from the environment alone, so what a job is handed is
// inspectable without a database or a Google token in sight. A missing
// credential means the job simply is not given that capability; jobs decide
// what to do about it and write their own skipped event.
export async function buildDeps(env = process.env) {
  const deps = {}
  if (env.DATABASE_URL) {
    const [{ default: postgres }, db] = await Promise.all([
      import('postgres'),
      import('../lib/db.mjs'),
    ])
    deps.sql = postgres(env.DATABASE_URL)
    deps.db = db
    deps.logEvent = db.logEvent
    // The grid lives in code; the table only tracks run state, so every run
    // reconciles the two before reading.
    const { GRID } = await import('../lib/grid.mjs')
    deps.loadCells = async () => {
      await db.upsertCells(deps.sql, GRID)
      return db.allCells(deps.sql)
    }
    deps.saveCell = (cell) => db.saveCell(deps.sql, cell)
  }

  // Keyless: the workflow's auth step mints this token, and mints nothing when
  // GCP is unconfigured. No token means no `places`/`readBudget` on deps at
  // all, so source writes a skipped event rather than spending blind.
  const token = env.CLOUDSDK_AUTH_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN || ''
  const project = env.GCP_PROJECT || ''
  if (token && project) {
    const [{ createPlaces }, { createReadBudget }] = await Promise.all([
      import('../lib/places.mjs'),
      import('../lib/budget.mjs'),
    ])
    deps.places = createPlaces({ token, project })
    deps.readBudget = createReadBudget({
      token,
      project,
      cap: Number(env.BCNS_PLACES_MONTHLY_CAP) || undefined,
    })
  }

  deps.dryRun = env.DRY_RUN !== 'false'
  return deps
}

export async function main(env = process.env, load = (n) => import(`./${n}.mjs`)) {
  const name = jobName({ schedule: env.SCHEDULE, job: env.JOB })

  // A job below the stop marker is not built yet. That is not a failure: the
  // clock is deliberately standing before the jobs it will drive, and a red X
  // every twenty minutes would train everyone to ignore this workflow. A job
  // that EXISTS and throws still fails the run, which is the case that matters.
  let mod
  try {
    mod = await load(name)
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
    console.log(`job ${name} is not built yet — nothing to run`)
    return { skipped: 'not-built', job: name }
  }
  if (typeof mod.run !== 'function') throw new Error(`job ${name} exports no run()`)

  const deps = await buildDeps(env)

  try {
    return await mod.run(deps)
  } finally {
    await deps.sql?.end({ timeout: 5 })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
