import assert from 'node:assert/strict'
import net from 'node:net'

import { RedisRateLimitBackend } from '@/lib/security/rate-limit-redis'

/**
 * Shared rig for the two shell scripts that build a `REDIS_URL` (o3d-tsc0).
 *
 * WHY THE ASSERTIONS GO OUT OVER A SOCKET. A percent-encoder is trivially self-consistent — encode with
 * one function, decode with its inverse, and any encoding passes. So neither script's test asserts
 * against a pattern or against a second copy of the encoder: the shell block from the SHIPPED script is
 * executed, and the URL it produces is handed to the production `RedisRateLimitBackend`, which connects
 * to the Redis-speaking socket below. What is asserted is the argument of the `AUTH` command as it
 * arrives on the wire. Nothing here knows how the password was encoded on the way.
 *
 * `scripts/install.sh` and `scripts/provision-ims-tenant.sh` share no shell library and carry two
 * copies of the encoder on purpose, so they deliberately share this rig instead: an encoder that only
 * agrees with itself is the defect, and the only way to catch a divergence is to measure both against
 * the same third party — the wire.
 */

// A password made of every character that has ever broken one of these encoders:
// URL delimiters, a percent, a quote, a backslash, whitespace, and a multi-byte
// character so the encoder is proven to walk BYTES rather than codepoints.
export const AWKWARD_PASSWORD = 'p@ss:w/o?r#d %25&+=" \\tail ä'

/**
 * Cut a function out of a script by its opening line and the first closing brace, so SHIPPED text runs.
 */
export function sliceBlock(source: string, startsWith: string): string {
  const block = sliceOptionalBlock(source, startsWith)
  assert.notEqual(block, null, `could not find a line starting with ${JSON.stringify(startsWith)}`)
  return block as string
}

/**
 * The same cut, but absence is an answer rather than a failure.
 *
 * Used for helpers a script may not have yet, so that reverting the change under test runs the OLD
 * block and fails on what it PRODUCES, rather than failing because a marker went missing — a test that
 * only proves a marker moved proves nothing.
 */
export function sliceOptionalBlock(source: string, startsWith: string): string | null {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(startsWith))
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index >= start && line === '}')
  if (end === -1) return null
  return lines.slice(start, end + 1).join('\n')
}

/** Cut an inclusive/exclusive range of shipped script lines by two markers that outlive the change. */
export function sliceRange(source: string, startsWith: string, endStartsWith: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(startsWith))
  assert.notEqual(start, -1, `could not find the start marker ${JSON.stringify(startsWith)}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith(endStartsWith))
  assert.notEqual(end, -1, `could not find the end marker ${JSON.stringify(endStartsWith)}`)
  return lines.slice(start, end).join('\n')
}

// ---------------------------------------------------------------------------
// The SERVER side of the same credential: redis.conf as redis itself reads it.
// ---------------------------------------------------------------------------

/**
 * A port of redis's own `sdssplitargs()` (sds.c), which is what parses every line of
 * `redis.conf` before `requirepass` ever sees an argument.
 *
 * This is here so the config assertion has the same property the wire assertion has: it is NOT the
 * inverse of the encoder under test. `scripts/install.sh` renders the password as a `\xHH` string
 * literal; nothing below knows that. It implements the server's algorithm — whitespace splits a token,
 * a `"` or `'` ANYWHERE in an unquoted token opens a quoted section, `\xHH` and `\n`/`\r`/`\t`/`\b`/`\a`
 * are honoured only inside double quotes, and a closing quote must be followed by whitespace — so a
 * password written in a form that only agrees with our own writer decodes to the wrong bytes here, and
 * a password written raw (the pre-fix behaviour) is split, truncated or rejected exactly as redis would.
 *
 * Bytes in, bytes out: the argument is a Buffer so a multi-byte password is compared as the byte
 * sequence the server was configured with, not as a codepoint sequence.
 */
export function redisConfSplitArgs(line: Buffer): Buffer[] {
  const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c
  const isHex = (b: number) =>
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
  const hexValue = (b: number) => (b <= 0x39 ? b - 0x30 : (b & 0xdf) - 0x41 + 10)
  const escapes: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x61: 0x07 }

  const tokens: Buffer[] = []
  let p = 0
  for (;;) {
    while (p < line.length && isSpace(line[p])) p += 1
    if (p >= line.length) return tokens

    const current: number[] = []
    let inDouble = false
    let inSingle = false
    let done = false
    while (!done) {
      const c = p < line.length ? line[p] : -1
      if (inDouble) {
        if (c === 0x5c && p + 3 < line.length && line[p + 1] === 0x78 && isHex(line[p + 2]) && isHex(line[p + 3])) {
          current.push(hexValue(line[p + 2]) * 16 + hexValue(line[p + 3]))
          p += 3
        } else if (c === 0x5c && p + 1 < line.length) {
          p += 1
          current.push(escapes[line[p]] ?? line[p])
        } else if (c === 0x22) {
          if (p + 1 < line.length && !isSpace(line[p + 1])) throw new Error('redis.conf: closing quote must be followed by whitespace')
          done = true
        } else if (c === -1) {
          throw new Error('redis.conf: unterminated double quote')
        } else {
          current.push(c)
        }
      } else if (inSingle) {
        if (c === 0x5c && p + 1 < line.length && line[p + 1] === 0x27) {
          p += 1
          current.push(0x27)
        } else if (c === 0x27) {
          if (p + 1 < line.length && !isSpace(line[p + 1])) throw new Error("redis.conf: closing quote must be followed by whitespace")
          done = true
        } else if (c === -1) {
          throw new Error('redis.conf: unterminated single quote')
        } else {
          current.push(c)
        }
      } else if (c === -1 || isSpace(c)) {
        done = true
      } else if (c === 0x22) {
        inDouble = true
      } else if (c === 0x27) {
        inSingle = true
      } else {
        current.push(c)
      }
      if (p < line.length) p += 1
    }
    tokens.push(Buffer.from(current))
  }
}

