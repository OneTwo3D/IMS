import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
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
 * Run a command on a pseudo-terminal and return everything it painted on the screen.
 *
 * `read -p` displays its prompt ONLY when stdin is a terminal, so the prompt line — which is the
 * artefact under test here — is invisible to an ordinary pipe. Every prompt is answered with a bare
 * newline, which is what "press Enter through the installer" means and is what makes the DEFAULTS the
 * thing on screen. (Closing stdin instead would be a trap: `read -s` never returns on a pty at EOF.)
 */
function renderOnPty(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-qec', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.stdin.on('error', () => undefined)
    child.stdin.write('\n'.repeat(64))
    const guard = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the prompts never finished rendering; captured so far: ${out}`))
    }, 20_000)
    child.on('error', (error) => { clearTimeout(guard); reject(error) })
    child.on('close', () => { clearTimeout(guard); resolve(out) })
  })
}

const SCRIPT = 'scripts/install.sh'

async function readScript(): Promise<string> {
  return readFile(path.join(SCRIPT), 'utf8')
}

/**
 * Everything the `.env` heredoc interpolates that is not under test here. Declared empty so the
 * heredoc runs as shipped under `set -u` without this rig having an opinion about it.
 */
const UNRELATED_VARS = [
  'WC_STORE_URL',
  'WC_CONSUMER_KEY',
  'WC_CONSUMER_SECRET',
  'WC_WEBHOOK_SECRET',
  'XERO_CLIENT_ID',
  'XERO_CLIENT_SECRET',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
]

/**
 * One complete run of the installer's configuration + `.env` write, as shipped.
 *
 * Every slice is bounded by lines that exist in every version of the script, or is optional, so that
 * reverting the change under test runs the OLD code and the test fails on what the second run
 * PRODUCED — a rerun test that only proved a marker moved would prove nothing.
 */
async function runInstaller(source: string, appDir: string, env: string): Promise<Record<string, string>> {
  return (await runInstallerCapturing(source, appDir, env)).values
}

/** The same run, when what the operator was TOLD matters as much as what was written. */
async function runInstallerCapturing(
  source: string,
  appDir: string,
  env: string,
): Promise<{ values: Record<string, string>; stderr: string }> {
  const hasEnvTable = source.includes('declare -A EXISTING_ENV=()')
  const script = `
    set -euo pipefail
    NON_INTERACTIVE=true
    BOLD=''; RESET=''; YELLOW=''
    info() { :; }
    warn() { echo "WARN: $*" >&2; }
    die() { echo "DIE: $*" >&2; exit 9; }
    APP_DIR=${JSON.stringify(appDir)}
    APP_NAME=one-two-inventory
    DATA_DIR="\${APP_DIR}/data"
    BACKUP_DIR="\${DATA_DIR}/backups"
    UPLOAD_STORAGE_DIR="\${DATA_DIR}/uploads"
    PUBLIC_UPLOAD_STORAGE_DIR="\${DATA_DIR}/public-uploads"
    APP_PORT=3000
    APP_DOMAIN=ims.example.com
    DATABASE_URL=postgresql://imsuser:pw@localhost:5432/one_two_inventory
    ${UNRELATED_VARS.map((name) => `${name}=''`).join('\n    ')}
    ${hasEnvTable ? 'declare -A EXISTING_ENV=()' : ''}
    ${sliceOptionalBlock(source, 'urlencode() {') ?? ''}
    ${sliceOptionalBlock(source, 'urldecode() {') ?? ''}
    ${sliceOptionalBlock(source, 'mask_secret() {') ?? ''}
    ${sliceOptionalBlock(source, 'redact_url_credentials() {') ?? ''}
    ${sliceOptionalBlock(source, 'load_existing_env() {') ?? ''}
    ${sliceOptionalBlock(source, 'existing_env() {') ?? ''}
    ${sliceOptionalBlock(source, 'prompt() {') ?? ''}
    ${sliceOptionalBlock(source, 'prompt_yn() {') ?? ''}
    ${source.includes('\nload_existing_env "${APP_DIR}/.env"') ? 'load_existing_env "${APP_DIR}/.env"' : ''}
    ${env}
    ${sliceRange(source, 'prompt_yn INSTALL_REDIS', 'info "--- WooCommerce')}
    ${sliceRange(source, 'AUTH_SECRET=', 'cat > "${APP_DIR}/.env"')}
    ${sliceRange(source, 'cat > "${APP_DIR}/.env" <<EOF', 'chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"')}
  `
  const { stderr } = await execFileAsync('bash', ['-c', script])
  return { values: parseEnvFile(await readFile(path.join(appDir, '.env'), 'utf8')), stderr }
}

/** Read the generated file the way the loader under test reads it: `KEY=VALUE` to end of line. */
function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of contents.split('\n')) {
    if (/^\s*(#|$)/.test(line) || !line.includes('=')) continue
    const key = line.slice(0, line.indexOf('='))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    values[key] = line.slice(line.indexOf('=') + 1)
  }
  return values
}

/** Run the shipped redis.conf write for a password, and report what redis would require. */
async function requirepassAfterInstall(source: string, password: string): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ims-rerun-conf-'))
  const conf = path.join(dir, 'redis.conf')
  await writeFile(conf, 'port 6379\nbind 127.0.0.1 -::1\n# requirepass foobared\n', 'latin1')
  await execFileAsync('bash', [
    '-c',
    `
      set -euo pipefail
      die() { echo "DIE: $*" >&2; exit 9; }
      ${sliceOptionalBlock(source, 'redis_conf_quote() {') ?? ''}
      ${sliceOptionalBlock(source, 'redis_conf_set_requirepass() {') ?? ''}
      REDIS_CONF=${JSON.stringify(conf)}
      REDIS_PORT=6379
      REDIS_PASSWORD=${JSON.stringify(password)}
      ${sliceRange(source, '  if [[ -f "${REDIS_CONF}" ]]; then', '  systemctl enable redis-server')}
    `,
  ])
  return requirepassBytesFrom(await readFile(conf, 'latin1'))
}

async function appDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ims-install-rerun-'))
}

// ---------------------------------------------------------------------------

test('re-running the installer over a local Redis install keeps the working credential at BOTH ends', async () => {
  const source = await readScript()
  const appDir = await appDirectory()

  const first = await runInstaller(
    source,
    appDir,
    `INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )
  assert.match(first.REDIS_URL, /^redis:\/\/:[^@]+@localhost:6379$/, 'precondition: the first run put the credential in the URL')

  // The second run: the operator re-runs the installer and supplies nothing, which is what accepting
  // every default does. Nothing about the Redis password is in the environment this time.
  const second = await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379')

  assert.equal(second.REDIS_URL, first.REDIS_URL, 'the re-run replaced a working REDIS_URL')
  assert.equal(second.REDIS_PASSWORD, '', 'the credential still lives in exactly one place')

  const commands = await commandsSentFor(second.REDIS_URL.replace('localhost', '127.0.0.1').replace(':6379', ':__PORT__'))
  assert.deepEqual(
    commands[0],
    ['AUTH', AWKWARD_PASSWORD],
    'after the re-run the client must still send the password the operator originally typed',
  )

  const stored = await requirepassAfterInstall(source, AWKWARD_PASSWORD)
  assert.equal(
    stored?.toString('utf8'),
    commands[0][1],
    'and the server the re-run reconfigures must still require the same byte sequence',
  )
})

