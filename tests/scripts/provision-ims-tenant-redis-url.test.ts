import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  AWKWARD_PASSWORD,
  commandsSentFor,
  sliceBlock,
  sliceRange,
} from './redis-url-wire-harness.ts'

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

/**
 * Cut the Redis resolution block. Both bounds are lines that exist in every version of the script, so
 * reverting the change under test runs the OLD block rather than making the slice unfindable — a test
 * that only proves a marker moved proves nothing.
 */
function sliceRedisBlock(source: string): string {
  return sliceRange(source, 'REDIS_KEY_PREFIX="${REDIS_KEY_PREFIX', 'CLOUDFLARE_PROXIED=')
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

// ---------------------------------------------------------------------------
// The redaction has to survive a URL this script did NOT build (Codex r1).
//
// The script encodes the passwords it builds, so its own URLs hold exactly one `@`. But a
// caller-supplied REDIS_URL is left verbatim BY DESIGN — rewriting an operator's connection string is
// how you end up authenticating with something nobody typed — and an operator who typed the password
// straight into the URL did not percent-encode it. The redaction is what stands between that string
// and a provisioning log, so it is the redaction that has to cope, not the operator.
// ---------------------------------------------------------------------------

test('a raw @ inside a caller-supplied password does not put the tail of the secret in the log', async () => {
  const source = await readScript()
  const { url, display } = await runRedisBlock(
    source,
    'REDIS_MODE=external; REDIS_HOST=cache.internal; REDIS_URL=redis://:se@cr/et@cache.internal:6379/0',
  )

  assert.equal(url, 'redis://:se@cr/et@cache.internal:6379/0', "the operator's string is still untouched")
  assert.equal(
    display,
    'redis://***@cache.internal:6379/0',
    'the cut must be at the LAST @, or it lands inside the password',
  )
  assert.ok(
    !display.includes('cr') && !display.includes('et@'),
    'no fragment of the password may survive: cutting at the first @ printed "***@cr/et@cache.internal"',
  )
  assert.equal(
    (display.match(/@/g) ?? []).length,
    1,
    'a second @ in the redacted output is the password still being there',
  )
})

// The two below still pass with the redaction reverted, on purpose. The first-@ cut happens to get a
// `/`-bearing password right, so this one is not a witness against THAT bug — it is a guard against the
// obvious wrong fix, which is to locate the authority by cutting at the first `/` and then look for an
// @ inside it. That reads the password's own slash as the end of the authority, finds no @, and prints
// the whole URL. The third pins the deliberate cost of cutting at the last @.
test('a raw / inside a caller-supplied password is redacted too, and the host survives it', async () => {
  const source = await readScript()
  const { display } = await runRedisBlock(
    source,
    'REDIS_MODE=external; REDIS_HOST=cache.internal; REDIS_URL=redis://opsuser:pa/ss@cache.internal:6379/2',
  )

  assert.equal(
    display,
    'redis://***@cache.internal:6379/2',
    'the ACL username goes with the password — the summary reports the shape, and the shape is the host',
  )
  assert.ok(!display.includes('opsuser') && !display.includes('pa/ss'))
})

test('a URL whose only @ is outside the credentials is over-redacted, never under-redacted', async () => {
  // Pinning the cost of cutting at the last @, so the trade is reviewed rather than discovered. A
  // credential-free URL with an @ later in it prints an unhelpful shape. That is the direction to be
  // wrong in: an over-redacted summary line is cosmetic, an under-redacted one is a secret in a file
  // somebody keeps.
  const source = await readScript()
  const { display } = await runRedisBlock(
    source,
    'REDIS_MODE=external; REDIS_HOST=cache.internal; REDIS_URL=redis://cache.internal:6379/0?tag=a@b',
  )

  assert.equal(display, 'redis://***@b')
})
