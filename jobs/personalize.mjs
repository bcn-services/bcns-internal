// Personalization: one Claude call per business, producing the single
// generated compliment sentence the template has a hole for. Never a second
// pass — a generation call plus a humanizer pass is two calls and the
// humanizer is an authoring tool, not a runtime one.
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
export const BUFFER_CAP = 50

// qualify asks for facts shaped as a predicate starting with a verb, so most
// splice straight after the name. Older rows and a model that ignored the
// ask fall through: a leading number gets "has", anything else gets "is",
// which is not guaranteed grammatical — spot-check drafts after a trade this
// hasn't run against before.
const VERB_LEAD =
  /^(offers|provides|serves|specializes|services|has|have|is|are|was|does|runs|holds|installs|installed|employs|operates|uses|carries|handles|covers|maintains|repairs|builds|works|trains|earned|won|opened|started|founded|owns)\b/i
const NUMBER_LEAD = /^(over|more than|nearly|almost|about)?\s*\d/i

// A reaction with no subject reads as a fragment after "and" ("and hard to
// rack up that many"). Two of the first eight live sends shipped like that.
export const FRAGMENT_LEAD =
  /^(hard|rare|tough|easy|great|nice|good|solid|quite|really|so|very|pretty|impressive|amazing|always|definitely)\b/i

export const PROMPT = `You are writing a short compliment for a cold email to the owner of a local small business.

Return EXACTLY two lines, plain text, no preamble:
FACT: one fact copied VERBATIM from the RESEARCH FACTS below, character for character
REACTION: a short reaction clause, four to ten words, reacting to that fact like a person genuinely would

Picking FACT:
- Pick the fact the owner is proudest of: years in business, generations in
  the family, review count or rating, an award, a real certification.
- Never pick an address, a license or registration number, a phone number, a
  plain list of services, a list of towns, a directory/BBB listing that merely
  exists, or a fact naming the owner or staff.
- Never reference patients, anyone's health, legal matters, or anyone's
  personal situation — the category can be a dentist, chiropractor, physical
  therapist, or lawyer, and none of that is fair game for a cold-email opener.

Hard rules:
- REACTION must be an OPINION about the fact, not a new fact. Never add a
  noun, number, name, or claim that isn't already in the FACT line.
- REACTION must be a COMPLETE CLAUSE with its own subject — it gets glued
  after "and" with nothing else supplying one. Never a bare adjective phrase.
  Start it with "that's", "it's", a pronoun, or a restated subject.
- Never use "impressive", "notable", "significant", or "stands out" in REACTION.
- Lean warm, not flat. Skip lukewarm one-word verdicts like "solid", "good", or
  "nice" — react the way someone genuinely struck by the fact would put it, in
  their own words. "that's hard to keep with hundreds of reviews" and
  "33 years in one shop is rare these days" are the right register: specific,
  a little admiring, still plain speech.
- Never diagnose THIS business. Never state a pain, a price, or a named competitor.
- Every claim must trace to one of the RESEARCH FACTS below.
- No em dashes and no en dashes.

`

export async function run({
  sql,
  db,
  claude,
  readVoiceRules,
  limit = 50,
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

      // qualify already judged this business unfit for automation; drafting
      // it anyway would queue an email to someone we've decided not to pitch.
      if (research.fit === 'no') {
        skipped++
        await log('skipped', { business: b.id, reason: 'qualify marked fit: no', fitReason: research.reason })
        continue
      }

      const facts = Array.isArray(research.facts) ? research.facts.filter(Boolean) : []

      // Thin copy is worse than no copy: a two-fact email says nothing a
      // stranger could not have written, and it burns the address.
      if (facts.length < minFacts) {
        skipped++
        await log('skipped', { business: b.id, reason: 'fewer than three research facts', facts: facts.length })
        continue
      }

      const answer = await claude.ask(buildPrompt(b, facts, voice))
      const { fact, reaction } = parseFactReaction(typeof answer === 'string' ? answer : String(answer?.text ?? answer))

      // The model was told to copy a fact verbatim; check it, rather than
      // trust it. A fact that isn't an exact match to something in `facts` is
      // a paraphrase or an invention, and this is the one place that can be
      // caught in code instead of by rereading every draft by hand.
      const verbatim = facts.some((f) => f.trim().toLowerCase() === fact.trim().toLowerCase())
      if (!fact || !reaction || !verbatim || FRAGMENT_LEAD.test(reaction)) {
        errors++
        await log('error', { business: b.id, reason: 'compliment failed verification', fact, reaction })
        continue
      }

      const sentence = composeCompliment(b.name, fact, reaction)

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
    `CATEGORY: ${b.trade ?? 'trade'}\n` +
    `LOCATION: ${where || 'unknown'}\n` +
    `RESEARCH FACTS:\n${facts.map((f) => `- ${f}`).join('\n')}\n`
  )
}

// Pulls the FACT: and REACTION: lines out of the model's answer. Dashes are
// normalised rather than rejected because rejecting would spend the call and
// produce nothing; a missing line comes back empty and fails verification
// in run(), not here.
export function parseFactReaction(text) {
  const lines = String(text)
    .replace(/[—–]/g, ',')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const factLine = lines.find((l) => /^FACT:/i.test(l))
  const reactionLine = lines.find((l) => /^REACTION:/i.test(l))
  return {
    fact: factLine ? factLine.replace(/^FACT:\s*/i, '').trim() : '',
    reaction: reactionLine
      ? reactionLine.replace(/^REACTION:\s*/i, '').trim().replace(/[.!?]+$/, '')
      : '',
  }
}

// "I noticed BUSINESS_NAME <clause>, and REACTION." The clause needs a copula
// ("is"/"has") inserted, or none, depending on whether the fact already
// starts with a third-person verb, a number, or an adjective/participle. See
// the VERB_LEAD/NUMBER_LEAD comment above for the coverage and its ceiling.
export function composeCompliment(name, fact, reaction) {
  const lower = fact.charAt(0).toLowerCase() + fact.slice(1)
  const clause = VERB_LEAD.test(fact) ? lower : NUMBER_LEAD.test(fact) ? `has ${lower}` : `is ${lower}`
  return `I noticed ${name} ${clause}, and ${reaction}.`
}
