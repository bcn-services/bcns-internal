// Personalization: one Claude call per business, producing the single
// generated sentence the template has a hole for. Never a second pass — a
// generation call plus a humanizer pass is two calls and the humanizer is an
// authoring tool, not a runtime one.
//
// Everything else in the email is fixed text from `lib/template.mjs`, so the
// only thing that can go wrong is that one sentence. It is validated after
// rendering and the row is left at `qualified` when it fails, which means the
// next run retries rather than sending something unchecked.

import { render } from '../lib/template.mjs'

// The three strings the lane names, plus the shapes they stand for. A draft
// that trips any of these is a rejected draft, not a fixed one: the model gets
// no second turn to argue.
export const BANNED = ['http', '$', 'demo is ready']

export const MIN_FACTS = 3
export const BUFFER_CAP = 25

export const PROMPT = `You are writing ONE sentence for a cold email to the owner of a local trade business.

Return ONLY that sentence as plain text. No quotes, no preamble, no JSON.

The sentence describes a PATTERN across other businesses in the same trade and
ends in a way that invites the owner to talk about how they handle it. Shape:
"Most TRADE owners we talk to end up DOING_SOMETHING_BY_HAND."

Hard rules:
- One sentence, and end it WITHOUT a period: the email continues "and I'd love
  to learn more about how you handle that at ...", so your text is a clause.
- Never diagnose THIS business. Never state a pain, a number about them, a
  price, a named competitor, a URL, or a claim that a demo already exists.
- Every claim must trace to one of the RESEARCH FACTS below.
- No em dashes and no en dashes.

`

export async function run({
  sql,
  db,
  claude,
  readVoiceRules,
  limit = 25,
  bufferCap = BUFFER_CAP,
  minFacts = MIN_FACTS,
} = {}) {
  const log = (kind, detail) => db.logEvent(sql, 'personalize', kind, detail)

  if (!claude) {
    await log('skipped', { reason: 'missing deps: claude' })
    return { drafted: 0, skipped: 0, errors: 0 }
  }

  // The voice rules ride in on the ~/os clone, which is gated on a repo
  // variable. Absent is normal, not an error: the fixed blocks already carry
  // the voice, and the run continues without them.
  let voice = ''
  if (!readVoiceRules) {
    await log('skipped', { reason: 'no voice rules reader injected; using fixed blocks alone' })
  } else {
    try {
      voice = (await readVoiceRules()) || ''
      if (!voice) await log('skipped', { reason: 'voice rules absent; using fixed blocks alone' })
    } catch (err) {
      await log('skipped', { reason: `voice rules unreadable: ${String(err?.message ?? err)}` })
    }
  }

  const [{ count = 0 } = {}] = (await db.draftedCount(sql)) ?? []
  const headroom = bufferCap - count
  if (headroom <= 0) {
    await log('skipped', { reason: 'draft buffer full', drafted: count, cap: bufferCap })
    return { drafted: 0, skipped: 0, errors: 0 }
  }

  const businesses = await db.qualifiedBacklog(sql, { limit: Math.min(limit, headroom) })
  if (!businesses.length) {
    await log('skipped', { reason: 'no businesses at stage qualified' })
    return { drafted: 0, skipped: 0, errors: 0 }
  }

  let drafted = 0
  let skipped = 0
  let errors = 0

  for (const b of businesses) {
    if (drafted >= headroom) break
    try {
      const research = parseResearch(b.research)
      const facts = Array.isArray(research.facts) ? research.facts.filter(Boolean) : []

      // Thin copy is worse than no copy: a two-fact email says nothing a
      // stranger could not have written, and it burns the address.
      if (facts.length < minFacts) {
        skipped++
        await log('skipped', { business: b.id, reason: 'fewer than three research facts', facts: facts.length })
        continue
      }

      const answer = await claude.ask(buildPrompt(b, facts, voice))
      const sentence = oneSentence(typeof answer === 'string' ? answer : String(answer?.text ?? answer))

      const draft = render({
        name: b.name,
        // There is no owner_name column; when qualify finds one it lands in
        // `research`. Absent means no greeting name, never a guessed one.
        ownerName: research.owner_name ?? b.owner_name ?? null,
        email: b.email,
        sentence,
      })

      const hit = BANNED.find((term) => draft.includes(term))
      if (hit) {
        errors++
        await log('error', { business: b.id, reason: 'draft failed content check', term: hit })
        continue
      }

      await db.updateBusiness(sql, b.id, {
        stage: 'drafted',
        research: JSON.stringify({ ...research, draft }),
      })
      drafted++
      await log('drafted', { business: b.id, facts: facts.length })
    } catch (err) {
      errors++
      await log('error', { business: b.id, name: b.name, error: String(err?.message ?? err) })
    }
  }

  return { drafted, skipped, errors }
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

function buildPrompt(b, facts, voice) {
  const where = [b.town, b.state].filter(Boolean).join(', ')
  return (
    PROMPT +
    (voice ? `VOICE RULES:\n${voice}\n\n` : '') +
    `BUSINESS: ${b.name}\n` +
    `TRADE: ${b.trade ?? 'trade'}\n` +
    `LOCATION: ${where || 'unknown'}\n` +
    `RESEARCH FACTS:\n${facts.map((f) => `- ${f}`).join('\n')}\n`
  )
}

// The model is asked for one sentence; this is what happens when it sends two.
// Dashes are normalised rather than rejected because rejecting would spend the
// call and produce nothing.
function oneSentence(text) {
  const clean = String(text).replace(/[—–]/g, ',').replace(/\s+/g, ' ').trim()
  const end = clean.indexOf('. ')
  return (end === -1 ? clean : clean.slice(0, end)).replace(/[.!?]+$/, '').trim()
}
