import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  AWKWARD_PASSWORD,
  commandsSentFor,
  requirepassBytesFrom,
  sliceOptionalBlock,
  sliceRange,
} from './redis-url-wire-harness.ts'

const execFileAsync = promisify(execFile)

/**
 * o3d-tsc0, second artefact. `REDIS_URL` is the canonical place a Redis credential lives, and
 * `scripts/install.sh` is the OTHER script that disagreed with that — and the more damaging one,
 * because it is what stands up a brand new production server.
 *
 * Its local-Redis path wrote `requirepass ${REDIS_PASSWORD}` into `/etc/redis/redis.conf` and then
 * built `REDIS_URL="redis://${REDIS_HOST}:${REDIS_PORT}"` with no credentials at all. Nothing in the
 * application reads `REDIS_PASSWORD` (only `lib/security/rate-limit.ts` reads `REDIS_URL`), so the only
 * password an operator can supply through the installer never reached `AUTH`. The result is not a
 * visible Redis outage: `checkRateLimit`'s auth buckets fail CLOSED, so a Redis answering NOAUTH
 * surfaces as nobody being able to sign in to the server that was just installed.
 *
 * The block under test is executed as SHIPPED, under the same `set -euo pipefail` the installer runs
 * with — a rig without `-e` would hide an abort that takes the real install down. `install.sh` resolves
 * these values through its own `prompt`/`prompt_yn`, which in `--non-interactive` mode take whatever is
 * already in the environment, so the rig drives the real functions rather than re-implementing what
 * they do. The password is then
 * asserted as the argument of the `AUTH` command AS IT ARRIVES ON THE WIRE — see
 * `redis-url-wire-harness.ts` for why an encoding that is only self-consistent must not be able to pass.
 */

const SCRIPT = 'scripts/install.sh'

async function readScript(): Promise<string> {
  return readFile(path.join(SCRIPT), 'utf8')
}

type ShellResult = { url: string; passwordEnv: string; stderr: string }

/**
 * Run the shipped Redis block.
 *
 * The bounds are lines that exist in every version of the script, so reverting the change under test
 * runs the OLD block and fails on what it PRODUCES. `urlencode` is spliced in only if the script has
 * one, for the same reason: with the change reverted there is no encoder, and the test must fail
 * because the URL came out credential-free — not because a marker went missing.
 */
async function runRedisBlock(source: string, env: string): Promise<ShellResult> {
  const urlencode = sliceOptionalBlock(source, 'urlencode() {') ?? ''
  const script = `
    set -euo pipefail
    NON_INTERACTIVE=true
    BOLD=''; RESET=''
    info() { :; }
    warn() { echo "WARN: $*" >&2; }
    die() { echo "DIE: $*" >&2; exit 9; }
    declare -A EXISTING_ENV=()
    ${urlencode}
    ${sliceOptionalBlock(source, 'urldecode() {') ?? ''}
    ${sliceOptionalBlock(source, 'mask_secret() {') ?? ''}
    ${sliceOptionalBlock(source, 'redact_url_credentials() {') ?? ''}
    ${sliceOptionalBlock(source, 'existing_env() {') ?? ''}
    ${sliceOptionalBlock(source, 'prompt() {') ?? ''}
    ${sliceOptionalBlock(source, 'prompt_yn() {') ?? ''}
    ${env}
    ${sliceRange(source, 'prompt_yn INSTALL_REDIS', 'info "--- WooCommerce')}
    printf 'URL<<<%s>>>\\n' "\${REDIS_URL}"
    printf 'PASSWORD_ENV<<<%s>>>\\n' "\${REDIS_PASSWORD_ENV-__ABSENT__}"
  `
  const { stdout, stderr } = await execFileAsync('bash', ['-c', script])
  const url = /URL<<<([\s\S]*?)>>>/.exec(stdout)
  const passwordEnv = /PASSWORD_ENV<<<([\s\S]*?)>>>/.exec(stdout)
  assert.ok(url, `the block did not report a REDIS_URL: ${stdout}`)
  assert.ok(passwordEnv, `the block did not report a REDIS_PASSWORD_ENV: ${stdout}`)
  return { url: url[1], passwordEnv: passwordEnv[1], stderr }
}

