import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  AWKWARD_PASSWORD,
  commandsSentFor,
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
 * The block under test is executed as SHIPPED. `install.sh` resolves these values through its own
 * `prompt`/`prompt_yn`, which in `--non-interactive` mode take whatever is already in the environment,
 * so the rig drives the real functions rather than re-implementing what they do. The password is then
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
    set -uo pipefail
    NON_INTERACTIVE=true
    BOLD=''; RESET=''
    info() { :; }
    ${urlencode}
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
    `set -uo pipefail\n${sliceOptionalBlock(provisioner, 'urlencode() {') ?? ''}\nurlencode "$1"`,
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

test('an operator-supplied REDIS_URL is not rewritten, and its password line still reaches .env', async () => {
  // The other branch of the prompt: the operator points the installer at a Redis they already run. That
  // string is theirs and is left verbatim, and because the installer did not put a credential in the
  // URL, REDIS_PASSWORD is still the only place their password can be recorded.
  const source = await readScript()
  const { url, passwordEnv } = await runRedisBlock(
    source,
    'INSTALL_REDIS=n; REDIS_URL=rediss://cache.internal:6380/2; REDIS_PASSWORD=hunter2',
  )

  assert.equal(url, 'rediss://cache.internal:6380/2')
  assert.equal(passwordEnv, 'hunter2')
})
