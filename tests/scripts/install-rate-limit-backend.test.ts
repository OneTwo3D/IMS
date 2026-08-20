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

// ---------------------------------------------------------------------------
// o3d-xnwu round 2 — THE TWO ENCODINGS MUST BE THE SAME SECRET
// ---------------------------------------------------------------------------

/**
 * redis.conf's own reader, ported.
 *
 * The point of these tests is that the password survives BOTH encodings as the
 * same bytes, and that is not a claim a regex over install.sh can make. So the
 * config line the shipped script writes is decoded the way the server decodes
 * it — `sdstrim` on the line, then `sdssplitargs` on what is left — and the URL
 * is decoded the way a Redis client decodes it. If those two disagree, the app
 * authenticates with one secret and the server expects another, and the login
 * rate limiter fails CLOSED: nobody signs in.
 *
 * Ported rather than asserted-about on purpose. A test that checked for a
 * backslash before a quote would pass on an encoding that is merely CONSISTENT
 * with itself; this one fails unless the round trip lands on the original bytes.
 */
function sdssplitargs(line: Buffer): Buffer[] | null {
  const args: Buffer[] = []
  const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c
  const isHex = (b: number) =>
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
  const hexVal = (b: number) => parseInt(String.fromCharCode(b), 16)

  let p = 0
  for (;;) {
    while (p < line.length && isSpace(line[p])) p++
    if (p >= line.length) return args

    const current: number[] = []
    let inq = false
    let insq = false
    let done = false
    while (!done) {
      const c = p < line.length ? line[p] : -1
      if (inq) {
        if (c === 0x5c /* \ */ && p + 3 < line.length && line[p + 1] === 0x78 /* x */
          && isHex(line[p + 2]) && isHex(line[p + 3])) {
          current.push(hexVal(line[p + 2]) * 16 + hexVal(line[p + 3]))
          p += 3
        } else if (c === 0x5c && p + 1 < line.length) {
          p++
          const e = line[p]
          const map: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x61: 0x07 }
          current.push(map[e] ?? e)
        } else if (c === 0x22 /* " */) {
          // A closing quote must be followed by a space or nothing at all.
          if (p + 1 < line.length && !isSpace(line[p + 1])) return null
          done = true
        } else if (c === -1) {
          return null
        } else {
          current.push(c)
        }
      } else if (insq) {
        if (c === 0x5c && p + 1 < line.length && line[p + 1] === 0x27 /* ' */) {
          p++
          current.push(0x27)
        } else if (c === 0x27) {
          if (p + 1 < line.length && !isSpace(line[p + 1])) return null
          done = true
        } else if (c === -1) {
          return null
        } else {
          current.push(c)
        }
      } else if (c === -1 || isSpace(c)) {
        done = true
      } else if (c === 0x22) {
        inq = true
      } else if (c === 0x27) {
        insq = true
      } else {
        current.push(c)
      }
      if (p < line.length) p++
    }
    args.push(Buffer.from(current))
  }
}

/** What the server ends up with for `requirepass`, or null when the line is unusable. */
function requirepassFromConf(conf: Buffer): Buffer | null {
  for (const rawLine of conf.toString('binary').split('\n')) {
    const trimmed = Buffer.from(rawLine.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''), 'binary')
    if (trimmed.length === 0 || trimmed[0] === 0x23 /* # */) continue
    const args = sdssplitargs(trimmed)
    if (args === null) return null // the server refuses to start on this line
    if (args.length === 0) continue
    if (args[0].toString('binary') !== 'requirepass') continue
    if (args.length !== 2) return null // "wrong number of arguments"
    return args[1]
  }
  return null
}

/**
 * Single-quote a value for bash.
 *
 * NOT JSON.stringify: bash does not process `\t` inside double quotes, so a
 * password containing a real tab would reach the script as a backslash and a
 * `t` — the test would then be exercising a different password than the one it
 * names, which is its own small version of this session's defect.
 */
const shq = (value: string): string => `'${value.split("'").join("'\\''")}'`