/** The same block, when it is expected to refuse. Returns what the operator would have been told. */
async function runRedisBlockExpectingFailure(source: string, env: string): Promise<string> {
  try {
    await runRedisBlock(source, env)
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error)
  }
  throw new assert.AssertionError({ message: 'the block was expected to refuse and did not' })
}

/**
 * Run the SHIPPED redis.conf block against a throwaway config file and return what it wrote.
 *
 * The slice starts one line below `REDIS_CONF=`, at a line that exists in every version of the script,
 * so reverting the change runs the OLD `sed`/`printf` write against the same throwaway file and the
 * test fails on the bytes it PRODUCED — not on a missing marker, and never against a real
 * /etc/redis/redis.conf.
 */
async function runRedisConfBlock(source: string, password: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ims-redis-conf-'))
  const conf = path.join(dir, 'redis.conf')
  await writeFile(
    conf,
    // A realistic Debian redis.conf head: the commented directive is what decides which half of the
    // old two-branch write was taken, and both halves stored the wrong bytes.
    'port 6379\nbind 127.0.0.1 -::1\nprotected-mode yes\n# requirepass foobared\nsave 900 1\n',
    'latin1',
  )
  const script = `
    set -euo pipefail
    die() { echo "DIE: $*" >&2; exit 9; }
    ${sliceOptionalBlock(source, 'redis_conf_quote() {') ?? ''}
    ${sliceOptionalBlock(source, 'redis_conf_set_requirepass() {') ?? ''}
    REDIS_CONF=${JSON.stringify(conf)}
    REDIS_PORT=6379
    REDIS_PASSWORD=${JSON.stringify(password)}
    ${sliceRange(source, '  if [[ -f "${REDIS_CONF}" ]]; then', '  systemctl enable redis-server')}
  `
  await execFileAsync('bash', ['-c', script])
  return readFile(conf, 'latin1')
}

// ---------------------------------------------------------------------------

test('installing Redis locally with a password puts it in REDIS_URL, and the wire AUTH matches byte for byte', async () => {
  const source = await readScript()
  const { url } = await runRedisBlock(
    source,
    `INSTALL_REDIS=y; REDIS_PORT=__PORT__; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )

  assert.match(
    url,
    /^redis:\/\/:[^@]+@localhost:__PORT__$/,
    'the installer wrote requirepass into redis.conf, so the URL it hands the app must carry the same credential',
  )
  assert.ok(!url.includes(AWKWARD_PASSWORD), 'the password must be percent-encoded, not pasted in raw')

  const commands = await commandsSentFor(url.replace('localhost', '127.0.0.1'))
  assert.deepEqual(
    commands[0],
    ['AUTH', AWKWARD_PASSWORD],
    'the bytes the production client puts on the wire must be exactly what the operator typed at the prompt',
  )
})

test('the installer encodes identically to the tenant provisioner, measured against the wire and not against each other', async () => {
  // The two scripts share no shell library and carry two copies of the encoder. A divergence between
  // them cannot be caught by comparing one to the other — only by measuring both against a third party.
  const install = await readScript()
  const { url } = await runRedisBlock(
    install,
    `INSTALL_REDIS=y; REDIS_PORT=__PORT__; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )
  const userinfo = /^redis:\/\/:([^@]+)@/.exec(url)
  assert.ok(userinfo, 'no userinfo to compare')

  const provisioner = await readFile(path.join('scripts/provision-ims-tenant.sh'), 'utf8')
  const { stdout } = await execFileAsync('bash', [
    '-c',
    `set -euo pipefail\n${sliceOptionalBlock(provisioner, 'urlencode() {') ?? ''}\nurlencode "$1"`,
    'bash',
    AWKWARD_PASSWORD,
  ])

  assert.equal(userinfo[1], stdout, 'the two shipped encoders must produce the same bytes')
})

