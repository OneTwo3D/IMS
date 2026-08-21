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
