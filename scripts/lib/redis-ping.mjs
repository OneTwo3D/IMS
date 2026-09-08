#!/usr/bin/env node
/**
 * IS THIS EXACT `REDIS_URL` A REDIS THAT ANSWERS US, RIGHT NOW? (o3d-g42a)
 *
 * THE FINDING. `scripts/install.sh` provisioned, secured and started a Redis and then never wrote
 * `RATE_LIMIT_BACKEND`, so `lib/security/rate-limit.ts` defaulted to `memory` on every
 * installer-built host. Fixing that means the installer has to DECIDE the backend — and the
 * decision is not symmetric. `memory` is a degradation (counters are per-process rather than
 * shared across replicas); `redis` pointed at a Redis that does not answer is a LOCKOUT, because
 * the sign-in buckets are checked with `failClosed: true` (lib/auth/config.ts:183,192) and a
 * backend that throws denies the request. Nobody signs in to the server that was just installed.
 *
 * So `redis` may only be written on POSITIVE evidence, and this program is that evidence: it is
 * given the byte-for-byte `REDIS_URL` that is about to be written into `.env`, connects to it, and
 * exits 0 if — and only if — the server on the other end answered `PING` with `PONG` after
 * whatever `AUTH`/`SELECT` the URL implies. Every other outcome, including every outcome it cannot
 * classify, exits 1, and the caller falls back to `memory`. A false negative costs an operator a
 * shared rate limiter they could have had; a false positive costs them the ability to log in.
 *
 * WHY IT IS A NODE PROGRAM AND NOT `redis-cli`. Three reasons, in order of weight:
 *
 *   1. `redis-cli` does not percent-decode the userinfo of a `-u` URL, and install.sh
 *      percent-encodes the password INTO the URL (o3d-tsc0). The two would disagree for exactly
 *      the passwords the encoder exists for, so a probe built on it would answer about a
 *      credential the application never sends.
 *   2. It need not be installed. The external-Redis operator (`INSTALL_REDIS=n`) has no reason to
 *      have redis-tools on the application host, and "the probe tool is missing" is not evidence
 *      about Redis.
 *   3. Node is installed by section 4 of the installer, which runs before the Redis section, and
 *      this file needs nothing from `node_modules` — which is not installed until section 11.
 *
 * WHY IT DOES NOT SPEAK FOR ITSELF ABOUT THE URL. The connection parameters are derived here the
 * way `redisConnectionOptions()` in `lib/security/rate-limit-redis.ts` derives them, because that
 * is the rule the APPLICATION uses and a probe that parsed the URL differently would be proving
 * something about a connection nobody makes. Two readers of one rule is the standing hazard, so
 * they are not left to agree by inspection: `tests/scripts/install-rate-limit-backend.test.ts`
 * runs BOTH against the same Redis-speaking socket and compares the `AUTH`/`SELECT` commands as
 * they arrive on the wire, for URLs carrying the awkward password the encoder tests use. A
 * divergence is a red test rather than a lockout.
 *
 * THE INPUT ARRIVES IN THE ENVIRONMENT, NOT IN `argv`. The URL carries the Redis password.
 * `/proc/<pid>/cmdline` is world-readable and `/proc/<pid>/environ` is not, so an argument would
 * publish the credential to every account on the box for the lifetime of the probe.
 *
 *   IMS_REDIS_PING_URL          the URL to probe. Required.
 *   IMS_REDIS_PING_PASSWORD     the `REDIS_PASSWORD` fallback, used only when the URL carries no
 *                               inline credential — the same precedence the application applies.
 *   IMS_REDIS_PING_TIMEOUT_MS   hard deadline for the whole exchange (default 5000).
 *
 * EXIT STATUS: 0 = answered PONG. 1 = did not, for any reason. 2 = usage error (no URL).
 */
import net from 'node:net'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 5000

/**
 * The application's own derivation, transcribed from `redisConnectionOptions()`.
 *
 * `decodeURIComponent` on username and password, the inline credential beating the fallback, and
 * the scheme deciding the default port are all that rule is. The one thing NOT transcribed is its
 * refusal when an inline password and a different `REDIS_PASSWORD` are both set: that is a
 * configuration error the application reports loudly at runtime, and this program's job is to
 * answer one question about the wire. It reaches the same connection in every case the
 * application would accept, which is the case the answer is about.
 */
