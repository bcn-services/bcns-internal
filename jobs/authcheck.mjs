// Dispatch-only. Proves the keyless GCP exchange worked: the auth step in
// clock.yml either produced an access token in the environment or it did not.
// Nothing here calls a Google API.
//
// It also reports whether the ~/os clone landed, so one dispatch answers both
// questions the runner cannot answer from a green checkmark alone. The clone
// is optional, so a missing OS_DIR is reported, never thrown.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export async function run({ sql, logEvent, env = process.env, exists = existsSync } = {}) {
  const token = env.CLOUDSDK_AUTH_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN || ''
  const ok = token.length > 0
  const osDir = env.OS_DIR || ''
  const voiceRules = osDir ? exists(join(osDir, 'knowledge/library/bcns-voice/voice-rules.md')) : false
  const detail = {
    ok,
    project: env.GCP_PROJECT || null,
    tokenLength: token.length,
    os: { dir: osDir || null, cloned: osDir ? exists(osDir) : false, voiceRules },
  }

  if (sql && logEvent) await logEvent(sql, 'authcheck', ok ? 'ok' : 'missing', detail)
  if (!ok) throw new Error('no Google access token in the environment — the workload identity exchange did not run')
  return detail
}