test('re-running the installer against the Redis it already installed leaves the URL untouched', async () => {
  // The other way an upgrade run goes: the operator answers "no, Redis is already installed". Before,
  // this branch prompted for a URL whose default was `redis://localhost:6379`, so pressing Enter
  // pointed a working install at an unauthenticated address and dropped the password on the floor.
  const source = await readScript()
  const appDir = await appDirectory()

  const first = await runInstaller(
    source,
    appDir,
    `INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )
  const { values: second, stderr } = await runInstallerCapturing(source, appDir, 'INSTALL_REDIS=n')

  assert.equal(second.REDIS_URL, first.REDIS_URL)
  assert.equal(second.REDIS_PASSWORD, '')
  assert.ok(
    !stderr.includes('already carries a credential'),
    'a re-run that changed nothing must not warn — a warning on every ordinary upgrade is one operators learn to skip past',
  )

  const commands = await commandsSentFor(second.REDIS_URL.replace('localhost', '127.0.0.1').replace(':6379', ':__PORT__'))
  assert.deepEqual(commands[0], ['AUTH', AWKWARD_PASSWORD])
})

test('re-running the installer keeps the key prefix and the secrets that cannot be re-minted', async () => {
  // SETTINGS_ENCRYPTION_KEY is the one that does not merely lock people out: every encrypted Setting
  // already in the database — Xero tokens, connector secrets — becomes permanently undecryptable if a
  // re-run mints a new one. AUTH_SECRET invalidates every session, and CRON_SECRET silently
  // de-authorises the crontab this same script wrote.
  const source = await readScript()
  const appDir = await appDirectory()

  const first = await runInstaller(
    source,
    appDir,
    `INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}; REDIS_KEY_PREFIX=acme`,
  )
  const second = await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379')

  assert.equal(second.REDIS_KEY_PREFIX, 'acme', 'a re-run silently re-namespacing every key empties every counter')
  assert.equal(second.SETTINGS_ENCRYPTION_KEY, first.SETTINGS_ENCRYPTION_KEY)
  assert.equal(second.AUTH_SECRET, first.AUTH_SECRET)
  assert.equal(second.CRON_SECRET, first.CRON_SECRET)

  assert.ok(first.AUTH_SECRET.length > 0 && first.CRON_SECRET.length > 0, 'a FIRST install still mints them')
})

test('a first install on a machine with no .env mints fresh secrets rather than reusing anything', async () => {
  // A GUARD, NOT A WITNESS: this passes with the production change reverted, because reverting removes
  // preservation entirely. It is here because the preservation must not become "the same secret on
  // every install" — two independent first installs have to differ, or one leaked .env is every
  // instance's .env.
  const source = await readScript()
  const one = await runInstaller(source, await appDirectory(), 'INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=')
  const two = await runInstaller(source, await appDirectory(), 'INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=')

  assert.notEqual(one.AUTH_SECRET, two.AUTH_SECRET)
  assert.notEqual(one.SETTINGS_ENCRYPTION_KEY, two.SETTINGS_ENCRYPTION_KEY)
  assert.notEqual(one.CRON_SECRET, two.CRON_SECRET)
  assert.equal(one.REDIS_URL, 'redis://localhost:6379', 'and a first install with no password still gets a bare URL')
})

test('an explicit value given to a re-run still wins over the preserved one', async () => {
  // Preservation is a DEFAULT, not a lock. An operator rotating the Redis password must still be able
  // to, or the mechanism that stops the installer breaking an install becomes one that stops it fixing
  // one.
  const source = await readScript()
  const appDir = await appDirectory()

  await runInstaller(
    source,
    appDir,
    `INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )
  const rotated = await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=rotated')

  assert.equal(rotated.REDIS_URL, 'redis://:rotated@localhost:6379')
  assert.equal(rotated.REDIS_PASSWORD, '')

  // And the rotation is what the NEXT run then preserves, so a rotation is not silently undone by the
  // run after it. This is also what stops the assertions above passing vacuously: with preservation
  // removed there is nothing to carry `rotated` forward and this comes back as a bare URL.
  const afterRotation = await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379')
  assert.equal(afterRotation.REDIS_URL, 'redis://:rotated@localhost:6379')
})

