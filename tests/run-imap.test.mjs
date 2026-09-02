// The IMAP boundary's pure half. The failure this file exists for: an html-only
// `multipart/related` reply arrives with `parsed.text === undefined`, and an
// empty body reads as "not an opt-out" — an invisible false negative.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { htmlToText, toMessage, drainMessages, MAX_MESSAGES_PER_TICK } from '../jobs/run.mjs'

test('the constants this suite asserts against are what they claim to be', () => {
  assert.equal(MAX_MESSAGES_PER_TICK, 100)
})

test('htmlToText reads the sentence out of an html body', () => {
  assert.equal(htmlToText('<div>Please <b>unsubscribe</b> me.</div>'), 'Please unsubscribe me.')
  assert.equal(htmlToText('<p>Hi</p><p>Take me off your list</p>'), 'Hi\n\nTake me off your list')
  assert.equal(htmlToText('a<br>b'), 'a\nb')
  assert.equal(htmlToText('<style>p{color:red}</style><p>stop emailing me</p>'), 'stop emailing me')
  assert.equal(htmlToText('<p>we&nbsp;don&#39;t want any more emails</p>'), "we don't want any more emails")
  assert.equal(htmlToText('<img src="cid:x">'), '')
  assert.equal(htmlToText(undefined), '')
})

// The exact shape mailparser hands back for a multipart/related html-only
// reply: an html node, and NO text field at all.
const parsed = (over = {}) => ({
  from: { value: [{ address: 'dana@acmeroofing.example' }] },
  subject: 'Re: a question',
  html: '<div>Please remove from your list</div>',
  inReplyTo: '<msg-1@send.bcn-services.com>',
  references: [],
  headers: new Map([['delivered-to', 'outreach@send.bcn-services.com']]),
  ...over,
})

test('an html-only message with no text field still yields a readable body', () => {
  const m = toMessage(parsed(), 7)

  assert.equal(m.text, 'Please remove from your list')
  assert.equal(m.uid, 7)
  assert.equal(m.deliveredTo, 'outreach@send.bcn-services.com')
  assert.equal(m.from, 'dana@acmeroofing.example')
})

test('a text/plain part still wins over the html', () => {
  assert.equal(toMessage(parsed({ text: 'not interested' }), 7).text, 'not interested')
})

test('an unreadable html body yields an empty string, never undefined', () => {
  assert.equal(toMessage(parsed({ html: '<img src="cid:sig">' }), 7).text, '')
})

test('one tick drains at most MAX_MESSAGES_PER_TICK messages', async () => {
  async function* source() {
    for (let uid = 1; uid <= 150; uid++) yield { uid, source: uid }
  }

  const out = await drainMessages(source(), async (uid) => parsed({ text: `body ${uid}` }))

  assert.equal(out.length, 100)
  assert.equal(out.at(-1).uid, 100)
})

test('htmlToText decodes hex and named quote entities, and closes inline tags up', () => {
  assert.equal(htmlToText('<p>we don&#x27;t want any more emails</p>'), "we don't want any more emails")
  assert.equal(htmlToText('<p>we don&rsquo;t want any more emails</p>'), 'we don’t want any more emails')
  assert.equal(htmlToText('<p>we don&#8217;t want any more emails</p>'), 'we don’t want any more emails')
  assert.equal(htmlToText('<div>Please <b>un</b>subscribe me</div>'), 'Please unsubscribe me')
  assert.equal(htmlToText('<table><tr><td>stop</td><td>emailing me</td></tr></table>'), 'stop\n\nemailing me')
})

// Attachments: the shape mailparser really hands back, parameters and casing
// included. `poll` decides whether to write a file to ~/os off these fields.
test('the parse exposes attachment parts with a normalised content type', () => {
  const content = Buffer.from('%PDF-1.7 countersigned')
  const m = toMessage(
    parsed({
      attachments: [
        {
          type: 'attachment',
          contentType: 'application/pdf; name=contract.pdf',
          contentDisposition: 'attachment',
          filename: 'contract.pdf',
          headers: new Map(),
          checksum: 'd41d8cd98f00b204e9800998ecf8427e',
          content,
          size: content.length,
        },
      ],
    }),
    7
  )

  assert.equal(m.attachments.length, 1)
  assert.equal(m.attachments[0].contentType, 'application/pdf')
  assert.equal(m.attachments[0].size, content.length)
  assert.equal(m.attachments[0].filename, 'contract.pdf')
  assert.equal(m.attachments[0].content.toString('utf8'), '%PDF-1.7 countersigned')
})

test('a mixed-case content type normalises, and a missing size falls back to the bytes', () => {
  const m = toMessage(
    parsed({ attachments: [{ contentType: 'Application/PDF', content: Buffer.alloc(11) }] }),
    7
  )
  assert.equal(m.attachments[0].contentType, 'application/pdf')
  assert.equal(m.attachments[0].size, 11)
})

test('a message with no attachments yields an empty array, never undefined', () => {
  assert.deepEqual(toMessage(parsed(), 7).attachments, [])
})
