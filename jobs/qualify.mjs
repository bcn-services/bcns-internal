// Qualification: one page fetch pair, one Claude call, per business.
//
// The rule that matters: an email address is only ever taken from something
// the site actually published. Constructing info@<domain> is a guess, a guess
// is a bounce, and bounces are what kill a sending domain. A business with no
// discoverable address is a calling lead, not a dead one.

import { trim } from '../lib/trim.mjs'

export const CONTACT_PATHS = ['/contact', '/contact-us', '/about']

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i

export const PROMPT = `You are reading the website of a local trade business.

Return ONLY minified JSON of this exact shape:
{"email": string|null, "owner_name": string|null, "facts": string[], "fit": "good"|"weak"|"no", "reason": string}

Rules:
- "email" must be an address that appears verbatim in the page text below. If no
  address appears, return null. Never construct one from the domain.
- "owner_name" is the first name of a named owner/founder ONLY if the page text
  states it explicitly (e.g. "owned by Dave Miller", "founder: Sarah Chen").
  Never infer, guess, or take it from a generic staff/team list without a role
  tying them to ownership. No name stated means null — never a guess.
- "facts" is three to five specific, checkable things about THIS business drawn
  from the page — services, years in business, towns served, named staff,
  certifications. No generic filler. Phrase each fact as a predicate that
  completes the sentence "<business name> ..." and starts with a verb, e.g.
  "has served Milford since 1998", "is GAF Master Elite certified",
  "offers 24-hour emergency repairs". Never start a fact with the business name.
- "fit" judges whether this business has manual, repeatable work — booking,
  scheduling, follow-ups, intake, quoting — that AI automation could take off
  their plate. An existing website is irrelevant to this; a business can have
  a great site and still run its scheduling by hand.

PAGE TEXT:
`

// Verification verdicts that mean the address cannot receive mail. `unknown`
// is deliberately absent: greylisting and catch-all servers land there, and an
// unknown is never enough to throw away a discovered address.
const UNDELIVERABLE = new Set(['invalid', 'no-mx', 'rejected'])

// The page text is stored on the row so `pitch` can build a pitch from what
// qualify already read, months later, without fetching the site again. Capped
// because a research blob is read back into prompts and an uncapped page is an
// uncapped bill; 20k is well above what `trim` returns for a real site.
export const PAGE_TEXT_MAX = 20_000

// The prompt asks for minified JSON and usually gets it, but a model handed
// something it cannot work with answers in prose about that instead, and a
// helpful one wraps the object in a ```json fence. Neither is a reason to lose
// the row, so the first balanced object in the answer is what counts.
export function parseAnswer(answer) {
  if (typeof answer !== 'string') return answer
  try {
    return JSON.parse(answer)
  } catch {
    const start = answer.indexOf('{')
    const end = answer.lastIndexOf('}')
    if (start === -1 || end <= start) {
      throw new Error(`no JSON in the model's answer: ${answer.slice(0, 200)}`)
    }
    return JSON.parse(answer.slice(start, end + 1))
  }
}

function parseResearch(research) {
  if (!research) return {}
  if (typeof research === 'string') {
    try {
      return JSON.parse(research)
    } catch {
      return {}
    }
  }
  return research
}

