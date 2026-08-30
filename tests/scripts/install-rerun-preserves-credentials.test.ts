import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access, chmod, constants, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
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
import { createTempDir } from './temp-dir.ts'

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

/**
 * WHERE THE `.env` WRITE BEGINS, IN EITHER SHAPE OF THE SCRIPT (o3d-2sm1.5 r38).
 *
 * The heredoc used to be four straight-line statements; r38 wrapped it in write_app_env_file() so
 * that a credential rotation performed after the stop can re-write the file install.sh owns
 * instead of reading a file the application account owns. These two helpers keep this rig bounded
 * by lines that exist in BOTH shapes — which is the property the slicing here is built on, so that
 * reverting the change under test runs the OLD code and this file fails on what the second run
 * PRODUCED rather than on a marker that moved.
 */
function envWriteStartMarker(source: string): string {
  // r39 split the writer in two: render_app_env_file() holds the heredoc and write_app_env_file()
  // publishes its output durably. The RENDER is what this file is about, and it is the earlier of
  // the two, so it is the boundary the preceding slice must stop at.
  if (source.includes('render_app_env_file() {')) return 'render_app_env_file() {'
  return source.includes('write_app_env_file() {') ? 'write_app_env_file() {' : 'cat > "${APP_DIR}/.env"'
}

/**
 * The write itself: the shipped renderer plus a redirect, the shipped function plus its call, or
 * the bare statements that preceded either.
 *
 * WHAT THIS RIG IS ABOUT IS THE CONTENT, and it says so in three shapes of the script. r38 wrapped
 * the heredoc in write_app_env_file(); r39 (Codex HIGH) split THAT into render_app_env_file(),
 * which produces the bytes from held variables, and write_app_env_file(), which publishes them by
 * rename with ownership and mode applied before the rename. Ownership is exactly what this rig
 * cannot exercise — it runs as an ordinary user with no APP_USER to give a file to — so it takes
 * the renderer and redirects it, the same way the pre-r38 slice dropped the chown/chmod pair.
 *
 * The publication half is asserted where it can be: install-credential-representation.test.ts
 * proves the rename by hard link and asserts the mode, and install-credential-preservation.test.ts
 * checks the mode after a rotation.
 */
function envWriteBlock(source: string): string {
  const rendered = sliceOptionalBlock(source, 'render_app_env_file() {')
  if (rendered !== null) return `${rendered}\nrender_app_env_file > "\${APP_DIR}/.env"`
  const wrapped = sliceOptionalBlock(source, 'write_app_env_file() {')
  if (wrapped !== null) {
    const body = wrapped.split('\n').filter((line) => !/^\s*(chown|chmod) /.test(line))
    return `${body.join('\n')}\nwrite_app_env_file`
  }
  return sliceRange(source, 'cat > "${APP_DIR}/.env" <<EOF', 'chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"')
}

/**
 * THE SENTINEL AND THE CAPTURE PRIMITIVE, OPTIONALLY (o3d-2sm1.5 r40, Codex HIGH).
 *
 * The Redis recovery this file exercises now reads its userinfo through the shipped `capture`,
 * because command substitution deletes a trailing newline out of a credential. Both are lifted
 * OPTIONALLY, like every other slice here: reverting r40 removes them from install.sh and this rig
 * then runs the old code and fails on what the second run PRODUCED, which is the property the
 * slicing is built on.
 */