/**
 * The password a redis started with this config file would require, as raw bytes — or `null` if the
 * file carries no active `requirepass`. Commented lines are skipped the way redis skips them.
 *
 * Throws when redis itself would refuse the line, which is the honest outcome for a config written by
 * shell interpolation: `requirepass my pass` really is a startup error, not a password of "my".
 */
export function requirepassBytesFrom(conf: string): Buffer | null {
  const lines = conf.split('\n')
  let found: Buffer | null = null
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const args = redisConfSplitArgs(Buffer.from(line, 'binary'))
    if (args.length === 0 || args[0].toString('binary') !== 'requirepass') continue
    if (args.length !== 2) {
      throw new Error(`redis.conf: requirepass takes exactly one argument, got ${args.length - 1}`)
    }
    found = args[1]   // last one wins, as it does in redis
  }
  return found
}

// ---------------------------------------------------------------------------
// A Redis-speaking socket. It parses RESP arrays the way the server does and
// reports the commands verbatim, so the assertion is on wire bytes.
// ---------------------------------------------------------------------------

function parseCommands(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = []
  let offset = 0
  for (;;) {
    if (offset >= buffer.length || buffer[offset] !== 0x2a) break
    const headEnd = buffer.indexOf('\r\n', offset)
    if (headEnd === -1) break
    const count = Number(buffer.toString('utf8', offset + 1, headEnd))
    let cursor = headEnd + 2
    const parts: string[] = []
    let complete = true
    for (let index = 0; index < count; index += 1) {
      if (buffer[cursor] !== 0x24) { complete = false; break }
      const lengthEnd = buffer.indexOf('\r\n', cursor)
      if (lengthEnd === -1) { complete = false; break }
      const length = Number(buffer.toString('utf8', cursor + 1, lengthEnd))
      const start = lengthEnd + 2
      if (buffer.length < start + length + 2) { complete = false; break }
      parts.push(buffer.toString('utf8', start, start + length))
      cursor = start + length + 2
    }
    if (!complete) break
    commands.push(parts)
    offset = cursor
  }
  return { commands, rest: buffer.subarray(offset) }
}

type FakeRedis = {
  port: number
  received: Promise<string[][]>
  close(): Promise<void>
}

async function startFakeRedis(): Promise<FakeRedis> {
  const seen: string[][] = []
  let resolveReceived: (value: string[][]) => void = () => undefined
  const received = new Promise<string[][]>((resolve) => { resolveReceived = resolve })

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const { commands, rest } = parseCommands(buffer)
      buffer = Buffer.from(rest)
      for (const command of commands) {
        seen.push(command)
        if (command[0]?.toUpperCase() === 'EVAL') {
          // {allowed, count, retryAfterMs} — one allowed request.
          socket.write('*3\r\n:1\r\n:1\r\n:0\r\n')
          resolveReceived(seen)
          socket.end()
        } else {
          socket.write('+OK\r\n')
        }
      }
    })
    socket.on('error', () => undefined)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'fake Redis did not bind')

  return {
    port: address.port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Run one real rate-limit check through the production client and report the commands it sent. */
export async function commandsSentFor(redisUrl: string): Promise<string[][]> {
  const redis = await startFakeRedis()
  try {
    const backend = new RedisRateLimitBackend(redisUrl.replace('__PORT__', String(redis.port)))
    const result = await backend.check('login:o3d-tsc0', 5, 60_000)
    assert.equal(result.allowed, true)
    return await redis.received
  } finally {
    await redis.close()
  }
}