test('the credential is written to ONE place — the .env password line is left empty when the URL carries it', async () => {
  // Not tidiness. The .env is generated with `REDIS_PASSWORD=${...}` unquoted, so a password containing
  // `#`, a quote or whitespace reaches the runtime as something OTHER than what the URL encodes — and a
  // REDIS_URL/REDIS_PASSWORD disagreement is refused outright rather than resolved by precedence
  // (o3d-uqz0), which would take the rate limiter down on a host whose URL was actually correct.
  const source = await readScript()
  const { url, passwordEnv } = await runRedisBlock(
    source,
    `INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )

  assert.ok(url.includes('@'), 'precondition: the URL is the one carrying the credential')
  assert.equal(passwordEnv, '', 'the same secret must not be written to a second, unquoted .env line')

  const envBlock = source.slice(source.indexOf('cat > "${APP_DIR}/.env"'))
  assert.match(
    envBlock,
    /^REDIS_PASSWORD=\$\{REDIS_PASSWORD_ENV\}$/m,
    'the .env line must read the derived value, or emptying it changes nothing',
  )
})

test('a Redis installed with no password gets no userinfo — an empty credential must not become an empty AUTH', async () => {
  const source = await readScript()
  const { url } = await runRedisBlock(source, 'INSTALL_REDIS=y; REDIS_PORT=__PORT__; REDIS_PASSWORD=')

  assert.equal(url, 'redis://localhost:__PORT__')

  const commands = await commandsSentFor(url.replace('localhost', '127.0.0.1'))
  assert.equal(commands[0]?.[0], 'EVAL', 'an unauthenticated Redis must receive no AUTH command')
})

test('a Redis the operator already runs gets the password put in the URL, and the wire AUTH matches it byte for byte', async () => {
  // THE OTHER BRANCH OF THE PROMPT, and the one round one left in the pre-fix state. An operator who
  // points the installer at a Redis they already run types a password here that NOTHING READS: the
  // application connects with REDIS_URL and there is no reader of REDIS_PASSWORD anywhere in the app.
  // So this operator was handed the identical outage as before — a server nobody can sign in to,
  // because the auth buckets fail closed on a Redis that answers NOAUTH.
  const source = await readScript()
  const { url, passwordEnv } = await runRedisBlock(
    source,
    `INSTALL_REDIS=n; REDIS_URL=redis://localhost:__PORT__/2; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )

  assert.match(url, /^redis:\/\/:[^@]+@localhost:__PORT__\/2$/, 'the credential must be spliced into the URL the operator gave')
  assert.ok(!url.includes(AWKWARD_PASSWORD), 'the password must be percent-encoded, not pasted in raw')
  assert.equal(passwordEnv, '', 'once the URL carries it, the unquoted .env line must not carry a second copy')

  const commands = await commandsSentFor(url.replace('localhost', '127.0.0.1'))
  assert.deepEqual(
    commands[0],
    ['AUTH', AWKWARD_PASSWORD],
    'the bytes the production client puts on the wire must be exactly what the operator typed at the prompt',
  )
  assert.deepEqual(commands[1], ['SELECT', '2'], 'the database the operator chose must survive the splice')
})

test('an external REDIS_URL that already carries a credential is left verbatim, and the prompt password is refused rather than spliced in beside it', async () => {
  // Two credentials is not a merge problem to be resolved by precedence, it is a disagreement. The URL
  // wins because an inline credential already beats any environment fallback at runtime, and an
  // operator's own connection string is never rewritten. The point of the warning is that the ignored
  // value is announced instead of disappearing.
  const source = await readScript()
  const { url, passwordEnv, stderr } = await runRedisBlock(
    source,
    'INSTALL_REDIS=n; REDIS_URL=redis://:inthe%40url@cache.internal:6380/2; REDIS_PASSWORD=attheprompt',
  )

  assert.equal(url, 'redis://:inthe%40url@cache.internal:6380/2')
  assert.equal(passwordEnv, '', 'the prompt password must not reach .env either, or the two disagree and startup is refused')
  assert.match(stderr, /WARN: REDIS_URL already carries a credential/)
})

test('a REDIS_URL the password cannot be placed inside is refused loudly, not accepted with the password dropped', async () => {
  const source = await readScript()
  const stderr = await runRedisBlockExpectingFailure(
    source,
    'INSTALL_REDIS=n; REDIS_URL=cache.internal:6379; REDIS_PASSWORD=hunter2',
  )
  assert.match(stderr, /DIE: REDIS_URL must be of the form/)
})

test('an external Redis with no password is left completely alone', async () => {
  // A GUARD, NOT A WITNESS: it passes with the production change reverted, because the no-password path
  // is the one case the old code got right. It is here so the splice above can never fire on an empty
  // credential and turn a healthy unauthenticated Redis into one the client sends `AUTH ""` to.
  const source = await readScript()
  const { url, passwordEnv } = await runRedisBlock(
    source,
    'INSTALL_REDIS=n; REDIS_URL=rediss://cache.internal:6380/2; REDIS_PASSWORD=',
  )

  assert.equal(url, 'rediss://cache.internal:6380/2')
  assert.equal(passwordEnv, '')
})

// ---------------------------------------------------------------------------
// The server side of the same credential.
// ---------------------------------------------------------------------------

test('the requirepass redis.conf is configured with decodes to the same bytes the client sends in AUTH', async () => {
  // BOTH ENDS, MEASURED SEPARATELY AND COMPARED. The URL end is read off a real socket by the
  // production client; the config end is read by a port of redis's own sdssplitargs(), which knows
  // nothing about how the installer writes a password. Neither measurement is the inverse of the
  // encoder under test, so an encoding that is only self-consistent cannot pass this.
  const source = await readScript()
  const { url } = await runRedisBlock(
    source,
    `INSTALL_REDIS=y; REDIS_PORT=__PORT__; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )
  const conf = await runRedisConfBlock(source, AWKWARD_PASSWORD)

  const stored = requirepassBytesFrom(conf)
  assert.ok(stored, 'redis.conf carries no active requirepass, so the server would accept anyone')

  const commands = await commandsSentFor(url.replace('localhost', '127.0.0.1'))
  assert.deepEqual(commands[0], ['AUTH', AWKWARD_PASSWORD])
  assert.equal(
    stored.toString('utf8'),
    commands[0][1],
    'the server is configured with one byte sequence and the client sends another — the install is dead on arrival',
  )
  assert.equal(stored.toString('utf8'), AWKWARD_PASSWORD, 'and both must be what the operator actually typed')
})

test('a Redis installed with no password gets no active requirepass — an empty credential must not become an empty password', async () => {
  // A GUARD, NOT A WITNESS: passes under revert, because commenting the directive out is the half of
  // the old write that was correct. It pins that the new writer did not turn "no password" into
  // `requirepass ""`, which would lock out a client that sends no AUTH at all.
  const source = await readScript()
  const conf = await runRedisConfBlock(source, '')

  assert.equal(requirepassBytesFrom(conf), null)
  assert.match(conf, /^# requirepass foobared$/m, 'the directive is left commented, the way redis ships it')
})

test('re-writing redis.conf with the same password is idempotent — a re-run must not leave two directives', async () => {
  // `requirepass` is last-one-wins in redis, so a stacked file still starts; the reason this matters is
  // that the old write appended a fresh line on every run whose grep missed, and an operator reading
  // the config could not tell which password the server was actually using.
  const source = await readScript()
  const first = await runRedisConfBlock(source, AWKWARD_PASSWORD)
  const dir = await mkdtemp(path.join(tmpdir(), 'ims-redis-rerun-'))
  const conf = path.join(dir, 'redis.conf')
  await writeFile(conf, first, 'latin1')

  const script = `
    set -euo pipefail
    die() { echo "DIE: $*" >&2; exit 9; }
    ${sliceOptionalBlock(source, 'redis_conf_quote() {') ?? ''}
    ${sliceOptionalBlock(source, 'redis_conf_set_requirepass() {') ?? ''}
    REDIS_CONF=${JSON.stringify(conf)}
    REDIS_PORT=6379
    REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}
    ${sliceRange(source, '  if [[ -f "${REDIS_CONF}" ]]; then', '  systemctl enable redis-server')}
  `
  await execFileAsync('bash', ['-c', script])
  const second = await readFile(conf, 'latin1')

  assert.equal(second, first, 'a second run over its own output must produce the identical file')
  assert.equal(
    second.split('\n').filter((line) => line.startsWith('requirepass')).length,
    1,
    'exactly one active requirepass directive',
  )
})

test('the interpolated write this replaced stores something other than the password — pinned, not a witness', async () => {
  // THIS TEST PASSES WITH THE PRODUCTION CHANGE REVERTED, BY DESIGN. It is not evidence that the fix
  // works — the test above is. It is a guard on the shape of the fix, so that "just interpolate it into
  // sed, it is only a config file" cannot come back. It runs the exact two-branch write that shipped
  // before, against a real config, and asserts redis could not have got the password out of it.
  const dir = await mkdtemp(path.join(tmpdir(), 'ims-redis-old-'))

  const viaSed = path.join(dir, 'sed.conf')
  await writeFile(viaSed, 'port 6379\n# requirepass foobared\n', 'latin1')
  const viaAppend = path.join(dir, 'append.conf')
  await writeFile(viaAppend, 'port 6379\n', 'latin1')

  await execFileAsync('bash', [
    '-c',
    `
      set -euo pipefail
      REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}
      # ---- exactly as it shipped ----
      REDIS_CONF=${JSON.stringify(viaSed)}
      sed -i -E "s|^[#[:space:]]*requirepass .*|requirepass \${REDIS_PASSWORD}|" "\${REDIS_CONF}"
      REDIS_CONF=${JSON.stringify(viaAppend)}
      printf '\\nrequirepass %s\\n' "\${REDIS_PASSWORD}" >> "\${REDIS_CONF}"
    `,
  ])

  for (const file of [viaSed, viaAppend]) {
    const conf = await readFile(file, 'latin1')
    let stored: Buffer | null = null
    let refused: unknown = null
    try {
      stored = requirepassBytesFrom(conf)
    } catch (error) {
      refused = error
    }
    assert.ok(
      refused !== null || stored?.toString('utf8') !== AWKWARD_PASSWORD,
      `${path.basename(file)}: an interpolated write must not be able to store the operator's password intact`,
    )
  }
})