function captureTerminatorAssignment(source: string): string {
  return /^CAPTURE_TERMINATOR=.*$/m.exec(source)?.[0] ?? ''
}

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
    ${captureTerminatorAssignment(source)}
    ${sliceOptionalBlock(source, 'capture() {') ?? ''}
    ${sliceOptionalBlock(source, 'urlencode() {') ?? ''}
    ${sliceOptionalBlock(source, 'urldecode() {') ?? ''}
    ${sliceOptionalBlock(source, 'mask_secret() {') ?? ''}
    ${sliceOptionalBlock(source, 'redact_url_credentials() {') ?? ''}
    ${sliceOptionalBlock(source, 'redis_url_credential_state() {') ?? ''}
    ${sliceOptionalBlock(source, 'load_existing_env() {') ?? ''}
    ${sliceOptionalBlock(source, 'unquote_env_value() {') ?? ''}
    ${sliceOptionalBlock(source, 'existing_env() {') ?? ''}
    ${sliceOptionalBlock(source, 'require_preserved_secrets() {') ?? ''}
    ${sliceOptionalBlock(source, 'prompt() {') ?? ''}
    ${sliceOptionalBlock(source, 'prompt_yn() {') ?? ''}
    ${source.includes('\nload_existing_env "${APP_DIR}/.env"') ? 'load_existing_env "${APP_DIR}/.env"' : ''}
    ${env}
    ${sliceRange(source, 'prompt_yn INSTALL_REDIS', 'info "--- WooCommerce')}
    ${sliceRange(source, 'AUTH_SECRET=', envWriteStartMarker(source))}
    ${envWriteBlock(source)}
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
  const dir = await createTempDir('ims-rerun-conf-')
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
  return createTempDir('ims-install-rerun-')
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
      ${captureTerminatorAssignment(source)}
      ${sliceOptionalBlock(source, 'capture() {') ?? ''}
      ${sliceOptionalBlock(source, 'urlencode() {') ?? ''}
      ${sliceOptionalBlock(source, 'urldecode() {') ?? ''}
      ${sliceOptionalBlock(source, 'mask_secret() {') ?? ''}
      ${sliceOptionalBlock(source, 'redact_url_credentials() {') ?? ''}
      ${sliceOptionalBlock(source, 'redis_url_credential_state() {') ?? ''}
      ${sliceOptionalBlock(source, 'load_existing_env() {') ?? ''}
      ${sliceOptionalBlock(source, 'unquote_env_value() {') ?? ''}
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

// ---------------------------------------------------------------------------
// o3d-l89a r4 (Codex r3 finding 2) — A FILE WE CANNOT READ IS NOT A FILE WITH NO SECRETS.
//
// Round 3 preserved the three secrets that cannot be re-minted, and the preservation is only as
// strong as what happens when the read does not succeed. `[[ -f ]] || return 0` answered "no
// previous install" for a path this script could not read at all, and a `.env` that WAS read but was
// truncated or hand-edited answered "this key is not present" — identically to a first install.
// Both routed straight back to minting, and a new SETTINGS_ENCRYPTION_KEY makes every encrypted
// Setting already in the database permanently undecryptable. The install "succeeds".
// ---------------------------------------------------------------------------

/** Load an existing .env and report what the loader concluded, running the SHIPPED functions. */
async function loadEnvState(
  source: string,
  appDir: string,
  options: { asNobody?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  const script = `
    set -euo pipefail
    warn() { echo "WARN: $*" >&2; }
    die() { echo "DIE: $*" >&2; exit 9; }
    APP_DIR=${JSON.stringify(appDir)}
    declare -A EXISTING_ENV=()
    ${sliceOptionalBlock(source, 'load_existing_env() {') ?? 'load_existing_env() { :; }'}
    ${sliceOptionalBlock(source, 'unquote_env_value() {') ?? ''}
    ${sliceOptionalBlock(source, 'existing_env() {') ?? ''}
    load_existing_env "\${APP_DIR}/.env"
    printf 'STATE<<<%s>>>\\n' "\${ENV_FILE_STATE:-__ABSENT__}"
    printf 'KEY<<<%s>>>\\n' "$(existing_env SETTINGS_ENCRYPTION_KEY '__WOULD_MINT__')"
  `
  // A permission bit means nothing to root, and these tests run as root. `setpriv` drops to `nobody`
  // so the readability branch is exercised for real rather than asserted from the source text.
  return options.asNobody
    ? execFileAsync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'bash', '-c', script])
    : execFileAsync('bash', ['-c', script])
}

