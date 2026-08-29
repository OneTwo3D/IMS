/**
 * THE SHELL RIG THE INSTALLER REGRESSIONS RUN THE SHIPPED FUNCTIONS IN (o3d-2sm1.5 r39).
 *
 * Extracted from tests/scripts/install-credential-preservation.test.ts, unchanged except for the
 * exports and for what r39 added to it, so that the credential-REPRESENTATION regressions run the
 * shipped bytes in exactly the same shell rather than carrying a second copy of it. A second copy
 * is how two files come to disagree about what install.sh does.
 *
 * It is NOT a `.test.ts` file, so the runner's `tests/**\/*.test.ts` glob does not execute it.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Cluster, cleanLibpqEnv, currentUser, shippedFunction } from './real-postgres-cluster.ts'

export const REPO = process.cwd()
export const INSTALL_SOURCE = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')

/**
 * Everything the credential decision is made of, lifted whole out of the shipped script.
 *
 * classify_database_credential_rotation() is in this list because r38 turned four straight-line
 * statements into a function precisely so that it could be: a regression that re-implements the
 * ordering it is checking proves only that its author can write the ordering twice.
 */
export const SHIPPED = [
  // r40 (Codex HIGH): the sentinel that keeps a trailing newline out of the shell's teeth. Every
  // credential on the recovery path crosses it, so a test that captured through a plain `$( )`
  // would be measuring bash rather than install.sh.
  'capture',
  'libpq_env_unset_args',
  'db_local_socket_dir',
  'pg_local_psql',
  'pg_endpoint_psql',
  'unquote_env_value',
  'existing_env',
  'load_existing_env',
  'mask_secret',
  'prompt',
  // r39 (Codex HIGH): the two grammars the one password travels through, and the composer both
  // writers go through. They are lifted rather than re-implemented for the same reason
  // classify_database_credential_rotation() is: a test that writes its own percent-encoder proves
  // that its author can write a percent-encoder.
  'sql_quote_literal',
  'url_encode_userinfo',
  'url_decode_userinfo',
  'compose_database_url',
  'installed_database_password',
  // r39 (Codex HIGH): the durable mechanism, and the journal that makes the ALTER recoverable.
  'fsync_path',
  'publish_durable_file',
  'rotation_journal_encode',
  'rotation_journal_decode',
  'role_rotation_journal_value',
  'role_rotation_identity',
  'write_role_rotation_journal',
  'clear_role_rotation_journal',
  // r40 (Codex HIGH): the probe that has to prove it can say NO before anything believes its YES.
  'db_endpoint_accepts_password',
  'db_endpoint_is_password_sensitive',
  'db_probe_endpoint_candidates',
  'resolve_live_role_password',
  'reconcile_interrupted_role_rotation',
  'resolve_role_rotation_journal_after_env_publication',
  'prompt_db_password',
  'ensure_database_role_exists',
  'classify_database_credential_rotation',
  'provision_database_role_and_privileges',
  'render_app_env_file',
  'write_app_env_file',
  'rotate_database_password_in_fenced_window',
]
  .map((name) => shippedFunction(INSTALL_SOURCE, name))
  .join('\n')

/**
 * EVERY VARIABLE THE `.env` HEREDOC INTERPOLATES, DEFAULTED TO ITSELF-OR-EMPTY.
 *
 * write_app_env_file() is lifted whole, and it names two dozen values this rig has no opinion
 * about. Listing them by hand is a list that goes stale the next time a line is added to the
 * file, and under `set -u` a stale list is a test that dies rather than one that fails usefully.
 * So they are READ OUT of the shipped function: `NAME="${NAME-}"` leaves anything this rig did
 * set alone, and gives everything else the empty value the heredoc would have written anyway.
 */
/**
 * THE SENTINEL, LIFTED RATHER THAN RETYPED (r40).
 *
 * `capture()` strips whatever CAPTURE_TERMINATOR holds. A rig that declared its own copy would
 * pass every test while install.sh used a different string — the two would only disagree in
 * production, which is the exact shape of failure this whole file exists to make impossible.
 */