// ---------------------------------------------------------------------------
// Printing a URL that now carries a credential.
// ---------------------------------------------------------------------------

test('the installer redacts a URL with the same function as the provisioner, and cuts at the LAST separator', async () => {
  const install = await readScript()
  const provisioner = await readFile(path.join('scripts/provision-ims-tenant.sh'), 'utf8')
  assert.equal(
    sliceOptionalBlock(install, 'redact_url_credentials() {'),
    sliceOptionalBlock(provisioner, 'redact_url_credentials() {'),
    'the two shipped redactions must be character-for-character identical',
  )

  const redact = async (url: string) => {
    const { stdout } = await execFileAsync('bash', [
      '-c',
      `set -euo pipefail\n${sliceOptionalBlock(install, 'redact_url_credentials() {') ?? ''}\nredact_url_credentials "$1"`,
      'bash',
      url,
    ])
    return stdout
  }

  // The installer now shows a preserved REDIS_URL as a prompt default, so this runs on operator input
  // as well as on URLs it built. A password containing the separator defeats a first-`@` cut, which
  // would print the tail of the secret.
  assert.equal(await redact('redis://:se@cret@host:6379/0'), 'redis://***@host:6379/0')
  assert.equal(await redact('redis://:p%40ss@localhost:6379'), 'redis://***@localhost:6379')
  assert.equal(await redact('redis://localhost:6379'), 'redis://localhost:6379')
})

