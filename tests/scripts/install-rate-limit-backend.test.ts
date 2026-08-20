import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * o3d-g42a. scripts/install.sh provisioned Redis, set `requirepass` on it, and
 * then never wrote RATE_LIMIT_BACKEND — so lib/security/rate-limit.ts defaulted
 * to 'memory' on every installer-built host and the Redis it had just secured
 * was never opened. Its counterpart in scripts/install-dev-instance.sh grepped
 * for a literal `RATE_LIMIT_BACKEND=memory` line that install.sh never wrote, so
 * that check could only ever print its warning.
 *
 * The shell is executed rather than pattern-matched wherever it can be: the
 * blocks under test are cut out of the real scripts and run, so a test failure
 * means the shipped code behaves differently, not that a string moved.
 */

async function readScript(name: string): Promise<string> {
  return readFile(path.join('scripts', name), 'utf8')
}

/** Cut a block out of a script by its first and last line, so the SHIPPED text runs. */
function sliceBlock(source: string, startsWith: string, endsWith: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(startsWith))
  assert.notEqual(start, -1, `could not find a line starting with ${JSON.stringify(startsWith)}`)
  const end = lines.findIndex((line, index) => index >= start && line === endsWith)
  assert.notEqual(end, -1, `could not find a line equal to ${JSON.stringify(endsWith)}`)
  return lines.slice(start, end + 1).join('\n')
}

/**
 * Cut a block that runs from `startsWith` up to (not including) the next line
 * beginning `stopBefore`. Bounded by lines that exist in EVERY version of the
 * script, so reverting the block under test runs the old code instead of making
 * the slice unfindable — a test that only proves a marker moved proves nothing.
 */
