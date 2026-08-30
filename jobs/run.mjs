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

export async function main(env = process.env, load = (n) => import(`./${n}.mjs`)) {
  const name = jobName({ schedule: env.SCHEDULE, job: env.JOB })
  const mod = await load(name)
  if (typeof mod.run !== 'function') throw new Error(`job ${name} exports no run()`)

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
  deps.dryRun = env.DRY_RUN !== 'false'

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
