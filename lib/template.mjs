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

I hope you're doing well. >>> GENERATED <<<

I'm Nate, I run a small software company called BCNS with my partner Brandon.
We're in Connecticut and we build custom tools for local businesses.

We recently built a booking and scheduling system for a similar local
business, with automated emails that follow up after every job, it freed up a
lot of the manual back-and-forth they used to spend on scheduling.

If you're open to it, I'd put together a mock-up of what a tool for your shop
could look like. Do you have fifteen minutes sometime in the next week to talk it
through?

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

// Fixed paragraphs are hand-wrapped at ~78 cols; the generated opener has to
// match that or it reads as one unbroken line next to the rest of the body.
function wrap(text, width = 78) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length > width && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

export function render({ name, ownerName = null, email = null, sentence, signature = SIGNATURE }) {
  const greet = ownerName && !isRoleAddress(email) ? `Hi ${ownerName},` : 'Hi,'
  const opener = wrap(`I hope you're doing well. ${String(sentence).trim()}`)
  return TEMPLATE
    .replace('Hi OWNER_NAME,', greet)
    .replace("I hope you're doing well. >>> GENERATED <<<", opener)
    .replace('NATE_SIGNATURE', signature)
    .replaceAll('BUSINESS_NAME', name)
}

// The HTML half of the same signature, read from the same tracked asset for
// the same reason. `multipart/alternative` needs both parts or the send reads
// as an HTML-only blast.
export const SIGNATURE_HTML = readFileSync(
  new URL('./signature.html', import.meta.url),
  'utf8'
).trim()

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const paragraphs = (s) =>
  s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('')

// The HTML part of a message whose plain text already carries SIGNATURE: the
// text signature is swapped for the markup one, everything else is the same
// words. Never a second copy of the body.
export function toHtml(text, signature = SIGNATURE, signatureHtml = SIGNATURE_HTML) {
  const at = text.indexOf(signature)
  if (at === -1) return paragraphs(text) + signatureHtml
  return (
    paragraphs(text.slice(0, at)) + signatureHtml + paragraphs(text.slice(at + signature.length))
  )
}