test('locating the authority by the first slash would print the whole URL — pinned as the wrong fix', async () => {
  // Half pin, half witness. The first assertion is the pin and holds regardless of this branch; the
  // rest fails under revert for the blunt reason that the installer had no redaction at ALL before it,
  // which is itself the finding — it now displays a preserved URL as a prompt default. A
  // password's own slash ends a first-slash scan before the separator is ever seen, so the "precise"
  // version of this function finds no credential and prints everything. The same trap is why the
  // external-Redis branch decides "does this URL already have a credential?" with the over-broad
  // `@`-anywhere test rather than by parsing out an authority.
  const url = 'redis://:pa/ss@cache.internal:6379'
  const authority = url.slice(url.indexOf('://') + 3).split('/')[0]
  assert.ok(!authority.includes('@'), 'the first-slash scan cannot see the credential at all')

  const install = await readScript()
  const { stdout } = await execFileAsync('bash', [
    '-c',
    `set -euo pipefail\n${sliceOptionalBlock(install, 'redact_url_credentials() {') ?? ''}\nredact_url_credentials "$1"`,
    'bash',
    url,
  ])
  assert.equal(stdout, 'redis://***@cache.internal:6379', 'the shipped rule redacts it anyway')
  assert.ok(!stdout.includes('pa/ss'))
})
