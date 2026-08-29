#!/usr/bin/env node
/**
 * WHICH pg_hba RULE THE SERVER MATCHED, ASKED OF THE SERVER (o3d-2sm1.5 r41, Codex HIGH).
 *
 * THE FINDING. install.sh admitted an endpoint as evidence about the application role's password
 * once it had watched that endpoint refuse a random password and accept an asserted one. That
 * proves the endpoint discriminates BETWEEN PASSWORDS. It does not prove the password it
 * discriminates on is PostgreSQL's own role credential -- the only thing `ALTER ROLE ... PASSWORD`
 * changes. `pg_hba.conf` has password-dependent methods that consult somebody else's store:
 * `ldap`, `pam`, `radius`, `bsd`. Under any of them both halves of that control behave exactly as
 * expected while the answer is about a directory, and an interrupted rotation reconciled from it
 * can publish a credential the role does not have.
 *
 * WHAT THIS PROGRAM ESTABLISHES. The PostgreSQL v3 startup exchange begins with the server
 * choosing a pg_hba record -- ITS OWN MATCH, performed by its own matcher against its own file --
 * and announcing the consequence as an Authentication request message. That message is a
 * different value for the methods that check `pg_authid.rolpassword` than for the ones that do
 * not, and the mapping is exact rather than statistical:
 *
 *   AuthenticationSASL (10) offering SCRAM-SHA-256 or SCRAM-SHA-256-PLUS
 *       `scram-sha-256` -- or `md5` over a role whose stored verifier is SCRAM, which PostgreSQL
 *       upgrades to SCRAM automatically. Either way the secret compared is the role's own.
 *   AuthenticationMD5Password (5)
 *       `md5` over an MD5-format stored verifier. The secret compared is the role's own.
 *   AuthenticationCleartextPassword (3)
 *       `password`, `ldap`, `pam`, `radius` or `bsd`. THESE ARE INDISTINGUISHABLE ON THE WIRE and
 *       they must be: an external verifier can only be consulted with the plaintext, so the
 *       server asks for the plaintext. `password` does check the role's own secret -- but nothing
 *       in the protocol separates it from the four that do not, so this program reports the
 *       ambiguity rather than resolving it, and the caller refuses.
 *   AuthenticationOk (0)
 *       the server asked for nothing: `trust`, or a rule already satisfied by the transport
 *       (`peer`, `ident`, `cert`). No password of any kind is being checked.
 *   AuthenticationGSS (7) / AuthenticationSSPI (9) / any other code
 *       an external identity system. Not the role's own secret.
 *
 * SO THE EXIT STATUS IS THE VERDICT: 0 when -- and only when -- the server itself asked for a
 * secret it will compare against `pg_authid.rolpassword` for this role, on this database, from
 * this address, over this transport. 1 for every other answer, including every answer this
 * program cannot classify. 2 for a usage error.
 *
 * WHAT IT DOES NOT ESTABLISH, said here because the caller's refusal text quotes it:
 *
 *   * It is not an authentication. NO PASSWORD IS EVER SENT -- the connection is dropped the
 *     instant the request message has been read. It therefore says nothing about whether any
 *     particular credential is live, nor whether the role holds CONNECT on the database. The
 *     caller still has to ask that separately, and does.
 *   * It cannot admit `password` (cleartext compared against the role's own secret), because the
 *     wire cannot tell it from `ldap`. That is a deliberate narrowing, and it costs a site running
 *     cleartext-against-PostgreSQL a refusal it did not strictly have to have.
 *   * It is a SEPARATE CONNECTION from the one the caller then opens with psql. It states the
 *     same user, database, host, port and SSL preference, so the same record matches -- unless
 *     pg_hba.conf is reloaded between the two. The caller's negative control is what would catch
 *     that, and is the reason that control is kept.
 *
 * WHY IT SPEAKS THE PROTOCOL RATHER THAN READING A CATALOGUE. `pg_hba_file_rules` (PostgreSQL 10
 * and later) lists the PARSED RULES. A rule listing is not a match: deciding which record applies
 * means reproducing the server's own matching -- address families, CIDR arithmetic, `all` and
 * `replication` and `+group` and `@file` expansion, first-match-wins ordering, `hostssl` versus
 * `hostnossl` against the transport actually negotiated. That re-implementation IS the modelling
 * error this file exists to remove, so it is not done.
 *
 * THE OTHER TWO ROUTES WERE MEASURED BEFORE THIS ONE WAS CHOSEN, and neither is available across
 * the versions this installer meets -- it takes whatever PostgreSQL the distribution ships: 14 on
 * Ubuntu 22.04, 15 on Debian 12, 16 on Ubuntu 24.04, 17 on Debian 13.
 *
 *   * NO CATALOGUE REPORTS THE MATCHED METHOD OF A LIVE BACKEND. `pg_stat_activity` carries no
 *     such column -- verified against 17, which is the newest of the four. The server LOG has
 *     carried `connection authenticated: identity=... method=...` since PostgreSQL 14, but that is
 *     a log line, written after the fact, addressed to journald or syslog rather than to the
 *     client, and not readable by an installer that has not been told where the log went.
 *   * libpq's `require_auth` would be the ideal instrument -- it binds the requirement to the very
 *     connection that then authenticates, closing the one gap left below. It is a CLIENT feature
 *     and it arrived in libpq 16, so on Ubuntu 22.04 and Debian 12 it is not an option that
 *     behaves differently, it is a connection parameter that does not exist. Making it the
 *     mechanism would mean refusing on half the supported estate, or shipping two mechanisms of
 *     which only the newer one is ever exercised by a test run on a modern box.
 *
 * The startup message is the one answer every supported version gives, in the same bytes, and has
 * given since protocol 3.0.
 *
 * SSL. libpq's default `sslmode` is `prefer`, which is what every psql this installer runs uses,
 * and Debian's packaged cluster ships `ssl = on`. So the negotiation here is `prefer`'s, exactly:
 * SSLRequest first, upgrade if the server answers `S`, continue in the clear if it answers `N`,
 * and verify nothing -- `prefer` verifies nothing. Getting this wrong would not produce a wrong
 * answer, it would produce a `hostssl` record matched in one connection and a `hostnossl` record
 * in the other, which is the one thing this must not do.
 *
 * Unix-domain sockets take no SSLRequest, for the same reason libpq sends none.
 */
