import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { RedisRateLimitBackend } from '@/lib/security/rate-limit-redis'

const execFileAsync = promisify(execFile)

/**
 * o3d-tsc0. A Redis password can reach the rate limiter two ways — inline in `REDIS_URL`, or as a
 * standalone `REDIS_PASSWORD` — and this issue settles which one is canonical: the URL. It is what the
 * client connects with, it is the only form that can carry a Redis 6 ACL username, and inline
 * credentials already win over any env fallback, so choosing it makes merge order irrelevant.
 *
 * `scripts/provision-ims-tenant.sh` was the artefact that disagreed. It wrote `REDIS_PASSWORD` into the
 * tenant `.env` and built a `REDIS_URL` with NO credentials, so a tenant provisioned with a Redis
 * password got a rate limiter that answers NOAUTH. That does not present as a Redis fault: the auth
 * buckets fail CLOSED, so the symptom is that nobody can sign in.
 *
 * WHY THIS TEST GOES OUT OVER A SOCKET. A percent-encoder is trivially self-consistent — encode with
 * one function, decode with its inverse, and any encoding passes. So the assertion is not made against
 * a pattern or against a second copy of the encoder: the shell block from the SHIPPED script is
 * executed, and the URL it produces is handed to the production `RedisRateLimitBackend`, which connects
 * to a Redis-speaking socket here. What is asserted is the argument of the `AUTH` command as it arrives
 * on the wire. Nothing in the test knows how the password was encoded on the way.
 */

const SCRIPT = 'scripts/provision-ims-tenant.sh'

async function readScript(): Promise<string> {
  return readFile(path.join(SCRIPT), 'utf8')
}

/** Cut a function out of the script by its opening line and the first closing brace, so SHIPPED text runs. */
function sliceBlock(source: string, startsWith: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(startsWith))
  assert.notEqual(start, -1, `could not find a line starting with ${JSON.stringify(startsWith)}`)
  const end = lines.findIndex((line, index) => index >= start && line === '}')
  assert.notEqual(end, -1, `could not find the closing brace for ${JSON.stringify(startsWith)}`)
  return lines.slice(start, end + 1).join('\n')
}

/**
 * Cut the Redis resolution block. Both bounds are lines that exist in every version of the script, so
 * reverting the change under test runs the OLD block rather than making the slice unfindable — a test
 * that only proves a marker moved proves nothing.
 */
function sliceRedisBlock(source: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith('REDIS_KEY_PREFIX="${REDIS_KEY_PREFIX'))
  assert.notEqual(start, -1, 'could not find the start of the Redis resolution block')
  const end = lines.findIndex((line, index) => index > start && line.startsWith('CLOUDFLARE_PROXIED='))
  assert.notEqual(end, -1, 'could not find the end of the Redis resolution block')
  return lines.slice(start, end).join('\n')
}

type ShellResult = { url: string; display: string; stderr: string }

