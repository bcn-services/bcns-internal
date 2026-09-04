// The Claude client. Shells out to the Claude Code CLI rather than the
// Anthropic API on purpose: the CLI bills against the existing subscription
// through CLAUDE_CODE_OAUTH_TOKEN, and this pipeline is not to run up API
// charges. No API key exists anywhere in this repo.
//
// Jobs never import this directly — it is injected, so tests never spawn it.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Exported so lib/skills.mjs can wrap the same invocation, and so tests can
// inject a fake instead of spawning the CLI.
export const run = promisify(execFile)

export function claudeClient({ model = 'sonnet', timeout = 120_000 } = {}) {
  return {
    async ask(prompt) {
      const { stdout } = await run(
        'claude',
        ['-p', prompt, '--model', model, '--output-format', 'json'],
        { timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const envelope = JSON.parse(stdout)
      return envelope.result ?? envelope
    },
  }
}