export async function run({
  sql,
  db,
  fetchPage,
  claude,
  verify,
  limit = 25,
  contactPaths = CONTACT_PATHS,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'qualify', kind, detail)

  // A missing capability is a skipped event, never a throw: the clock runs this
  // job every Monday whether or not the runner has a Claude CLI token.
  const missing = [!fetchPage && 'fetchPage', !claude && 'claude'].filter(Boolean)
  if (missing.length) {
    await log('skipped', { reason: `missing deps: ${missing.join(', ')}` })
    return { qualified: 0, callDue: 0, errors: 0, skipped: missing }
  }

  const businesses = await db.sourcedBacklog(sql, { limit })

  if (!businesses.length) {
    await log('skipped', { reason: 'no businesses at stage sourced' })
    return { qualified: 0, callDue: 0, errors: 0 }
  }

  let qualified = 0
  let callDue = 0
  let skipped = 0
  let errors = 0

  for (const b of businesses) {
    try {
      // No website means nothing to read and no address to find. Per LANE that
      // is a calling lead, not an error to retry every Monday forever.
      if (!b.domain) {
        await db.updateBusiness(sql, b.id, { stage: 'call_due' })
        callDue++
        await log('call_due', { business: b.id, reason: 'no domain' })
        continue
      }
      const home = await fetchPage(homepage(b))
      let contact = ''
      for (const path of contactPaths) {
        try {
          contact = await fetchPage(homepage(b) + path)
          if (contact) break
        } catch {
          // A missing contact page is normal, not a failure of the business.
        }
      }

      const text = `${trim(home)}\n\n${trim(contact)}`.trim()

      // No page text is not a business to judge, it is a fetch that failed —
      // a dead site, a bot wall, a redirect loop. Asking the model to read
      // nothing spends a call to be told so in prose. The row stays at
      // `sourced` and the next tick tries the site again.
      if (!text) {
        skipped++
        await log('skipped', { business: b.id, name: b.name, reason: 'page fetch returned no text' })
        continue
      }

      const answer = await claude.ask(PROMPT + text)
      const parsed = parseAnswer(answer)

      const facts = Array.isArray(parsed.facts) ? parsed.facts : []
      // Trust nothing: the address must be well-formed AND actually present in
      // the text we sent, or the model invented it.
      const claimed = typeof parsed.email === 'string' ? parsed.email.trim() : ''
      const email =
        claimed && EMAIL_RE.test(claimed) && text.toLowerCase().includes(claimed.toLowerCase())
          ? claimed
          : null

      const ownerName = typeof parsed.owner_name === 'string' ? parsed.owner_name.trim() : ''
      const research = JSON.stringify({
        ...parseResearch(b.research),
        facts,
        fit: parsed.fit ?? null,
        reason: parsed.reason ?? null,
        owner_name: ownerName || null,
        page_text: text.slice(0, PAGE_TEXT_MAX),
      })

      // The address came off a web page; that it is well-formed says nothing
      // about whether a server will accept it. A failed probe demotes the row
      // to a calling lead rather than letting a bounce reach the sending domain.
      let verdict = null
      if (email && verify) {
        try {
          verdict = await verify(email)
        } catch {
          // A probe that could not run is an unknown, not a rejection.
          verdict = null
        }
      }

      if (verdict && UNDELIVERABLE.has(verdict.status)) {
        // phone stays as sourced; the unusable address is cleared.
        await db.updateBusiness(sql, b.id, {
          email: null,
          stage: 'call_due',
          research,
        })
        callDue++
        await log('call_due', { business: b.id, reason: 'email failed verification', status: verdict.status })
      } else if (email) {
        await db.updateBusiness(sql, b.id, {
          email,
          stage: 'qualified',
          research,
        })
        qualified++
        await log('qualified', { business: b.id, facts: facts.length })
      } else {
        // phone is deliberately not written — it stays exactly as sourced.
        await db.updateBusiness(sql, b.id, {
          stage: 'call_due',
          research,
        })
        callDue++
        await log('call_due', { business: b.id, reason: 'no discoverable email' })
      }
    } catch (err) {
      errors++
      await log('error', { business: b.id, name: b.name, error: String(err?.message ?? err) })
      // The row is left untouched, so it stays at stage sourced and is retried.
    }
  }

  return { qualified, callDue, skipped, errors }
}

function homepage(b) {
  if (!b.domain) throw new Error(`business ${b.id} has no domain`)
  return b.domain.startsWith('http') ? b.domain.replace(/\/$/, '') : `https://${b.domain}`
}
