import { test } from 'node:test'
import assert from 'node:assert/strict'

import { run } from '../jobs/verify-status.mjs'

function fakeDb({ counts = [], drafts = [] } = {}) {
  const events = []
  return {
    events,
    logEvent: async (_sql, job, kind, detail) => events.push({ job, kind, detail }),
    eventCounts: async () => counts,
    recentSentDrafts: async () => drafts,
  }
}

test('verify-status: no recipients configured skips without sending', async () => {
  const db = fakeDb()
  const out = await run({ sql: {}, db, internalRecipients: [] })
  assert.equal(out.sent, 0)
  assert.equal(db.events[0].kind, 'skipped')
})

test('verify-status: mails every internal recipient with counts and drafts', async () => {
  const db = fakeDb({
    counts: [{ job: 'poll', kind: 'ok', count: 5 }],
    drafts: [{ name: 'Acme Roofing', email: 'dana@acme.example', draft: 'Subject: hi\n\nHi Dana,\n' }],
  })
  const sent = []
  const notify = async (mail) => sent.push(mail)

  const out = await run({
    sql: {},
    db,
    internalRecipients: ['nseluga@bcn-services.com', 'bchung@bcn-services.com'],
    notify,
  })

  assert.equal(out.sent, 2)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map((m) => m.to), ['nseluga@bcn-services.com', 'bchung@bcn-services.com'])
  assert.match(sent[0].text, /poll\/ok: 5/)
  assert.match(sent[0].text, /Acme Roofing/)
  assert.equal(db.events.at(-1).kind, 'sent')
})