export const CAPTURE_TERMINATOR_ASSIGNMENT = (() => {
  const match = /^CAPTURE_TERMINATOR=.*$/m.exec(INSTALL_SOURCE)
  assert.ok(match, 'precondition: scripts/install.sh must define CAPTURE_TERMINATOR')
  return match[0]
})()

export const ENV_HEREDOC_DEFAULTS = [
  ...new Set(
    [...shippedFunction(INSTALL_SOURCE, 'render_app_env_file').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g)]
      .map((match) => match[1]),
  ),
]
  .map((name) => `${name}="\${${name}-}"`)
  .join('\n')

export interface Run {
  readonly status: number
  readonly output: string
}

/** The shipped functions, in a shell given exactly the variables install.sh gives them. */
export function runShipped(vars: Record<string, string>, body: string): Run {
  const assignments = Object.entries(vars)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')
  const script = `
exec 2>&1
set -uo pipefail
success() { echo "OK: $*"; }
warn()    { echo "WARN: $*"; }
info()    { echo "INFO: $*"; }
header()  { echo "HEADER: $*"; }
error()   { echo "ERROR: $*" >&2; }
die()     { error "$*"; exit 9; }
# install.sh runs the local statements as the postgres OS user; here the cluster belongs to
# whoever is running the tests, so the privilege transition is the identity function.
run_as_user() { shift; "$@"; }
BOLD=""
RESET=""
NON_INTERACTIVE=true
INSTALL_POSTGRES=y
APP_NAME="one-two-inventory"
DATABASE_URL=""
DB_ROLE_PREEXISTED=false
DB_ROLE_CREDENTIALS_ROTATED=false
DB_PASSWORD_INSTALLED=""
DB_PASSWORD_EFFECTIVE=""
DB_PASSWORD_ROTATION_PENDING=false
DB_FENCE_UP=false
FENCE_ARMED=false
ENV_FILE_STATE=absent
DB_ROTATION_JOURNAL_FOUND=false
DB_ROTATION_RECONCILED_PASSWORD=""
DB_ROTATION_RECONCILED_WHICH=""
DB_ROTATION_PROBE_DATABASE=""
DB_PROBE_REPORT=""
${CAPTURE_TERMINATOR_ASSIGNMENT}
declare -A EXISTING_ENV=()
${assignments}
# r39: the interrupted-rotation journal, resolved AFTER the caller's assignments because it hangs
# off APP_DIR. In the shipped script it lives under /etc/ims-cutover — root-owned and 0700, because
# the cutover state directory is writable by the application account; here it gets a private
# directory of this run's own, for the same reason the clusters get one. Every test therefore has a
# WORKING journal path without asking for it, which is what production has: a rotation that cannot
# journal REFUSES, so a rig with no path would quietly be testing that refusal instead.
DB_ENV_SNAPSHOT_DIR="\${DB_ENV_SNAPSHOT_DIR:-\${APP_DIR}/cutover-private}"
DB_ROLE_ROTATION_JOURNAL="\${DB_ROLE_ROTATION_JOURNAL:-\${DB_ENV_SNAPSHOT_DIR}/db-role-rotation.journal}"
${ENV_HEREDOC_DEFAULTS}
${SHIPPED}
${body}
`
  const env = cleanLibpqEnv()
  try {
    return {
      status: 0,
      output: execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

// ---------------------------------------------------------------------------
// A client that is CONNECTED ALREADY, and stays connected across the run
// ---------------------------------------------------------------------------

export interface HeldSession {
  alive(): boolean
  finish(): Promise<{ code: number | null; stdout: string; stderr: string }>
}

/**
 * The predecessor, modelled as what it actually is: a process that authenticated BEFORE the
 * installer started and goes on issuing statements while it runs.
 *
 * psql reading its script from a pipe executes each statement as it arrives, so the session is
 * genuinely open for the whole of the installer run rather than being opened and closed around
 * it. It is not enough on its own — an already-authenticated backend survives an ALTER USER, and
 * that is exactly why the finding is about NEW connections — so every test that holds one also
 * opens a fresh connection afterwards.
 */
export async function holdSession(cluster: Cluster, user: string, password: string, database: string): Promise<HeldSession> {
  const env = cleanLibpqEnv()
  env.PGPASSWORD = password
  const child = spawn('psql', [
    '-X', '-w', '-q', '-tA', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', String(cluster.port), '-U', user, '-d', database,
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  let exited = false
  let code: number | null = null
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.on('exit', (status) => { exited = true; code = status })

  child.stdin.write("SELECT 'session-opened';\n")
  const deadline = Date.now() + 15_000
  while (!stdout.includes('session-opened')) {
    if (exited) throw new Error(`the held session never opened (exit ${code}): ${stdout}${stderr}`)
    if (Date.now() > deadline) throw new Error(`the held session did not answer in time: ${stdout}${stderr}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return {
    alive: () => !exited,
    async finish() {
      if (!exited) {
        child.stdin.write("SELECT 'still-authenticated';\n")
        child.stdin.end()
        await new Promise<void>((resolve) => {
          if (exited) resolve()
          else child.on('exit', () => resolve())
        })
      }
      return { code, stdout, stderr }
    },
  }
}

/** The `.env` a previous run of this installer left behind. */
export function writeInstalledEnv(appDir: string, port: number, password: string): string {
  const contents = [
    '# One Two Inventory — generated by install.sh',
    'NODE_ENV=production',
    'APP_PORT=3000',
    'AUTH_SECRET=an-auth-secret',
    'SETTINGS_ENCRYPTION_KEY=a-settings-key',
    'CRON_SECRET=a-cron-secret',
    '',
    `DATABASE_URL=postgresql://imsuser:${password}@127.0.0.1:${port}/one_two_inventory`,
    // IN THE SAME FILE ON PURPOSE. It ends in the same fourteen characters as the line above, so
    // an unanchored match rewrites the deploy admin's credential too — and that is the connection
    // the fence itself is held with.
    `DEPLOY_ADMIN_DATABASE_URL=postgresql://deployadmin:admin-password@127.0.0.1:${port}/one_two_inventory`,
    'NEXT_PUBLIC_APP_URL=https://ims.example.test',
    '',
  ].join('\n')
  const path = join(appDir, '.env')
  writeFileSync(path, contents)
  chmodSync(path, 0o600)
  return contents
}

/** The connection the BUILD is handed, opened the way the build opens it. */
export function connectAs(cluster: Cluster, url: string): string {
  const match = /^postgresql:\/\/([^:]+):(.*)@([^@/]+):(\d+)\/(.+)$/.exec(url)
  assert.ok(match, `the composed DATABASE_URL must state role, password, host, port and database: ${url}`)
  const [, user, password, host, port, database] = match
  assert.equal(port, String(cluster.port), 'the URL must name the cluster under test')
  return cluster.psql(['-c', "SELECT 'build-connected'"], { host, user, password, database })
}

/** The DATABASE_URL the installer's own writer put into a file, read back the way dotenv does. */
export function envDatabaseUrl(dir: string, file = '.env'): string {
  const contents = readFileSync(join(dir, file), 'utf8')
  const match = /^DATABASE_URL=(.*)$/m.exec(contents)
  assert.ok(match, `the written environment file must state DATABASE_URL:\n${contents}`)
  return match[1]
}

export function readVar(output: string, name: string): string {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(output)
  assert.ok(match, `the run must print ${name}=:\n${output}`)
  return match[1]
}

export const REINSTALL_BODY = `
  load_existing_env "\${APP_DIR}/.env"
  prompt_db_password
  ensure_database_role_exists
  classify_database_credential_rotation
  provision_database_role_and_privileges
  write_app_env_file
  echo "COMPOSED_URL=\${DATABASE_URL}"
  echo "ROLE_PREEXISTED=\${DB_ROLE_PREEXISTED}"
  echo "ROTATION_PENDING=\${DB_PASSWORD_ROTATION_PENDING}"
  echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
`

/** The live installation the fence exists for: a role somebody is using, a database it owns. */
export function seedLiveInstallation(cluster: Cluster): void {
  cluster.psql(['-c', "CREATE ROLE imsuser LOGIN PASSWORD 'live-password'"])
  cluster.psql(['-c', 'CREATE DATABASE one_two_inventory OWNER imsuser'])
}
