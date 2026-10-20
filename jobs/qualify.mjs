// Qualification: one page fetch pair, at most one Claude call, per business.
//
// Qualify is a fit scorer for the bcns Connect niche, not an email finder. A
// row PASSES only if (a) the site shows at least MIN_SIGNALS of the four
// signals in lib/signals.mjs, detected by CODE from the raw HTML, and (b) it
// has a phone number to dial. Pass -> `qualified` with research.fit_score;
// anything else -> `lost` with research.lost_reason ('unfit' | 'no_phone' |
// 'fetch_failed' | 'qualify_failed'). `no_email` is legacy and is never written here.
//
// The rule that still matters: an email address is only ever taken from
// something the site actually published, and is stored UNVERIFIED (calls need
// no mailbox). Constructing info@<domain> is a guess, and bounces kill a
// sending domain, so it never happens.

import { trim } from '../lib/trim.mjs'
import { evidence, countSignals, SIGNAL_KEYS } from '../lib/signals.mjs'

export const CONTACT_PATHS = ['/contact', '/contact-us', '/about']

// Anchored: a claim that is not an address and nothing else ("info@acme.com.",
// "Email: info@acme.com") is rejected, never stored with the stray characters.
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i

// The hard gate: signals detected in the HTML by code. A model-reported signal
// with no code evidence does not count, so an over-eager model cannot pass a row.
export const MIN_SIGNALS = 2

export const PROMPT = `You are reading the website of a small business for bcns, which builds custom
operations software (online ordering, booking, invoicing, client portals) for
professional-service firms (accounting, bookkeeping, tax, insurance, law,
agencies, consultancies, staffing, architecture/engineering, real estate and
property management) and online small businesses (online stores, DTC brands,
specialty retail, wholesalers).

Return ONLY minified JSON of this exact shape:
{"email": string|null, "owner_name": string|null, "facts": string[], "signals": {"store": boolean, "booking": boolean, "payments": boolean, "marketing": boolean}, "headcount_band": "1-5"|"6-20"|"21-50"|"51+"|null, "locations": number|null, "fit_score": number, "reason": string}

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
- "signals" says whether the page shows each of: store (online store or
  ordering platform), booking (booking/scheduling widget or client portal/
  login), payments (accounting or online-payment link), marketing (ad/analytics
  tags, email-marketing tools, active social links). Judge only from the text.
- "headcount_band" is your best read of how many people work there; null if the
  page gives no hint. "locations" is the number of physical locations; a
  franchise or national chain counts as 3 or more; null if unclear.
- "fit_score" is 0-100: how well this business matches the niche above and how
  much manual, repeatable work (booking, follow-ups, intake, invoicing, order
  handling) automation could take off their plate. An existing website is
  irrelevant to this. "reason" is one sentence saying why.

PAGE TEXT:
`

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

// --- the score --------------------------------------------------------------
// fit_score, an integer 0-100, written to research.fit_score as a JSON number
// (the digest and the promotion query sort it numerically):
//
//   signals    20 each of the CODE-detected four (a passing row has 2-4: 40-80)
//   niche      0-6    the model's niche read (its 0-100 fit_score * 0.06)
//   headcount  +5     headcount band starts at or below 20 people
//   single     +5     exactly one location
//   geography  +0.3 CT, +0.2 NYC metro (NY/NJ), +0.1 CA, 0 elsewhere
//
// Everything but signals and geography is a whole number and sums to at most
// 16 < 20, so one more signal always outranks every other factor combined.
// Geography totals under 1 point, so it is a pure tiebreak: it can never beat
// a one-point difference in any other factor. A chain or franchise (3+
// locations) is capped at 20, below the 40 floor of any non-chain row that
// passes the gate. Still a JSON number (one decimal), sorted numerically.
export const CHAIN_CAP = 20

export function fitScore({ signals, nicheScore, headcountBand, locations, state }) {
  const count = countSignals(signals)
  const niche = Math.round(Math.min(100, Math.max(0, Number(nicheScore) || 0)) * 0.06)
  const small = Number.parseInt(String(headcountBand ?? ''), 10) <= 20 ? 5 : 0
  const single = locations === 1 ? 5 : 0
  const st = String(state ?? '').toUpperCase()
  // Tenths, so the sum stays exact: 98.3, never 98.30000000000001.
  const geoTenths = st === 'CT' ? 3 : st === 'NY' || st === 'NJ' ? 2 : st === 'CA' ? 1 : 0 // ponytail: state-level NYC metro — refine by town if NJ/upstate NY rows crowd the list
  const score = (20 * count + niche + small + single) * 10 + geoTenths
  return Math.min(100, locations >= 3 ? Math.min(score / 10, CHAIN_CAP) : score / 10)
}

// A site that fails this many ticks running is a dead site, not a flaky one.
export const MAX_QUALIFY_FAILURES = 3

