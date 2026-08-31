// The dispatcher. One entry point for every scheduled and manual run.
//
// It never catches a job's error: a failed job must fail the workflow run, or
// a broken pipeline looks green forever.

export const SCHEDULES = {
  '*/20 8-20 * * 1-5': 'poll',
  '0 14 * * 1-5': 'touch',
  // The Monday tick is a chain: source finds businesses, qualify reads the
  // ones it just wrote. Order is the contract, so it lives in this list.
  '0 13 * * 1': ['source', 'qualify'],
}

export function jobNames({ schedule = '', job = '' } = {}) {
  const names = job.trim() ? [job.trim()] : [SCHEDULES[schedule.trim()] ?? []].flat()
  if (!names.length) {
    throw new Error(
      `no job for schedule ${JSON.stringify(schedule)} and input ${JSON.stringify(job)}`
    )
  }
  return names
}

export function jobName(input) {
  return jobNames(input)[0]
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

  // No credential of its own, but capped on purpose: qualify feeds whatever
  // comes back into a prompt, so an unbounded page is an unbounded bill.
  deps.fetchPage = createFetchPage()

  // The CLI bills against the subscription through this OAuth token. There is
  // no API key path — no token means qualify has no `claude` and skips.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    const { claudeClient } = await import('../lib/claude.mjs')
    deps.claude = claudeClient()
  }

  // Verification needs an envelope sender to put in MAIL FROM; without one
  // there is no probe, and qualify simply trusts what it found.
  if (env.MAIL_FROM) {
    const [{ verifyEmail, smtpSession }, { resolveMx }, net] = await Promise.all([
      import('../lib/verify.mjs'),
      import('node:dns/promises'),
      import('node:net'),
    ])
    deps.verify = (address) =>
      verifyEmail(address, {
        resolveMx,
        from: env.MAIL_FROM,
        connect: (host) =>
          new Promise((resolve, reject) => {
            const socket = net.connect(25, host)
            socket.once('error', reject)
            socket.once('connect', () => resolve(smtpSession(socket)))
          }),
      })
  }

  deps.dryRun = env.DRY_RUN !== 'false'
  return deps
}

// A page fetch with both ends capped: a deadline, and a byte ceiling read off
// the body stream so a hostile or broken server cannot stream forever.
export function createFetchPage({
  fetchImpl = fetch,
  timeoutMs = 10_000,
  maxBytes = 512 * 1024,
} = {}) {
  return async function fetchPage(url) {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'user-agent': 'bcns-outreach/1.0' },
    })
    if (!res.ok) throw new Error(`fetch ${url} returned ${res.status}`)
    const text = await res.text()
    return text.length > maxBytes ? text.slice(0, maxBytes) : text
  }
}

export async function main(env = process.env, load = (n) => import(`./${n}.mjs`)) {
  const names = jobNames({ schedule: env.SCHEDULE, job: env.JOB })

  // A job below the stop marker is not built yet. That is not a failure: the
  // clock is deliberately standing before the jobs it will drive, and a red X
  // every twenty minutes would train everyone to ignore this workflow. A job
  // that EXISTS and throws still fails the run, which is the case that matters.
  let deps = null
  const results = []
  try {
    for (const name of names) {
      let mod
      try {
        mod = await load(name)
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
        console.log(`job ${name} is not built yet — nothing to run`)
        results.push({ skipped: 'not-built', job: name })
        continue
      }
      if (typeof mod.run !== 'function') throw new Error(`job ${name} exports no run()`)
      deps ??= await buildDeps(env)
      results.push(await mod.run(deps))
    }
  } finally {
    await deps?.sql?.end({ timeout: 5 })
  }
  return results.length === 1 ? results[0] : results
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