import { Buffer } from 'node:buffer'
import net from 'node:net'
import process from 'node:process'
import tls from 'node:tls'

const PROTOCOL_VERSION_3_0 = 196608
const SSL_REQUEST_CODE = 80877103
const DEFAULT_TIMEOUT_MS = 10_000
/** The startup message's parameter list is NUL-separated and NUL-terminated. */
const NUL = '\u0000'

function die(message, status) {
  process.stdout.write(`method=unknown\nverifier=unknown\ndetail=${message}\n`)
  process.exit(status)
}

function int32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32BE(value, 0)
  return buffer
}

function startupMessage(user, database) {
  const payload = Buffer.concat([
    int32(PROTOCOL_VERSION_3_0),
    Buffer.from(`user${NUL}${user}${NUL}database${NUL}${database}${NUL}${NUL}`, 'utf8'),
  ])
  return Buffer.concat([int32(payload.length + 4), payload])
}

function sslRequest() {
  return Buffer.concat([int32(8), int32(SSL_REQUEST_CODE)])
}

/** NUL-separated strings, terminated by an empty one -- the SASL mechanism list's shape. */
function nulStrings(payload) {
  const names = []
  let start = 0
  while (start < payload.length) {
    const end = payload.indexOf(0, start)
    if (end === -1) break
    const name = payload.subarray(start, end).toString('utf8')
    if (name.length === 0) break
    names.push(name)
    start = end + 1
  }
  return names
}

/** The ErrorResponse field list: a type byte, a NUL-terminated value, repeated, then a NUL. */
function errorFields(payload) {
  const fields = new Map()
  let start = 0
  while (start < payload.length && payload[start] !== 0) {
    const type = String.fromCharCode(payload[start])
    const end = payload.indexOf(0, start + 1)
    if (end === -1) break
    fields.set(type, payload.subarray(start + 1, end).toString('utf8'))
    start = end + 1
  }
  return fields
}

/**
 * A reader that owns the stream's `data` events, so that the TLS upgrade can be handed a socket
 * with nothing buffered behind it. Everything it is asked for is read against an explicit
 * deadline: a server that accepts the connection and then says nothing must not hang an installer.
 */
class Reader {
  constructor() {
    this.chunks = Buffer.alloc(0)
    this.failure = null
    this.finished = false
    this.wake = null
    this.stream = null
    this.onData = (chunk) => { this.chunks = Buffer.concat([this.chunks, chunk]); this.pump() }
    this.onError = (error) => { this.failure = error; this.pump() }
    this.onClose = () => { this.finished = true; this.pump() }
  }

  attach(stream) {
    this.detach()
    this.stream = stream
    stream.on('data', this.onData)
    stream.on('error', this.onError)
    stream.on('end', this.onClose)
    stream.on('close', this.onClose)
  }

  detach() {
    if (this.stream === null) return
    this.stream.removeListener('data', this.onData)
    this.stream.removeListener('error', this.onError)
    this.stream.removeListener('end', this.onClose)
    this.stream.removeListener('close', this.onClose)
    this.stream = null
  }