export const DEFAULT_BUDGET_MS = 20 * 60 * 1000

// Promotion only runs on ticks before the weekday digest (cron `30 12 * * 1-5`,
// jobs/run.mjs): a row promoted after the digest waits for the next one and
// lands on top of that morning's fresh list.
export const DIGEST_MINUTE_UTC = 12 * 60 + 30

// Per-run row cap. The time guard (budgetMs) is what actually bounds a run;
// this only has to sit above what one budget can get through. See the PR body
// for the arithmetic.
export const DEFAULT_LIMIT = 150

export async function run({
  sql,
  db,
  fetchPage,
  claude,
  limit = DEFAULT_LIMIT,
  contactPaths = CONTACT_PATHS,
  budgetMs = DEFAULT_BUDGET_MS,
  // When the process must be done, set once by main() in jobs/run.mjs from the
  // workflow's timeout. The loop gets min(budgetMs, time left to it) so a slow
  // tick (pitch/quote runs ahead of qualify) cannot be killed mid-qualify with
  // its promotion step never reached. Unset: budgetMs alone.
  deadline,
  clock = () => Date.now(),
  callTasksPerDay = 50,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'qualify', kind, detail)

  // A missing capability is a skipped event, never a throw: the clock runs this
  // job whether or not the runner has a Claude CLI token.
  const missing = [!fetchPage && 'fetchPage', !claude && 'claude'].filter(Boolean)
  if (missing.length) {
    await log('skipped', { reason: `missing deps: ${missing.join(', ')}` })
    return { qualified: 0, lost: 0, errors: 0, skipped: missing, promoted: 0, timedOut: false }
  }

  const businesses = await db.sourcedBacklog(sql, { limit })

  let qualified = 0
  let lost = 0
  let skipped = 0
  let errors = 0
  let timedOut = false
  // moved: a stage write for the current row already landed, so a later throw
  // (a log) must not rewrite it. Reset per row.
  let moved = false

  if (!businesses.length) {
    await log('skipped', { reason: 'no businesses at stage sourced' })
  }

  // Parks a row that cannot be a call task: stage `lost`, the reason on the
  // row's research so a human (or a later rubric change) can find it again.
  const lose = async (b, reason, detail = {}, extra = {}) => {
    await db.updateBusiness(sql, b.id, {
      stage: 'lost',
      research: JSON.stringify({ ...parseResearch(b.research), ...extra, lost_reason: reason }),
    })
    moved = true
    lost++
    await log('lost', { business: b.id, reason, ...detail })
  }

  // Counts a failed attempt on the row's research. The write bumps updated_at,
  // which rotates the row to the back of sourcedBacklog; at the cap the row is
  // parked as `lost`. Two separate counters: FETCH is the site's fault (dead,
  // blocked); QUALIFY_ERRORS is everything after a good fetch (Claude, parse,
  // DB) and must not be charged to the site. A failing counter write must never
  // mask the original error or end the run.
  const FETCH = { counter: 'qualify_failures', lostReason: 'fetch_failed', why: 'site unreachable' }
  const QUALIFY_ERRORS = { counter: 'qualify_errors', lostReason: 'qualify_failed', why: 'qualify failed' }
  const recordFailure = async (b, { counter, lostReason, why } = FETCH) => {
    try {
      const research = parseResearch(b.research)
      const failures = (research[counter] ?? 0) + 1
      if (failures >= MAX_QUALIFY_FAILURES) {
        await db.updateBusiness(sql, b.id, {
          stage: 'lost',
          research: JSON.stringify({ ...research, [counter]: failures, lost_reason: lostReason }),
        })
        await log('lost', { business: b.id, reason: `${why} after ${MAX_QUALIFY_FAILURES} attempts` })
      } else {
        await db.updateBusiness(sql, b.id, {
          research: JSON.stringify({ ...research, [counter]: failures }),
        })
      }
    } catch {
      // The row stays at sourced and is retried; the error event is already written.
    }
  }

  const startedAt = clock()
  const budget = deadline == null ? budgetMs : Math.min(budgetMs, deadline - startedAt)

  for (const b of businesses) {
    if (clock() - startedAt >= budget) {
      timedOut = true
      break
    }
    // fetched: the fetch phase finished, so a later throw (Claude, parsing, DB)
    // is not the site's fault: it counts as a qualify error, not a fetch failure.
    let fetched = false
    moved = false
    try {
      // Hard gate 2: a call task with no number to dial is worthless. Checked
      // before any fetch so a phoneless row costs nothing.
      if (!String(b.phone ?? '').trim()) {
        await lose(b, 'no_phone')
        continue
      }
      // No website: no signals to detect, so it cannot clear the signal gate.
      if (!b.domain) {
        await lose(b, 'unfit', { detail: 'no domain' })
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
      fetched = true

      // No page text is not a business to judge, it is a fetch that failed —
      // a dead site, a bot wall, a redirect loop. The row stays at `sourced`
      // until it has failed MAX_QUALIFY_FAILURES times.
      if (!text) {
        skipped++
        await log('skipped', { business: b.id, name: b.name, reason: 'page fetch returned no text' })
        await recordFailure(b)
        continue
      }

      // Hard gate 1, by code, on the RAW html (pixels and widgets live in the
      // tags `trim` strips). Below the gate the row can never pass whatever the
      // model would say, so the Claude call is not spent.
      const found = evidence(`${home}\n${contact}`)
      const signals = Object.fromEntries(SIGNAL_KEYS.map((k) => [k, found[k].length > 0]))
      if (countSignals(signals) < MIN_SIGNALS) {
        await lose(b, 'unfit', { signals: countSignals(signals) }, { signals, signal_evidence: found })
        continue
      }

      const answer = await claude.ask(PROMPT + text)
      const parsed = parseAnswer(answer)

      const facts = Array.isArray(parsed.facts) ? parsed.facts : []
      // Trust nothing: the address must be well-formed AND actually present in
      // the text we sent, or the model invented it. Stored unverified.
      const claimed = typeof parsed.email === 'string' ? parsed.email.trim() : ''
      const email =
        claimed && EMAIL_RE.test(claimed) && text.toLowerCase().includes(claimed.toLowerCase())
          ? claimed
          : null

      const ownerName = typeof parsed.owner_name === 'string' ? parsed.owner_name.trim() : ''
      const headcountBand = typeof parsed.headcount_band === 'string' ? parsed.headcount_band : null
      const locations = Number.isFinite(parsed.locations) ? parsed.locations : null
      const nicheScore = Number(parsed.fit_score)
      const research = JSON.stringify({
        ...parseResearch(b.research),
        facts,
        // The score the digest and promotion sort by: a number, from code.
        fit_score: fitScore({ signals, nicheScore, headcountBand, locations, state: b.state }),
        signals,
        signal_evidence: found,
        // What the model claimed, kept to spot regex gaps; it never gates or scores.
        signals_model: parsed.signals ?? null,
        niche_score: Number.isFinite(nicheScore) ? nicheScore : null,
        headcount_band: headcountBand,
        locations,
        reason: parsed.reason ?? null,
        owner_name: ownerName || null,
        ...(email && { email_verified: false }),
        page_text: text.slice(0, PAGE_TEXT_MAX),
      })

      const patch = { stage: 'qualified', research, ...(email && { email }) }
      try {
        await db.updateBusiness(sql, b.id, patch)
      } catch (err) {
        // businesses_email_key: another row (possibly a suppressed one) owns
        // this address. The business is still a good call task; drop the email.
        if (err?.code !== '23505' || !email) throw err
        delete patch.email
        await db.updateBusiness(sql, b.id, patch)
      }
      moved = true
      qualified++
      await log('qualified', { business: b.id, facts: facts.length, signals: countSignals(signals) })
    } catch (err) {
      errors++
      await log('error', { business: b.id, name: b.name, error: String(err?.message ?? err) })
      try {
        // A post-fetch error must rotate the row too, or it sits at the head of
        // sourcedBacklog and burns a Claude call every tick forever.
        if (!moved) await recordFailure(b, fetched ? QUALIFY_ERRORS : FETCH)
      } catch {
        // Counting failed; the row stays at sourced and is retried.
      }
    }
  }

  if (timedOut) {
    await log('skipped', {
      reason: 'time guard — budgetMs or the process deadline exceeded, remaining rows stay at sourced',
    })
  }

  // Promotion runs every tick regardless of whether there was a sourced
  // backlog above — the qualified pool fills from many past runs, and the call
  // list has to keep getting fed even on a day with nothing fresh to qualify.
  // Only on weekday ticks before the digest: qualify rides the every-day
  // hourly tick, but the digest goes out once, weekdays at 12:30 UTC, and lists
  // everything promoted since the last one. A weekend or afternoon promotion
  // would pile into the next digest on top of that morning's own 50.
  let promoted = 0
  const at = new Date(clock())
  const day = at.getUTCDay()
  const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes()
  if (day !== 0 && day !== 6 && minuteOfDay < DIGEST_MINUTE_UTC) {
    const [{ count: promotedSoFar = 0 } = {}] = (await db.promotedToday(sql)) ?? []
    const room = callTasksPerDay - promotedSoFar
    if (room > 0) {
      const rows = (await db.promoteQualified(sql, { limit: room })) ?? []
      for (const row of rows) {
        promoted++
        await log('promoted', { business: row.id })
      }
    }
  }

  return { qualified, lost, skipped, errors, promoted, timedOut }
}

function homepage(b) {
  if (!b.domain) throw new Error(`business ${b.id} has no domain`)
  return b.domain.startsWith('http') ? b.domain.replace(/\/$/, '') : `https://${b.domain}`
}