function sliceUntil(source: string, startsWith: string, stopBefore: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(startsWith))
  assert.notEqual(start, -1, `could not find a line starting with ${JSON.stringify(startsWith)}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith(stopBefore))
  assert.notEqual(end, -1, `could not find a line starting with ${JSON.stringify(stopBefore)}`)
  return lines.slice(start, end).join('\n')
}

async function runBash(script: string): Promise<string> {
  const { stdout } = await execFileAsync('bash', ['-c', script])
  return stdout
}

// ---------------------------------------------------------------------------
// install.sh — the variable is written, and it is written from the answer
// ---------------------------------------------------------------------------

test('install.sh writes RATE_LIMIT_BACKEND into the generated .env', async () => {
  const script = await readScript('install.sh')
  assert.match(
    script,
    /^RATE_LIMIT_BACKEND=\$\{RATE_LIMIT_BACKEND\}$/m,
    'the .env heredoc must emit RATE_LIMIT_BACKEND — without it every installer-built host silently runs the memory backend',
  )
})

test('install.sh resolves RATE_LIMIT_BACKEND from the operator answer, defaulting to the Redis choice', async () => {
  const script = await readScript('install.sh')
  const block = sliceBlock(script, 'REDIS_RATE_LIMIT_DEFAULT="n"', 'fi')

  // NON_INTERACTIVE makes prompt_yn take the pre-set variable or the default,
  // so the real block can be exercised without a terminal.
  const harness = (env: string) => `
    set -euo pipefail
    NON_INTERACTIVE=true
    die() { echo "DIED: $*"; exit 9; }
    warn() { echo "WARN: $*"; }
    ${sliceBlock(script, 'prompt_yn() {', '}')}
    ${env}
    ${block}
    echo "RATE_LIMIT_BACKEND=$RATE_LIMIT_BACKEND"
  `

  const optedOut = await runBash(harness('INSTALL_REDIS=n; REDIS_URL=""; REDIS_PASSWORD=""'))
  assert.match(optedOut, /RATE_LIMIT_BACKEND=memory/, 'declining Redis rate limiting must write memory, not nothing')

  const optedIn = await runBash(harness('INSTALL_REDIS=y; REDIS_URL="redis://localhost:6379"; REDIS_PASSWORD=""'))
  assert.match(
    optedIn,
    /RATE_LIMIT_BACKEND=redis/,
    'installing Redis must default the rate limiter to it — provisioning Redis and then not using it is the defect',
  )

  const explicitYes = await runBash(harness('INSTALL_REDIS=n; USE_REDIS_RATE_LIMIT=y; REDIS_URL="redis://cache:6379"; REDIS_PASSWORD=""'))
  assert.match(explicitYes, /RATE_LIMIT_BACKEND=redis/, 'an external Redis can still back the rate limiter')
})

test('install.sh refuses RATE_LIMIT_BACKEND=redis with no REDIS_URL, and warns when the password is not in the URL', async () => {
  const script = await readScript('install.sh')
  const block = sliceBlock(script, 'REDIS_RATE_LIMIT_DEFAULT="n"', 'fi')
  const harness = (env: string) => `
    set -euo pipefail
    NON_INTERACTIVE=true
    die() { echo "DIED: $*"; exit 0; }
    warn() { echo "WARN: $*"; }
    ${sliceBlock(script, 'prompt_yn() {', '}')}
    ${env}
    ${block}
    echo "RATE_LIMIT_BACKEND=$RATE_LIMIT_BACKEND"
  `

  const noUrl = await runBash(harness('INSTALL_REDIS=n; USE_REDIS_RATE_LIMIT=y; REDIS_URL=""; REDIS_PASSWORD=""'))
  assert.match(noUrl, /DIED: Redis rate limiting needs a Redis URL/, 'the app throws on the first rate-limited request in this state')
  assert.doesNotMatch(noUrl, /RATE_LIMIT_BACKEND=redis/)

  // A remote Redis whose password was typed at the prompt but is absent from the
  // URL the client actually connects with: the auth buckets fail CLOSED, so this
  // combination locks operators out of sign-in rather than degrading quietly.
  const credentiallessUrl = await runBash(
    harness('INSTALL_REDIS=n; USE_REDIS_RATE_LIMIT=y; REDIS_URL="redis://cache:6379"; REDIS_PASSWORD="hunter2"'),
  )
  assert.match(credentiallessUrl, /WARN: REDIS_URL carries no credentials/)
  assert.match(credentiallessUrl, /RATE_LIMIT_BACKEND=redis/, 'it is a warning, not a refusal — the operator may be using an ACL-less server')

  const inlineUrl = await runBash(
    harness('INSTALL_REDIS=n; USE_REDIS_RATE_LIMIT=y; REDIS_URL="redis://:hunter2@cache:6379"; REDIS_PASSWORD="hunter2"'),
  )
  assert.doesNotMatch(inlineUrl, /WARN:/, 'credentials already in the URL are exactly what is being asked for')
})

test('install.sh builds a REDIS_URL that carries the password it puts in redis.conf', async () => {
  const script = await readScript('install.sh')
  const urlencode = sliceBlock(script, 'urlencode() {', '}')
  const build = sliceBlock(script, '  if [[ -n "${REDIS_PASSWORD}" ]]; then', '  fi')

  const harness = (password: string) => `
    set -euo pipefail
    ${urlencode}
    REDIS_HOST=localhost
    REDIS_PORT=6379
    REDIS_PASSWORD=${JSON.stringify(password)}
${build}
    echo "$REDIS_URL"
  `

  assert.equal((await runBash(harness(''))).trim(), 'redis://localhost:6379')
  assert.equal(
    (await runBash(harness('s3cret'))).trim(),
    'redis://:s3cret@localhost:6379',
    'this script sets requirepass on the Redis it installs, so the URL it hands the app must authenticate',
  )
  // A password is free text. Left raw, `@` would split the authority and `/`
  // would end it, so the URL would point somewhere else entirely.
  assert.equal(
    (await runBash(harness('p@ss/w:rd#1'))).trim(),
    'redis://:p%40ss%2Fw%3Ard%231@localhost:6379',
  )
  assert.equal(
    (await runBash(harness('pässwörd'))).trim(),
    'redis://:p%C3%A4ssw%C3%B6rd@localhost:6379',
    'multi-byte characters are percent-encoded byte by byte, which is what a server decodes',
  )
})

// ---------------------------------------------------------------------------
// install-dev-instance.sh — a check that can pass
// ---------------------------------------------------------------------------

async function runTrapFour(envContents: string): Promise<string> {
  const script = await readScript('install-dev-instance.sh')
  const block = sliceUntil(script, '# Trap 4 — shared Redis.', 'say ')
  const dir = await mkdtemp(path.join(tmpdir(), 'ims-dev-instance-'))
  await writeFile(path.join(dir, '.env'), envContents)
  return runBash(`set -euo pipefail\nWORKDIR=${JSON.stringify(dir)}\n${block}`)
}

test('the dev-instance Redis trap PASSES on an .env with no RATE_LIMIT_BACKEND line (o3d-g42a)', async () => {
  // Every .env install.sh generated before o3d-g42a is this shape. The old check
  // grepped for a literal line that was never written, so it could only ever
  // warn — and an absent variable IS the memory backend the trap wants.
  const output = await runTrapFour('DATABASE_URL=postgres://x\nREDIS_URL=redis://localhost:6379\n')
  assert.match(output, /rate-limit backend: memory .*: ok/)
  assert.doesNotMatch(output, /WARNING/)
})

test('the dev-instance Redis trap passes on an explicit memory backend and tolerates quoting', async () => {
  assert.match(await runTrapFour('RATE_LIMIT_BACKEND=memory\n'), /: ok/)
  assert.match(await runTrapFour('RATE_LIMIT_BACKEND="memory"\r\n'), /: ok/)
  assert.match(await runTrapFour('RATE_LIMIT_BACKEND=MEMORY\n'), /: ok/)
})

test('the dev-instance Redis trap warns about the collision it exists for, naming redis', async () => {
  const output = await runTrapFour('RATE_LIMIT_BACKEND=redis\n')
  assert.match(output, /WARNING: RATE_LIMIT_BACKEND=redis in \.env/)
  assert.match(output, /counters collide/)
})

test('the dev-instance Redis trap reports a value the app cannot use', async () => {
  // getConfiguredRateLimitBackendName throws on anything but memory/redis, so
  // this .env takes the instance down on its first rate-limited request.
  const output = await runTrapFour('RATE_LIMIT_BACKEND=valkey\n')
  assert.match(output, /WARNING: RATE_LIMIT_BACKEND=valkey is not a backend the app knows/)
})