export function probeConnectionOptions(redisUrl, fallbackPassword = '') {
  const url = new URL(redisUrl)
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://')
  }
  const inlinePassword = decodeURIComponent(url.password)
  return {
    tls: url.protocol === 'rediss:',
    host: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'rediss:' ? 6380 : 6379),
    username: decodeURIComponent(url.username),
    password: inlinePassword || fallbackPassword,
    db: url.pathname.length > 1 ? url.pathname.slice(1) : '',
  }
}

/** The commands the application would send before its first real command, in the same order. */
export function probeSetupCommands(options) {
  const commands = []
  if (options.password) {
    commands.push(options.username
      ? ['AUTH', options.username, options.password]
      : ['AUTH', options.password])
  }
  if (options.db) commands.push(['SELECT', options.db])
  return commands
}

function encodeCommand(parts) {
  return Buffer.from(`*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`)
}

/**
 * Enough of RESP to read the replies to AUTH, SELECT and PING, and no more.
 *
 * Returns null while the buffer holds an incomplete value, so the caller can wait for more bytes.
 * An error reply (`-`) throws: a `NOAUTH`, a `WRONGPASS` or an `ERR Client sent AUTH...` is
 * precisely the answer this program must report as "no".
 */
function parseValue(buffer, offset) {
  if (offset >= buffer.length) return null
  const type = String.fromCharCode(buffer[offset])
  const lineEnd = buffer.indexOf('\r\n', offset + 1, 'utf8')
  if (lineEnd === -1) return null
  const line = buffer.toString('utf8', offset + 1, lineEnd)
  const payloadOffset = lineEnd + 2
  if (type === '+') return { value: line, nextOffset: payloadOffset }
  if (type === ':') return { value: Number(line), nextOffset: payloadOffset }
  if (type === '-') throw new Error(`Redis error: ${line}`)
  if (type === '$') {
    const length = Number(line)
    if (length === -1) return { value: null, nextOffset: payloadOffset }
    const end = payloadOffset + length
    if (buffer.length < end + 2) return null
    return { value: buffer.toString('utf8', payloadOffset, end), nextOffset: end + 2 }
  }
  throw new Error(`unsupported Redis response type "${type}"`)
}

/**
 * Connect, run the setup commands and PING, and resolve with the PING reply.
 *
 * Everything is bounded by one deadline, including the connect: a SYN to an address nothing
 * answers on hangs for minutes by default, and an installer that appears to have hung is worse
 * than one that says it could not reach Redis.
 */
export function pingRedis(redisUrl, fallbackPassword = '', timeoutMs = DEFAULT_TIMEOUT_MS) {
  const options = probeConnectionOptions(redisUrl, fallbackPassword)
  const commands = [...probeSetupCommands(options), ['PING']]

  return new Promise((resolve, reject) => {
    let settled = false
    let socket = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (socket) socket.destroy() } catch { /* already gone */ }
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs)

    socket = options.tls
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.connect({ host: options.host, port: options.port })

    let buffer = Buffer.alloc(0)
    const replies = []
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('the connection closed before PING was answered')))
    socket.on(options.tls ? 'secureConnect' : 'connect', () => {
      socket.write(Buffer.concat(commands.map(encodeCommand)))
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        for (;;) {
          const parsed = parseValue(buffer, 0)
          if (!parsed) break
          buffer = buffer.subarray(parsed.nextOffset)
          replies.push(parsed.value)
          if (replies.length === commands.length) {
            finish(null, replies[replies.length - 1])
            return
          }
        }
      } catch (error) {
        finish(error)
      }
    })
  })
}

async function main() {
  const url = process.env.IMS_REDIS_PING_URL ?? ''
  if (url === '') {
    process.stderr.write('redis-ping: IMS_REDIS_PING_URL is empty; nothing to probe.\n')
    process.exit(2)
  }
  const timeoutMs = Number(process.env.IMS_REDIS_PING_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  try {
    const reply = await pingRedis(
      url,
      process.env.IMS_REDIS_PING_PASSWORD ?? '',
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    )
    if (typeof reply === 'string' && reply.toUpperCase() === 'PONG') process.exit(0)
    process.stderr.write(`redis-ping: PING was answered with ${JSON.stringify(reply)}, not PONG.\n`)
    process.exit(1)
  } catch (error) {
    // The URL is NOT echoed: it carries the credential, and this text reaches the installer's
    // transcript and whatever the operator pastes into a bug report.
    process.stderr.write(`redis-ping: ${String(error && error.message ? error.message : error).replace(/\s+/g, ' ')}\n`)
    process.exit(1)
  }
}

// Importable by the regressions, executable by the installer: the entrypoint runs only when this
// file IS the program, so `import` does not probe anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
