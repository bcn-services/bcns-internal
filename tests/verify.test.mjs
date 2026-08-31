import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  verifyEmail,
  assertNoBody,
  classify,
  domainOf,
  replyCode,
  smtpSession,
} from '../lib/verify.mjs'

// A one-way socket: what the session writes does not loop back as incoming
// data, which is how a real TCP socket behaves.
function fakeSocket() {
  const emitter = new EventEmitter()
  const written = []
  return Object.assign(emitter, {
    written,
    write: (chunk) => written.push(chunk),
    destroy: () => {},
    receive: (chunk) => emitter.emit('data', chunk),
  })
}

// A session that records every command and answers from a script.
function fakeSession(replies = {}) {
  const commands = []
  return {
    commands,
    session: {
      command(line) {
        commands.push(line ?? '<greeting>')
        if (line === undefined) return Promise.resolve('220 mx.example.com ESMTP')
        const key = Object.keys(replies).find((k) => line.startsWith(k))
        return Promise.resolve(key ? replies[key] : '250 OK')
      },
      close: () => Promise.resolve(),
    },
  }
}

test('a domain with no MX record is rejected without opening a socket', async () => {
  let connected = 0
  const result = await verifyEmail('someone@nowhere.test', {
    resolveMx: async () => [],
    connect: async () => {
      connected++
      throw new Error('connect must not be called')
    },
    from: 'probe@send.bcn-services.com',
  })

  assert.equal(connected, 0, 'no socket may be opened when there is no MX record')
  assert.equal(result.status, 'no-mx')
  assert.equal(result.ok, false)
})

test('an MX lookup that throws is treated as no MX, still without a socket', async () => {
  let connected = 0
  const result = await verifyEmail('someone@broken.test', {
    resolveMx: async () => {
      throw new Error('ENOTFOUND')
    },
    connect: async () => {
      connected++
      return fakeSession().session
    },
    from: 'probe@send.bcn-services.com',
  })
  assert.equal(connected, 0)
  assert.equal(result.status, 'no-mx')
})

test('the probe issues RCPT TO and then QUIT, and never DATA', async () => {
  const fake = fakeSession({ 'RCPT TO': '250 2.1.5 Ok' })
  const result = await verifyEmail('real@example.com', {
    resolveMx: async () => [
      { exchange: 'backup.example.com', priority: 20 },
      { exchange: 'mx.example.com', priority: 10 },
    ],
    connect: async () => fake.session,
    from: 'probe@send.bcn-services.com',
  })

  const issued = fake.commands.join('\n')
  assert.match(issued, /RCPT TO:<real@example\.com>/)
  assert.equal(fake.commands.at(-1), 'QUIT', 'the conversation must end with QUIT')
  assert.ok(
    fake.commands.indexOf('QUIT') > fake.commands.findIndex((c) => c.startsWith('RCPT TO')),
    'QUIT must come after RCPT TO'
  )
  assert.doesNotMatch(issued, /\bDATA\b/, 'the probe must never issue DATA')
  assert.doesNotMatch(issued, /\bBDAT\b/)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'deliverable')
  assert.equal(result.host, 'mx.example.com', 'the lowest-priority MX is used')
})

test('assertNoBody refuses DATA and BDAT, and lets ordinary commands through', () => {
  assert.throws(() => assertNoBody('DATA'), /never transmit a message body/)
  assert.throws(() => assertNoBody('  data  '), /never transmit a message body/)
  assert.throws(() => assertNoBody('BDAT 42'), /never transmit a message body/)
  assert.equal(assertNoBody('RCPT TO:<a@b.com>'), 'RCPT TO:<a@b.com>')
})

test('QUIT is still sent when a command fails midway', async () => {
  const commands = []
  const session = {
    command(line) {
      commands.push(line ?? '<greeting>')
      if (String(line).startsWith('MAIL FROM')) return Promise.reject(new Error('boom'))
      return Promise.resolve('250 OK')
    },
    close: () => Promise.resolve(),
  }
  await assert.rejects(
    verifyEmail('real@example.com', {
      resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
      connect: async () => session,
      from: 'probe@send.bcn-services.com',
    }),
    /boom/
  )
  assert.equal(commands.at(-1), 'QUIT')
})

test('a rejected address is not ok, and an ambiguous one is unknown not ok', async () => {
  const run = (reply) =>
    verifyEmail('maybe@example.com', {
      resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
      connect: async () => fakeSession({ 'RCPT TO': reply }).session,
      from: 'probe@send.bcn-services.com',
    })

  assert.equal((await run('550 5.1.1 No such user')).status, 'rejected')
  assert.equal((await run('450 4.2.0 Greylisted')).status, 'unknown')
  assert.equal((await run('252 cannot verify')).status, 'unknown')
  for (const reply of ['550 x', '450 x', '252 x']) {
    assert.equal((await run(reply)).ok, false, `${reply} must never count as deliverable`)
  }
})

test('classify and helpers', () => {
  assert.equal(classify(250), 'deliverable')
  assert.equal(classify(251), 'deliverable')
  assert.equal(classify(252), 'unknown')
  assert.equal(classify(0), 'unknown')
  assert.equal(domainOf('a@b.com'), 'b.com')
  assert.equal(domainOf('a@sub.B.COM'), 'sub.b.com')
  assert.equal(domainOf('no-at-sign'), null)
  assert.equal(domainOf('trailing@'), null)
  assert.equal(replyCode('250-STARTTLS\n250 OK'), 250)
})

test('smtpSession reads a multiline reply as one reply', async () => {
  const socket = fakeSocket()
  const session = smtpSession(socket)
  const pending = session.command('EHLO localhost')
  socket.receive('250-mx.example.com\r\n250-STARTTLS\r\n250 SIZE 1000\r\n')
  const reply = await pending
  assert.equal(replyCode(reply), 250)
  assert.match(reply, /SIZE 1000/)
  assert.equal(socket.written.join(''), 'EHLO localhost\r\n')
})

test('a greeting that arrives before the first command is not lost', async () => {
  const socket = fakeSocket()
  const session = smtpSession(socket)
  // A real server sends 220 the moment the socket opens, before we ask.
  socket.receive('220 mx.example.com ESMTP\r\n')
  assert.equal(replyCode(await session.command()), 220)
})

test('two replies arriving in one chunk are read as two replies', async () => {
  const socket = fakeSocket()
  const session = smtpSession(socket)
  socket.receive('220 hello\r\n250 OK\r\n')
  assert.equal(replyCode(await session.command()), 220)
  assert.equal(replyCode(await session.command('NOOP')), 250)
})

test('smtpSession refuses to write DATA to the socket', () => {
  const socket = fakeSocket()
  const session = smtpSession(socket)
  assert.throws(() => session.command('DATA'), /never transmit a message body/)
  assert.equal(socket.written.length, 0, 'nothing may reach the socket')
})
