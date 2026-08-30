// Writes one dated file per day under outputs/heartbeat. The weekly source run
// commits it, which is the only thing keeping GitHub from disabling this
// repo's schedules after sixty days of inactivity.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const DIR = 'outputs/heartbeat'

export async function run({ sql, logEvent, now = new Date(), dir = DIR } = {}) {
  const date = now.toISOString().slice(0, 10)
  const file = join(dir, `${date}.txt`)
  const already = existsSync(file)

  mkdirSync(dir, { recursive: true })
  // Rewriting the same path is what keeps a second run of the same day from
  // leaving a second file.
  writeFileSync(file, `${date}\n`)

  if (sql && logEvent) {
    await logEvent(sql, 'heartbeat', already ? 'skipped' : 'wrote', { file, date })
  }
  return { file, date, already }
}