/** What a Redis client ends up with, given `redis://:<userinfo>@host:port`. */
function passwordFromRedisUrl(url: string): Buffer | null {
  const match = /^redis:\/\/:([^@]*)@/.exec(url)
  if (!match) return null
  return Buffer.from(match[1].replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary')
}

/**
 * Passwords that break a RAW `requirepass` line, each for its own reason. Every
 * one of these is a password an operator can type at the prompt.
 */
const HOSTILE_PASSWORDS: Array<[string, string]> = [
  ['s3cret', 'the ordinary case must keep working'],
  ['hunter 2', 'a space splits the line into two arguments — the server refuses to start'],
  ['\ttabbed', 'a leading tab is trimmed away before the line is even parsed'],
  ['trailing  ', 'trailing whitespace is trimmed away'],
  ['a"b', 'a double quote re-tokenizes the rest of the line'],
  ["it's", 'a single quote opens a quoted string'],
  ['back\\slash', 'a backslash is an escape to both sed and the config parser'],
  ['amp&ersand', 'in a sed replacement & expands to the WHOLE matched line'],
  ['pipe|delim', 'a pipe ends the s|…|…| expression'],
  ['\\1group', 'a backreference in a sed replacement'],
  ['#hash', 'and the one that is only safe because the value is not at the start of the line'],
  ['p@ss/w:rd#1', 'the URL-hostile characters the percent-encoding already handled'],
  ['pässwörd', 'multi-byte: the two encodings must agree on BYTES, not codepoints'],
]

test('install.sh writes a requirepass the server decodes back to the password in REDIS_URL', async () => {
  const script = await readScript('install.sh')
  const urlencode = sliceBlock(script, 'urlencode() {', '}')
  const confQuote = sliceBlock(script, 'redis_conf_quote() {', '}')
  const urlBuild = sliceBlock(script, '  if [[ -n "${REDIS_PASSWORD}" ]]; then', '  fi')
  const confBlock = sliceBlock(script, '    if [[ -n "${REDIS_PASSWORD}" ]]; then', '    fi')

  for (const [password, why] of HOSTILE_PASSWORDS) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ims-redis-conf-'))
    const conf = path.join(dir, 'redis.conf')
    // A stock redis.conf: the commented-out default the installer has to replace.
    await writeFile(conf, 'port 6379\n# requirepass foobared\nappendonly no\n')

    const out = await runBash(`
      set -euo pipefail
      ${urlencode}
      ${confQuote}
      REDIS_HOST=localhost
      REDIS_PORT=6379
      REDIS_CONF=${shq(conf)}
      REDIS_PASSWORD=${shq(password)}
${urlBuild}
${confBlock}
      printf '%s' "$REDIS_URL"
    `)

    const fromUrl = passwordFromRedisUrl(out)
    assert.ok(fromUrl, `REDIS_URL carried no credential for ${JSON.stringify(password)}`)
    assert.equal(
      fromUrl.toString('binary'),
      Buffer.from(password, 'utf8').toString('binary'),
      `the URL must decode back to the password (${why})`,
    )

    const fromConf = requirepassFromConf(await readFile(conf))
    assert.ok(
      fromConf,
      `redis.conf holds no usable requirepass for ${JSON.stringify(password)} — ${why}`,
    )
    assert.equal(
      fromConf.toString('binary'),
      fromUrl.toString('binary'),
      `redis.conf and REDIS_URL must be the same SECRET for ${JSON.stringify(password)} — ${why}. `
      + 'When they disagree the rate limiter fails AUTH, and it fails CLOSED on the auth buckets: nobody can sign in.',
    )
  }
})

test('install.sh leaves exactly one requirepass line, and no commented default behind it', async () => {
  const script = await readScript('install.sh')
  const confQuote = sliceBlock(script, 'redis_conf_quote() {', '}')
  const confBlock = sliceBlock(script, '    if [[ -n "${REDIS_PASSWORD}" ]]; then', '    fi')

  const dir = await mkdtemp(path.join(tmpdir(), 'ims-redis-conf-'))
  const conf = path.join(dir, 'redis.conf')
  await writeFile(conf, '# requirepass foobared\nrequirepass stale\n  requirepass indented\n')

  await runBash(`
    set -euo pipefail
    ${confQuote}
    REDIS_CONF=${JSON.stringify(conf)}
    REDIS_PASSWORD='new secret'
${confBlock}
  `)

  const lines = (await readFile(conf, 'utf8')).split('\n').filter((line) => /requirepass/.test(line))
  assert.deepEqual(lines, ['requirepass "new secret"'], 'a stale requirepass left behind could win depending on order')
})

test('an empty password re-comments requirepass rather than writing an empty one', async () => {
  const script = await readScript('install.sh')
  const confQuote = sliceBlock(script, 'redis_conf_quote() {', '}')
  const confBlock = sliceBlock(script, '    if [[ -n "${REDIS_PASSWORD}" ]]; then', '    fi')

  const dir = await mkdtemp(path.join(tmpdir(), 'ims-redis-conf-'))
  const conf = path.join(dir, 'redis.conf')
  await writeFile(conf, 'requirepass previous\n')

  await runBash(`
    set -euo pipefail
    ${confQuote}
    REDIS_CONF=${JSON.stringify(conf)}
    REDIS_PASSWORD=''
${confBlock}
  `)

  assert.equal(requirepassFromConf(await readFile(conf)), null, 'no password is configured')
  assert.match(await readFile(conf, 'utf8'), /# requirepass foobared/)
})

test('install.sh makes the SERVER confirm the two encodings agree before it finishes', async () => {
  // The decoder above is a port, and a port can be wrong. The install itself asks
  // the only authority there is — the running server — and refuses to finish if
  // AUTH does not come back PONG.
  const script = await readScript('install.sh')
  assert.match(
    script,
    /redis-cli -h 127\.0\.0\.1 -p "\$\{REDIS_PORT\}" -a "\$\{REDIS_PASSWORD\}" --no-auth-warning ping/,
    'the installer must verify AUTH with the password it wrote, not assume it landed',
  )
  assert.match(script, /die "Redis rejected the password this script just wrote/)
})