test('o3d-l89a r4: a truncated .env REFUSES rather than minting a fresh SETTINGS_ENCRYPTION_KEY', async () => {
  // What an interrupted write, a full disk, or a hand-edit leaves behind. Every key it DOES have is
  // read back correctly, which is exactly why the missing one is so easy to miss.
  const source = await readScript()
  const appDir = await appDirectory()
  const first = await runInstaller(
    source,
    appDir,
    `INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=${JSON.stringify(AWKWARD_PASSWORD)}`,
  )
  assert.ok(first.SETTINGS_ENCRYPTION_KEY, 'precondition: the first install minted one')

  const truncated = (await readFile(path.join(appDir, '.env'), 'utf8'))
    .split('\n')
    .filter((line) => !line.startsWith('SETTINGS_ENCRYPTION_KEY='))
    .join('\n')
  await writeFile(path.join(appDir, '.env'), truncated, 'utf8')

  let stderr = ''
  try {
    await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379')
    throw new assert.AssertionError({
      message:
        'the re-run MINTED a fresh SETTINGS_ENCRYPTION_KEY over a database encrypted with the old one. '
        + 'Every encrypted Setting — Xero tokens, connector secrets — is now permanently undecryptable, '
        + 'and the install reported success',
    })
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    stderr = String((error as { stderr?: string }).stderr ?? error)
  }

  assert.match(stderr, /DIE: .*does not carry SETTINGS_ENCRYPTION_KEY/)
  assert.match(stderr, /permanently undecryptable/, 'the refusal says what it is protecting')
  assert.match(stderr, /IMS_INSTALL_REMINT_SECRETS=yes/, 'and it names the way forward, so it is not a dead end')

  // And the file it refused over is untouched.
  const after = await readFile(path.join(appDir, '.env'), 'utf8')
  assert.equal(after, truncated, 'nothing was written on the refusal path')
})

test('o3d-l89a r4: the refusal is escapable, deliberately and loudly', async () => {
  const source = await readScript()
  const appDir = await appDirectory()
  await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=hunter2')
  const truncated = (await readFile(path.join(appDir, '.env'), 'utf8'))
    .split('\n')
    .filter((line) => !line.startsWith('AUTH_SECRET='))
    .join('\n')
  await writeFile(path.join(appDir, '.env'), truncated, 'utf8')

  const { values, stderr } = await runInstallerCapturing(
    source,
    appDir,
    'IMS_INSTALL_REMINT_SECRETS=yes; INSTALL_REDIS=y; REDIS_PORT=6379',
  )

  assert.ok(values.AUTH_SECRET, 'the escape hatch really does mint')
  assert.match(stderr, /WARN: IMS_INSTALL_REMINT_SECRETS=yes/, 'and it says out loud what it just destroyed')
  assert.match(stderr, /every existing session is invalidated/)
})

test('o3d-l89a r4: an UNREADABLE .env refuses instead of reading as "no previous install"', async () => {
  const source = await readScript()
  const appDir = await appDirectory()
  await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379; REDIS_PASSWORD=hunter2')
  await chmod(path.join(appDir, '.env'), 0o600)
  // The directory has to be traversable or the read fails for a different reason than the one under
  // test; the FILE is what `nobody` may not open.
  await chmod(appDir, 0o755)

  const dropped = await execFileAsync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'true'])
    .then(() => true, () => false)
  const stillReadable = dropped
    ? false
    : await access(path.join(appDir, '.env'), constants.R_OK).then(() => true, () => false)
  if (!dropped && stillReadable) {
    // No way to drop privilege here. Assert the SHAPE instead: the loader must consult readability
    // rather than answering "absent".
    assert.match(
      sliceOptionalBlock(source, 'load_existing_env() {') ?? '',
      /! -r "\$\{file\}"/,
      'the loader must test readability; without it an unreadable .env answers "no previous install"',
    )
    return
  }

  let stderr = ''
  try {
    await loadEnvState(source, appDir, { asNobody: true })
    throw new assert.AssertionError({
      message: 'an unreadable .env was treated as absent, which routes the run straight back to minting',
    })
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    stderr = String((error as { stderr?: string }).stderr ?? error)
  }
  assert.match(stderr, /DIE: .*not readable/)
  assert.ok(!/STATE<<<absent>>>/.test(stderr), 'and it did NOT conclude that there is no previous install')
})