  pump() {
    const wake = this.wake
    this.wake = null
    if (wake !== null) wake()
  }

  buffered() {
    return this.chunks.length
  }

  async read(length, deadline) {
    while (this.chunks.length < length) {
      if (this.failure !== null) throw this.failure
      if (this.finished) throw new Error('the server closed the connection before it said anything')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('the server did not answer in time')
      await new Promise((resolve) => {
        this.wake = resolve
        const timer = setTimeout(resolve, Math.min(remaining, 50))
        if (typeof timer.unref === 'function') timer.unref()
      })
    }
    const head = this.chunks.subarray(0, length)
    this.chunks = this.chunks.subarray(length)
    return head
  }

  /** One protocol message: a type byte, an int32 length that counts itself, and the body. */
  async message(deadline) {
    const type = String.fromCharCode((await this.read(1, deadline))[0])
    const length = (await this.read(4, deadline)).readInt32BE(0)
    if (length < 4 || length > 1_000_000) throw new Error(`the server sent a message of implausible length ${length}`)
    return { type, payload: await this.read(length - 4, deadline) }
  }
}

function connect(host, port, deadline) {
  return new Promise((resolve, reject) => {
    const socket = host.startsWith('/')
      ? net.connect({ path: `${host.replace(/\/+$/, '')}/.s.PGSQL.${port}` })
      : net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the connection was not accepted in time'))
    }, Math.max(1, deadline - Date.now()))
    if (typeof timer.unref === 'function') timer.unref()
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

function upgrade(socket, host, deadline) {
  return new Promise((resolve, reject) => {
    // `prefer` VERIFIES NOTHING, so neither does this. Anything stricter would refuse the
    // self-signed certificate a Debian cluster ships and that the psql beside it accepts, and the
    // two connections would then be matched by different pg_hba records.
    const secured = tls.connect({
      socket,
      rejectUnauthorized: false,
      servername: net.isIP(host) === 0 ? host : undefined,
    })
    const timer = setTimeout(() => {
      secured.destroy()
      reject(new Error('the TLS handshake did not complete in time'))
    }, Math.max(1, deadline - Date.now()))
    if (typeof timer.unref === 'function') timer.unref()
    secured.once('secureConnect', () => { clearTimeout(timer); resolve(secured) })
    secured.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

function classify(type, payload) {
  if (type === 'E') {
    const fields = errorFields(payload)
    return {
      method: 'none',
      verifier: 'unknown',
      detail: `the server refused the connection before it asked for anything (SQLSTATE ${fields.get('C') ?? 'unknown'}: ${(fields.get('M') ?? 'no message').replace(/\s+/g, ' ')}), so there is no matched pg_hba method here to read`,
    }
  }
  if (type !== 'R') {
    return {
      method: 'unknown',
      verifier: 'unknown',
      detail: `the server answered the startup message with a '${type}' message, which is not an authentication request`,
    }
  }
  const code = payload.readInt32BE(0)
  if (code === 0) {
    return {
      method: 'trust',
      verifier: 'none',
      detail: 'the server asked for NO password at all (AuthenticationOk), which is what a `trust` rule does -- or a `peer`, `ident` or `cert` rule already satisfied by the transport. No password of any kind is being checked here',
    }
  }
  if (code === 3) {
    return {
      method: 'password-or-external',
      verifier: 'unknown',
      detail: 'the server asked for a CLEARTEXT password (AuthenticationCleartextPassword). That is what `password`, `ldap`, `pam`, `radius` and `bsd` all ask for, and the protocol does not separate them: an external verifier has to be handed the plaintext, so it must ask for the plaintext. ALTER ROLE changes the secret only the FIRST of those five consults, so an answer from this endpoint may be a directory answering about a different credential entirely',
    }
  }
  if (code === 5) {
    return {
      method: 'md5',
      verifier: 'role',
      detail: 'the server asked for an MD5 response (AuthenticationMD5Password), which only a `md5` rule over an MD5-format verifier asks for, and which it checks against pg_authid.rolpassword -- the secret ALTER ROLE writes',
    }
  }
  if (code === 10) {
    const mechanisms = nulStrings(payload.subarray(4))
    if (mechanisms.some((name) => name === 'SCRAM-SHA-256' || name === 'SCRAM-SHA-256-PLUS')) {
      return {
        method: 'scram-sha-256',
        verifier: 'role',
        detail: `the server offered SASL mechanisms ${mechanisms.join(', ')} (AuthenticationSASL), which only a \`scram-sha-256\` rule asks for -- or a \`md5\` rule over a SCRAM-format verifier, which PostgreSQL upgrades to SCRAM -- and which it checks against pg_authid.rolpassword: the secret ALTER ROLE writes`,
      }
    }
    return {
      method: `sasl:${mechanisms.join(',') || 'none'}`,
      verifier: 'unknown',
      detail: `the server offered SASL mechanisms ${mechanisms.join(', ') || '(none)'}, none of them SCRAM-SHA-256, so what it intends to compare the answer against is not something this can name`,
    }
  }
  if (code === 7 || code === 8) {
    return {
      method: 'gss',
      verifier: 'external',
      detail: 'the server asked for GSSAPI (AuthenticationGSS), which authenticates against a Kerberos realm and not against this role\'s password',
    }
  }
  if (code === 9) {
    return {
      method: 'sspi',
      verifier: 'external',
      detail: 'the server asked for SSPI (AuthenticationSSPI), which authenticates against a Windows domain and not against this role\'s password',
    }
  }
  return {
    method: `authentication-request-${code}`,
    verifier: 'unknown',
    detail: `the server sent authentication request ${code}, which this does not recognise; an unrecognised request is not evidence about a password`,
  }
}

function report(transport, ssl, verdict) {
  process.stdout.write(`transport=${transport}\nssl=${ssl}\nmethod=${verdict.method}\nverifier=${verdict.verifier}\ndetail=${verdict.detail}\n`)
}

async function main() {
  const options = new Map()
  for (const argument of process.argv.slice(2)) {
    const match = /^--([a-z][a-z0-9-]*)=([\s\S]*)$/.exec(argument)
    if (match === null) die(`unrecognised argument ${JSON.stringify(argument)}; expected --host= --port= --user= --database= [--timeout-ms=]`, 2)
    options.set(match[1], match[2])
  }
  for (const required of ['host', 'port', 'user', 'database']) {
    if (!options.has(required) || options.get(required).length === 0) die(`--${required}= is required`, 2)
  }
  const host = options.get('host')
  const port = Number(options.get('port'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(`--port= must be a TCP port number, not ${JSON.stringify(options.get('port'))}`, 2)
  const timeoutMs = options.has('timeout-ms') ? Number(options.get('timeout-ms')) : DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die('--timeout-ms= must be a positive number of milliseconds', 2)

  const deadline = Date.now() + timeoutMs
  const reader = new Reader()
  const transport = host.startsWith('/') ? 'unix' : 'tcp'
  let ssl = 'n/a'
  let socket = null
  let stream = null
  try {
    socket = await connect(host, port, deadline)
    stream = socket
    reader.attach(socket)
    if (transport === 'tcp') {
      socket.write(sslRequest())
      const reply = String.fromCharCode((await reader.read(1, deadline))[0])
      if (reply === 'S') {
        // NOTHING MAY BE BUFFERED BEHIND THE UPGRADE. A server that answered `S` cannot legally
        // have sent more before our ClientHello, and a stream that has is not one whose TLS
        // records begin where node:tls will look for them.
        if (reader.buffered() > 0) throw new Error('the server sent data after S and before the TLS handshake')
        reader.detach()
        stream = await upgrade(socket, host, deadline)
        reader.attach(stream)
        ssl = 'yes'
      } else if (reply === 'N') {
        ssl = 'no'
      } else if (reply === 'E') {
        // A pre-negotiation ErrorResponse -- the rest of it is still on the wire, minus the type
        // byte already consumed.
        const length = (await reader.read(4, deadline)).readInt32BE(0)
        const payload = await reader.read(Math.max(0, length - 4), deadline)
        report(transport, 'refused', classify('E', payload))
        process.exit(1)
      } else {
        throw new Error(`the server answered the SSL request with ${JSON.stringify(reply)}, which is neither S nor N`)
      }
    }

    stream.write(startupMessage(options.get('user'), options.get('database')))
    let message = await reader.message(deadline)
    // A NoticeResponse may precede anything, and means nothing here.
    while (message.type === 'N') message = await reader.message(deadline)
    const verdict = classify(message.type, message.payload)
    report(transport, ssl, verdict)
    process.exit(verdict.verifier === 'role' ? 0 : 1)
  } catch (error) {
    report(transport, ssl, {
      method: 'unknown',
      verifier: 'unknown',
      detail: String(error && error.message ? error.message : error).replace(/\s+/g, ' '),
    })
    process.exit(1)
  } finally {
    reader.detach()
    // THE CONNECTION IS DROPPED WITHOUT ANSWERING. Whatever the server asked for, it is not
    // getting it: this program exists to read the question, and handing a password to an endpoint
    // it has just discovered might be a directory is the leak the question was asked to prevent.
    try { if (stream !== null) stream.destroy() } catch { /* already gone */ }
    try { if (socket !== null) socket.destroy() } catch { /* already gone */ }
  }
}

await main()
