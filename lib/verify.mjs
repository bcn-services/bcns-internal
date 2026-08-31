// Address verification: does this mailbox actually exist, before we ever mail it?
//
// Two steps, cheapest first. A domain with no MX record can receive no mail at
// all, so it is rejected without opening a socket. Only a domain that survives
// that gets an SMTP conversation, and that conversation stops at `RCPT TO`.
//
// The probe never sends a message. `DATA` is the command that begins a body,
// and `assertNoBody` makes issuing it impossible rather than merely unlikely —
// a probe that delivered mail would be indistinguishable from spam to the
// receiving server, and would burn the sending domain we are protecting.

// Commands that begin transmitting a message. BDAT is the CHUNKING equivalent
// of DATA; both are forbidden on a probe.
const BODY_COMMANDS = /^\s*(DATA|BDAT)\b/i

export function assertNoBody(line) {
  if (BODY_COMMANDS.test(line)) {
    throw new Error(
      'the verification probe must never transmit a message body — ' +
        `refused to send ${JSON.stringify(String(line).trim())}`
    )
  }
  return line
}

export function domainOf(address) {
  const at = String(address ?? '').lastIndexOf('@')
  if (at < 1 || at === address.length - 1) return null
  return address.slice(at + 1).toLowerCase()
}

export function replyCode(reply) {
  const match = /^(\d{3})/.exec(String(reply ?? '').trim())
  return match ? Number(match[1]) : 0
}

// What a reply to RCPT TO means. Anything not clearly a yes or a clearly
// permanent no is `unknown` — greylisting, rate limits and catch-all servers
// all land here, and an unknown is never treated as a yes.
export function classify(code) {
  if (code >= 250 && code < 260 && code !== 252) return 'deliverable'
  if (code === 550 || code === 551 || code === 553 || code === 554) return 'rejected'
  return 'unknown'
}

// resolveMx and connect are injected. connect(host) resolves to a session:
//   { command(line): Promise<string>, close(): Promise<void> }
// Calling command with no line reads the server greeting.
export async function verifyEmail(address, { resolveMx, connect, from, heloHost = 'localhost' }) {
  const domain = domainOf(address)
  if (!domain) return { ok: false, status: 'invalid', address }

  let records = []
  try {
    records = (await resolveMx(domain)) ?? []
  } catch {
    records = []
  }
  if (!records.length) {
    // No socket is opened. Nothing can receive mail here.
    return { ok: false, status: 'no-mx', address, domain }
  }

  const host = [...records].sort((a, b) => a.priority - b.priority)[0].exchange
  const session = await connect(host)
  let code = 0
  try {
    await session.command()
    await session.command(send(`EHLO ${heloHost}`))
    await session.command(send(`MAIL FROM:<${from}>`))
    code = replyCode(await session.command(send(`RCPT TO:<${address}>`)))
  } finally {
    // QUIT always, even when a command above threw — an abandoned socket is
    // rude to the receiving server and looks exactly like a scanner.
    try {
      await session.command(send('QUIT'))
    } finally {
      await session.close()
    }
  }

  const status = classify(code)
  return { ok: status === 'deliverable', status, code, address, domain, host }
}

function send(line) {
  return assertNoBody(line)
}

// The real session, over an already-connected duplex stream. Taking a stream
// rather than a host keeps the SMTP reply parsing testable without a network:
// the multiline reply is where this goes wrong, not the socket.
//
// SMTP replies are one or more lines; every line but the last has a hyphen
// after the code ("250-STARTTLS"), and the final line has a space ("250 OK").
export function smtpSession(socket, { timeoutMs = 10000 } = {}) {
  let buffer = ''
  const ready = []   // complete replies the server has already sent
  let waiting = null
  let failure = null

  const deliver = () => {
    if (!waiting) return
    if (failure) {
      const w = waiting
      waiting = null
      w.reject(failure)
    } else if (ready.length) {
      const w = waiting
      waiting = null
      w.resolve(ready.shift())
    }
  }

  const fail = (err) => {
    failure ??= err
    deliver()
  }

  socket.setEncoding?.('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    // A complete reply ends with a line whose code is followed by a space;
    // continuation lines use a hyphen ("250-STARTTLS" then "250 OK").
    for (;;) {
      const lines = buffer.split(/\r?\n/)
      const end = lines.findIndex((l) => /^\d{3} /.test(l))
      if (end === -1) break
      ready.push(lines.slice(0, end + 1).join('\n'))
      buffer = lines.slice(end + 1).join('\n')
    }
    deliver()
  })
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('smtp connection closed early')))

  return {
    command(line) {
      if (line !== undefined) assertNoBody(line)
      if (line !== undefined) socket.write(`${line}\r\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('smtp timeout')), timeoutMs)
        waiting = {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        }
        // The server may have replied before we asked; deliver that first.
        deliver()
      })
    },
    close() {
      socket.destroy?.()
      return Promise.resolve()
    },
  }
}
