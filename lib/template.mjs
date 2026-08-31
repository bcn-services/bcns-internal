// The runtime copy of the cold-email template. The authoring source is
// `~/os/skills/outreach/SKILL.md`; this file is a byte-faithful copy of the
// fenced block under "## The template" there. Change the skill first, then
// re-copy — never edit one side alone.
//
// Everything outside the slots is fixed and identical in every send. The only
// variable body text is the one generated sentence at `>>> GENERATED <<<`.

import { readFileSync } from 'node:fs'

export const TEMPLATE = `Subject: a question about BUSINESS_NAME

Hi OWNER_NAME,

I hope you're doing well. I'm Nate, I run a small software company called BCNS
with my partner Brandon. We're in Connecticut and we build custom tools for
local businesses.

I'm not writing to sell you anything. >>> GENERATED <<< and I'd love to learn
more about how you handle that at BUSINESS_NAME.

If you're open to it, we'll build a mock-up of what a tool for your shop could
look like and walk you through it on a call. That part is free, and it takes
about fifteen minutes.

Best,
NATE_SIGNATURE

Reply "stop" and I won't write again.
`

// The signature is a repo asset, not an external boundary: one read of a
// tracked file beats a second copy of Nate's contact details that can drift.
export const SIGNATURE = readFileSync(new URL('./signature.txt', import.meta.url), 'utf8').trim()

// Role addresses reach a desk, not a person; greeting one by name reads as a
// mail merge, so the name is dropped rather than guessed.
const ROLE_LOCAL = /^(info|office|contact|sales)@/i

export function isRoleAddress(email) {
  return ROLE_LOCAL.test(String(email ?? '').trim())
}

export function render({ name, ownerName = null, email = null, sentence, signature = SIGNATURE }) {
  const greet = ownerName && !isRoleAddress(email) ? `Hi ${ownerName},` : 'Hi,'
  return TEMPLATE
    .replace('Hi OWNER_NAME,', greet)
    .replace('>>> GENERATED <<<', String(sentence).trim())
    .replace('NATE_SIGNATURE', signature)
    .replaceAll('BUSINESS_NAME', name)
}