test('o3d-l89a r4: a DIRECTORY (or a dangling symlink) at the .env path refuses rather than minting', async () => {
  const source = await readScript()
  const appDir = await appDirectory()
  await mkdir(path.join(appDir, '.env'))

  let stderr = ''
  try {
    await loadEnvState(source, appDir)
    throw new assert.AssertionError({ message: 'a directory at the .env path was treated as absent' })
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    stderr = String((error as { stderr?: string }).stderr ?? error)
  }
  assert.match(stderr, /DIE: .*is not a regular file/)

  const dangling = await appDirectory()
  await symlink(path.join(dangling, 'nowhere'), path.join(dangling, '.env'))
  let danglingStderr = ''
  try {
    await loadEnvState(source, dangling)
    throw new assert.AssertionError({ message: 'a dangling symlink at the .env path was treated as absent' })
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    danglingStderr = String((error as { stderr?: string }).stderr ?? error)
  }
  assert.match(danglingStderr, /DIE: .*is not a regular file/, '`-e` is false for a dangling symlink, which is why the loader tests `-L` too')
})

test('o3d-l89a r4: a genuinely absent .env still mints — the refusal must not block a first install', async () => {
  // The control. Without it the fix above could be "refuse always", which is a different outage.
  const source = await readScript()
  const appDir = await appDirectory()

  const { stdout } = await loadEnvState(source, appDir)

  assert.match(stdout, /STATE<<<absent>>>/)
  assert.match(stdout, /KEY<<<__WOULD_MINT__>>>/, 'a first install has nothing to preserve, and minting there is correct')
})

test('a re-run keeps the privileged cutover connection it never minted', async () => {
  // o3d-2sm1.3 — the installer now performs a fenced cutover when it finds an existing
  // installation, and a real connection fence needs DEPLOY_ADMIN_DATABASE_URL. Nothing
  // prompts for it and nothing mints it: an operator sets it deliberately as a role
  // separate from the application's. The heredoc rewrites .env whole, so a value this
  // script does not carry forward is one a re-run silently deletes — and the cost of that
  // is not visible, because the NEXT upgrade simply falls back to the snapshot probe.
  const source = await readScript()
  const appDir = await appDirectory()
  const admin = 'postgresql://deployadmin:pw@localhost:5432/one_two_inventory'

  const first = await runInstaller(
    source,
    appDir,
    `INSTALL_REDIS=y; REDIS_PORT=6379; DEPLOY_ADMIN_DATABASE_URL=${JSON.stringify(admin)}`,
  )
  assert.equal(first.DEPLOY_ADMIN_DATABASE_URL, admin, 'precondition: the first run wrote it')

  const second = await runInstaller(source, appDir, 'INSTALL_REDIS=y; REDIS_PORT=6379')
  assert.equal(second.DEPLOY_ADMIN_DATABASE_URL, admin, 'the re-run dropped the cutover admin connection')

  const third = await runInstaller(
    source,
    appDir,
    'INSTALL_REDIS=y; REDIS_PORT=6379; DEPLOY_ADMIN_DATABASE_URL=postgresql://other@localhost/x',
  )
  assert.equal(third.DEPLOY_ADMIN_DATABASE_URL, 'postgresql://other@localhost/x', 'an explicit value must still win')
})
