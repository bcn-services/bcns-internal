// Dispatch-only. Proves the keyless GCP exchange worked: the auth step in
// clock.yml either produced an access token in the environment or it did not.
// Nothing here calls a Google API.

export async function run({ sql, logEvent, env = process.env } = {}) {
  const token = env.CLOUDSDK_AUTH_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN || ''
  const ok = token.length > 0
  const detail = { ok, project: env.GCP_PROJECT || null, tokenLength: token.length }

  if (sql && logEvent) await logEvent(sql, 'authcheck', ok ? 'ok' : 'missing', detail)
  if (!ok) throw new Error('no Google access token in the environment — the workload identity exchange did not run')
  return detail
}
