/**
 * A minimal fake SMTP server for REAL-transport mailer tests: the test hands lib/mailer.ts the server's 127.0.0.1 port and real nodemailer
 * dials it, so no nodemailer double is involved. It listens on loopback only (tests/no-outbound-network.cjs allows that) and never relays anything.
 *
 * It speaks just enough SMTP for one message: EHLO, MAIL FROM, RCPT TO, DATA (+ the dot-terminated body), QUIT, RSET, NOOP. Replies are always
 * sent in command order, which is what a PIPELINING server does too, so the same server serves a pipelining and a non-pipelining test.
 * Behaviour is chosen per server through FakeSmtpOptions; everything the client did is recorded on `events` and `sockets`.
 */
import net from 'node:net'

export type FakeSmtpCommandName = 'EHLO' | 'MAIL' | 'RCPT' | 'DATA' | 'BODY'

export interface FakeSmtpOptions {
  /** Advertise PIPELINING in the EHLO reply (nodemailer then sends MAIL FROM / RCPT TO / DATA without waiting). Default false. */
  pipelining?: boolean
  /** Replies per command, overriding the default; a function receives the command line. Default replies: 250 / 250 / 250 / 354 / 250. */
  replies?: Partial<Record<FakeSmtpCommandName, string | ((line: string) => string)>>
  /** Never answer this command (and everything after it): the connection stays open and silent. */
  stallOn?: FakeSmtpCommandName
  /** Destroy the socket instead of answering this command. For 'BODY': as soon as the first byte of the message body arrives. */
  dropOn?: FakeSmtpCommandName
  /** Delay every reply (greeting included) by this many ms, so each reply lands inside the client's socket timeout while the whole conversation outlasts a shorter deadline. */
  replyDelayMs?: number
  /** Text added to the EHLO / greeting banner (e.g. to try to confuse a client that sniffs it). */
  banner?: string
}

export interface FakeSmtpEvent { socket: number; kind: 'connect' | 'client' | 'server' | 'close' | 'drop' | 'body-start' | 'body-end'; line?: string }

export interface FakeSmtpServer {
  host: '127.0.0.1'
  port: number
  events: FakeSmtpEvent[]
  /** Client command lines received, in order (the message body is not included). */
  commands(): string[]
  connections(): number
  /** Resolves once every accepted socket has closed (or rejects on timeout). */
  allSocketsClosed(timeoutMs: number): Promise<void>
  /** Number of sockets still open right now. */
  openSockets(): number
  /** Destroys every open socket and stops listening. Always call it (try/finally or test.after). */
  close(): Promise<void>
}

export async function startFakeSmtpServer(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const events: FakeSmtpEvent[] = []
  const sockets = new Set<net.Socket>()
  let nextId = 0
  let connections = 0
  const waiters: Array<() => void> = []
  const notifyIfIdle = () => { if (sockets.size === 0) while (waiters.length) waiters.shift()!() }

  const server = net.createServer((socket) => {
    const id = ++nextId
    connections++
    sockets.add(socket)
    events.push({ socket: id, kind: 'connect' })
    socket.setNoDelay(true)
    socket.on('error', () => undefined)
    socket.on('close', () => { sockets.delete(socket); events.push({ socket: id, kind: 'close' }); notifyIfIdle() })

    let buffer = ''
    let inBody = false
    let bodyStarted = false
    let stalled = false
    let accepted = 0
    // Replies keep their order whatever the delay: each goes out a fixed time after it was queued, and timers fire in order.
    const send = (text: string) => { if (options.replyDelayMs) setTimeout(() => { if (!socket.destroyed) socket.write(text) }, options.replyDelayMs); else socket.write(text) }
    const reply = (name: FakeSmtpCommandName, line: string, fallback: string): boolean => {
      if (options.dropOn === name) { events.push({ socket: id, kind: 'drop', line: name }); socket.destroy(); return false }
      if (options.stallOn === name) { stalled = true; return false }
      const custom = options.replies?.[name]
      const text = typeof custom === 'function' ? custom(line) : custom ?? fallback
      events.push({ socket: id, kind: 'server', line: text })
      send(`${text}\r\n`)
      return true
    }

    events.push({ socket: id, kind: 'server', line: `220 fake.smtp.test ESMTP${options.banner ? ` ${options.banner}` : ''}` })
    send(`220 fake.smtp.test ESMTP${options.banner ? ` ${options.banner}` : ''}\r\n`)

    socket.on('data', (chunk) => {
      if (stalled) return
      buffer += chunk.toString('latin1')
      for (;;) {
        if (inBody) {
          if (!bodyStarted) {
            bodyStarted = true
            events.push({ socket: id, kind: 'body-start' })
            if (options.dropOn === 'BODY') { events.push({ socket: id, kind: 'drop', line: 'BODY' }); socket.destroy(); return }
          }
          const end = buffer.indexOf('\r\n.\r\n')
          if (end === -1) { buffer = buffer.slice(-4); return }
          buffer = buffer.slice(end + 5)
          inBody = false
          bodyStarted = false
          events.push({ socket: id, kind: 'body-end' })
          if (!reply('BODY', '', '250 2.0.0 Ok: queued')) return
          continue
        }
        const nl = buffer.indexOf('\r\n')
        if (nl === -1) return
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 2)
        events.push({ socket: id, kind: 'client', line })
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          const ok = reply('EHLO', line, `250-fake.smtp.test${options.banner ? ` ${options.banner}` : ''}\r\n250${options.pipelining ? '-PIPELINING\r\n250' : ''} 8BITMIME`)
          if (!ok) return
        } else if (upper.startsWith('MAIL FROM')) {
          if (!reply('MAIL', line, '250 2.1.0 Ok')) return
        } else if (upper.startsWith('RCPT TO')) {
          const text = typeof options.replies?.RCPT === 'function' ? options.replies.RCPT(line) : options.replies?.RCPT ?? '250 2.1.5 Ok'
          if (/^2/.test(text)) accepted++
          if (!reply('RCPT', line, text)) return
        } else if (upper === 'DATA') {
          // A server with no accepted recipient refuses DATA, as real ones do; an explicit replies.DATA still wins.
          const fallback = accepted > 0 ? '354 End data with <CR><LF>.<CR><LF>' : '554 5.5.1 Error: no valid recipients'
          const text = typeof options.replies?.DATA === 'function' ? options.replies.DATA(line) : options.replies?.DATA ?? fallback
          if (!reply('DATA', line, text)) return
          if (!/^[45]/.test(text)) inBody = true
        } else if (upper === 'QUIT') {
          events.push({ socket: id, kind: 'server', line: '221 Bye' })
          send('221 2.0.0 Bye\r\n')
          setTimeout(() => socket.end(), options.replyDelayMs ?? 0)
          return
        } else {
          events.push({ socket: id, kind: 'server', line: '250 Ok' })
          send('250 2.0.0 Ok\r\n')
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as net.AddressInfo

  return {
    host: '127.0.0.1',
    port: address.port,
    events,
    commands: () => events.filter((e) => e.kind === 'client').map((e) => e.line ?? ''),
    connections: () => connections,
    openSockets: () => sockets.size,
    allSocketsClosed: (timeoutMs) => new Promise<void>((resolve, reject) => {
      if (sockets.size === 0) return resolve()
      const timer = setTimeout(() => reject(new Error(`${sockets.size} fake SMTP socket(s) still open after ${timeoutMs} ms`)), timeoutMs)
      waiters.push(() => { clearTimeout(timer); resolve() })
    }),
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}