test('a preserved credential is never echoed as a prompt default', async () => {
  // A default is printed in brackets, and an install is routinely run under `script`, `tee` or a
  // provisioning log. Recovering the credential to keep it must not put it somewhere new.
  const source = await readScript()
  const appDir = await appDirectory()
  await runInstaller(
    source,
    appDir,
    `INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )

  // Rendered through a pty, because `read -p` only displays its prompt when stdin is a terminal — and
  // the prompt line IS the artefact under test. Every answer is empty (the pty reaches EOF), so what is
  // captured is the defaults exactly as an operator pressing Enter would see them.
  const rig = path.join(await appDirectory(), 'render-prompts.sh')
  await writeFile(
    rig,
    `
      set -euo pipefail
      NON_INTERACTIVE=false
      BOLD=''; RESET=''; YELLOW=''
      info() { :; }
      warn() { echo "WARN: $*" >&2; }
      die() { echo "DIE: $*" >&2; exit 9; }
      APP_DIR=${JSON.stringify(appDir)}
      ${source.includes('declare -A EXISTING_ENV=()') ? 'declare -A EXISTING_ENV=()' : ''}
      ${sliceOptionalBlock(source, 'urlencode() {') ?? ''}
      ${sliceOptionalBlock(source, 'urldecode() {') ?? ''}
      ${sliceOptionalBlock(source, 'mask_secret() {') ?? ''}
      ${sliceOptionalBlock(source, 'redact_url_credentials() {') ?? ''}
      ${sliceOptionalBlock(source, 'load_existing_env() {') ?? ''}
      ${sliceOptionalBlock(source, 'existing_env() {') ?? ''}
      ${sliceOptionalBlock(source, 'prompt() {') ?? ''}
      ${sliceOptionalBlock(source, 'prompt_yn() {') ?? ''}
      load_existing_env "\${APP_DIR}/.env"
      ${sliceRange(source, 'prompt_yn INSTALL_REDIS', 'info "--- WooCommerce')}
    `,
    'utf8',
  )
  const shown = await renderOnPty(`bash ${rig}`)
  // The preconditions matter: without them this passes trivially on a version that preserves nothing,
  // because there would be no credential to leak in the first place.
  assert.match(shown, /Redis URL[^\n]*\[redis:\/\/\*\*\*@localhost:6379\]/, 'precondition: a preserved URL was offered as the default, redacted')
  assert.match(shown, /Redis password[^\n]*\[unchanged\]/, 'precondition: a preserved password was offered as the default, masked')
  assert.ok(!shown.includes(AWKWARD_PASSWORD), 'the preserved password was printed in cleartext')
  assert.ok(
    !shown.includes('p%40ss'),
    'the preserved URL was printed with its credential — redact the default, do not print the encoded secret either',
  )
})