async function runRedisBlock(source: string, env: string): Promise<ShellResult> {
  const script = `
    set -euo pipefail
    warn() { echo "WARN: $*" >&2; }
    die() { echo "DIED: $*" >&2; exit 9; }
    require_env() { local name="$1"; [[ -n "\${!name:-}" ]] || die "Missing required environment variable: \${name}"; }
    ${sliceBlock(source, 'urlencode() {')}
    ${sliceBlock(source, 'redact_url_credentials() {')}
    TENANT_SLUG=acme
    REDIS_PORT=6379
    REDIS_DB=0
    ${env}
    ${sliceRedisBlock(source)}
    printf 'URL<<<%s>>>\\n' "\${REDIS_URL}"
    printf 'DISPLAY<<<%s>>>\\n' "\${REDIS_URL_DISPLAY:-}"
  `
  const { stdout, stderr } = await execFileAsync('bash', ['-c', script])
  const url = /URL<<<([\s\S]*?)>>>/.exec(stdout)
  const display = /DISPLAY<<<([\s\S]*?)>>>/.exec(stdout)
  assert.ok(url, `the block did not report a REDIS_URL: ${stdout}`)
  assert.ok(display, `the block did not report a display URL: ${stdout}`)
  return { url: url[1], display: display[1], stderr }
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
async function commandsSentFor(redisUrl: string): Promise<string[][]> {
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

// A password made of every character that has ever broken one of these encoders:
// URL delimiters, a percent, a quote, a backslash, whitespace, and a multi-byte
// character so the encoder is proven to walk BYTES rather than codepoints.
const AWKWARD_PASSWORD = 'p@ss:w/o?r#d %25&+=" \\tail ä'

// ---------------------------------------------------------------------------

test('a locally provisioned Redis gets the password into REDIS_URL, and the wire AUTH matches it byte for byte', async () => {
  const source = await readScript()
  const { url } = await runRedisBlock(
    source,
    `REDIS_MODE=local; REDIS_PORT=__PORT__; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )

  assert.match(url, /^redis:\/\/:[^@]+@localhost:__PORT__\/0$/, 'the credential must be inline in the URL')
  assert.ok(!url.includes(AWKWARD_PASSWORD), 'the password must be percent-encoded, not pasted in raw')

  const commands = await commandsSentFor(url.replace('localhost', '127.0.0.1'))
  assert.deepEqual(
    commands[0],
    ['AUTH', AWKWARD_PASSWORD],
    'the bytes the production client puts on the wire must be exactly what the operator supplied',
  )
  assert.deepEqual(commands[1], ['SELECT', '0'])
})

test('an external Redis gets the same treatment, host and db untouched', async () => {
  const source = await readScript()
  const { url } = await runRedisBlock(
    source,
    `REDIS_MODE=external; REDIS_HOST=127.0.0.1; REDIS_PORT=__PORT__; REDIS_DB=3; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )

  assert.match(url, /^redis:\/\/:[^@]+@127\.0\.0\.1:__PORT__\/3$/)

  const commands = await commandsSentFor(url)
  assert.deepEqual(commands[0], ['AUTH', AWKWARD_PASSWORD])
  assert.deepEqual(commands[1], ['SELECT', '3'], 'the database index must survive the credential being added')
})

// Guards on behaviour that must NOT change. Both still pass with the o3d-tsc0 block reverted, on
// purpose: they pin the two paths the new credential handling could have broken (an empty password
// becoming an empty AUTH, and a correctly configured host acquiring a warning).
test('no password means no userinfo at all — an empty credential must not become an empty AUTH', async () => {
  const source = await readScript()
  const { url, stderr } = await runRedisBlock(source, 'REDIS_MODE=local; REDIS_PORT=__PORT__; REDIS_PASSWORD=')

  assert.equal(url, 'redis://localhost:__PORT__/0')
  assert.doesNotMatch(stderr, /WARN:/)

  const commands = await commandsSentFor(url.replace('localhost', '127.0.0.1'))
  assert.equal(commands[0]?.[0], 'SELECT', 'an unauthenticated Redis must receive no AUTH command')
})

test('a caller-supplied REDIS_URL is never rewritten, but the mismatch is named with its real symptom', async () => {
  const source = await readScript()
  const { url, stderr } = await runRedisBlock(
    source,
    'REDIS_MODE=external; REDIS_HOST=cache.internal; REDIS_URL=redis://cache.internal:6379/0; REDIS_PASSWORD=hunter2',
  )

  assert.equal(url, 'redis://cache.internal:6379/0', "an operator's own connection string must survive verbatim")
  assert.match(stderr, /WARN: REDIS_URL was supplied without credentials but REDIS_PASSWORD is set/)
  assert.match(stderr, /the application connects with REDIS_URL/)
  assert.match(
    stderr,
    /Redis will answer NOAUTH and sign-in will fail closed/,
    'the warning has to name the symptom, because NOAUTH surfaces as "nobody can sign in", not as a Redis fault',
  )
})

test('a caller-supplied REDIS_URL that already carries a credential is left alone and unremarked', async () => {
  const source = await readScript()
  const { url, stderr } = await runRedisBlock(
    source,
    'REDIS_MODE=external; REDIS_HOST=cache.internal; REDIS_URL=redis://:already%40set@cache.internal:6379/0; REDIS_PASSWORD=already@set',
  )

  assert.equal(url, 'redis://:already%40set@cache.internal:6379/0')
  assert.doesNotMatch(stderr, /WARN:/, 'warning on a correctly configured host is how a warning gets ignored')
})

test('the provisioning summary reports the shape of the URL, never the secret', async () => {
  const source = await readScript()
  const { display } = await runRedisBlock(
    source,
    `REDIS_MODE=external; REDIS_HOST=cache.internal; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )

  assert.equal(display, 'redis://***@cache.internal:6379/0')
  assert.ok(!display.includes('%'), 'not even the percent-encoded form may reach the provisioning log')
})

test('a credential-free URL is shown unchanged, so the redaction cannot hide a missing password', async () => {
  const source = await readScript()
  const { display } = await runRedisBlock(source, 'REDIS_MODE=local; REDIS_PASSWORD=')

  assert.equal(display, 'redis://localhost:6379/0')
})
