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
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

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
  // r43 (Codex HIGH): the route the APPLICATION takes, derived from the composer rather than
  // asserted, and the reference every probe is now aligned to.
  //
  // r44 (Codex HIGH): and the half of the driver's configuration the URL does not carry. The bus
  // reader is lifted with it because db_application_route_env_refusal() goes through the SHIPPED
  // unit scan rather than through a second reader of its own -- which is the finding r44 answers,
  // so a rig that stubbed the scan would be measuring the defect rather than the fix.
  //
  // r45 (Codex HIGH x2, MEDIUM): the transport stops being a survey of the unit and becomes two
  // PROPERTIES of it -- an UnsetEnvironment= directive systemd applies last, and an ExecStart=
  // that is exactly what the installer wrote -- plus a supported way to ASK for TLS. All of it is
  // lifted for the same reason the rest is: a rig that re-implemented the directive check would
  // be proving that its author can write the directive check.
  'bus_read_strings',
  'bus_array_count',
  'bus_unit_property',
  'bus_element_names_variable',
  'bus_read_env_ignore_flags',
  'bus_unit_object',
  'unit_env_var_sole_source',
  'unit_route_env_guaranteed',
  'unit_execstart_is_exactly',
  'db_service_execstart_expected',
  'db_route_env_variables',
  'db_route_env_alternative',
  'db_route_env_effect',
  'db_application_route_env_refusal',
  'db_sslmode_is_supported',
  'db_sslmode_is_cleartext',
  'db_url_route_query',
  // r46 (Codex MEDIUM): the trust root stops being a pathname that is passed around and becomes
  // BYTES published at one root-owned path every principal can open. Lifted for the same reason
  // publish_durable_file() is: a rig that re-implemented the publication would be proving that its
  // author can re-implement the publication.
  'file_sha256',
  'db_ca_path_is_open_to_every_uid',
  // r47 (Codex HIGH x2): the parser that decides what may be published, the generation name derived
  // from what was published, and the prune that decides what survives. Lifted for the same reason:
  // a rig that re-implemented the PEM walk would be proving that its author can walk a PEM file,
  // and a rig that re-implemented the generation name would agree with itself and with nothing else.
  'db_ca_pem_label_encoding',
  'normalize_db_ca_pem',
  'db_ca_generation_file',
  'db_ca_generation_digest',
  'publish_db_ca',
  'prune_db_ca_generations',
  'verify_db_ca_published',
  'db_application_route_sslmode',
  'installed_database_password',
  'installed_database_sslmode',
  'installed_database_sslrootcert',
  'prompt_db_sslmode',
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
  // r41 (Codex HIGH): and, before either, the question of WHOSE password the endpoint checks —
  // asked of the server, answered by the shipped reader, and lifted here rather than modelled.
  'db_endpoint_accepts_password',
  'db_auth_request_probe_path',
  'db_endpoint_checks_role_verifier',
  'db_endpoint_discriminates_passwords',
  'db_endpoint_is_password_sensitive',
  'db_connectable_databases_except_app',
  'db_unfenced_probe_candidates',
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

/**
 * THE CA PUBLISHER'S OWN TOP-LEVEL ASSIGNMENTS, LIFTED IN SOURCE ORDER (o3d-2sm1.5 r47).
 *
 * `shippedFunction()` lifts functions; these are the four literals the lifted functions READ —
 * the PEM labels a trust root may contain (r48: three, measured, not one), the two halves of the
 * generation name, and how many superseded generations survive a prune — plus the refusal advice
 * both `die`s on the CA path quote.
 * A rig that declared its own copies would agree with itself and with nothing else: the accept-list
 * is the whole of the disclosure fix, and the generation name is the whole of the overwrite fix.
 */
export const DB_CA_ASSIGNMENTS = [
  'DB_CA_ACCEPTED_PEM_LABELS',
  'DB_CA_GENERATION_PREFIX',
  'DB_CA_GENERATION_SUFFIX',
  'DB_CA_GENERATIONS_RETAINED',
  'DB_CA_REFRESH_FAILURE_ADVICE',
]
  .map((name) => {
    const match = new RegExp(`^${name}=.*$`, 'm').exec(INSTALL_SOURCE)
    assert.ok(match, `precondition: scripts/install.sh must define ${name} at top level`)
    return match[0]
  })
  .join('\n')

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

/**
 * How a caller reaches the script from OUTSIDE it (o3d-2sm1.5 r46, Codex HIGH).
 *
 * `env` is the PROCESS environment the shell is started with, and `argv` is what lands in `$1`.
 * They exist because the r46 finding is unreachable through `vars`: those are assignments the rig
 * makes INSIDE the shell, and the defect was install.sh overwriting the caller's exported value
 * before it ever read it. Only a value that is in the environment when bash starts can prove that
 * the declarations at the top of the script preserved it.
 */
export interface RunOptions {
  readonly env?: Record<string, string>
  readonly argv?: readonly string[]
}

/** The shipped functions, in a shell given exactly the variables install.sh gives them. */
export function runShipped(vars: Record<string, string>, body: string, options: RunOptions = {}): Run {
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
INSTALL_POSTGRES="\${INSTALL_POSTGRES-y}"
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
# r42 (Codex HIGH): the route the reader observed, and the endpoint it observed it on. Declared
# here for the same reason every other global is: the shipped FUNCTIONS are lifted, the assignments
# beside them are not, and \`set -u\` turns a missing one into a dead shell rather than a red test.
DB_PROBE_ROUTE_DATABASE=""
DB_PROBE_SSLMODE=""
DB_ENDPOINT_ROUTE_SSLMODE=""
DB_ENDPOINT_ROUTE_SSLROOTCERT=""
# r45 (Codex MEDIUM): the transport is a deployment input now, so it is a variable the shipped
# functions read. \`disable\` is what every test that says nothing about TLS means, and it is what
# install.sh's own INSTALL_POSTGRES=y branch sets; the TLS tests override it through \`vars\`.
#
# r46 (Codex HIGH): AND THE DEFAULT DEFERS TO THE PROCESS ENVIRONMENT, because that is what the
# finding is about. install.sh's own declarations capture DB_SSLMODE from the environment before
# erasing it, so a rig that ASSIGNED the variable here would overwrite the caller's input exactly
# as the defect did and no entrypoint test could ever see past it. \`-\` and not \`:-\`, so a test
# that supplies an EMPTY value is supplying one.
DB_SSLMODE="\${DB_SSLMODE-disable}"
DB_SSLROOTCERT="\${DB_SSLROOTCERT-}"
# r46 (Codex MEDIUM): the owner the published trust root is given. In install.sh this is the
# literal \`root:root\`; a rig running as an ordinary user has no root to give a file to, so it
# publishes to itself and still measures the digest, the mode and who can open the result.
DB_CA_PUBLISH_OWNER="\${DB_CA_PUBLISH_OWNER:-\$(id -un):\$(id -gn)}"
DB_CA_PUBLISHED_DIGEST="\${DB_CA_PUBLISHED_DIGEST-}"
UNIT_EXECSTART_REASON=""
ENV_ROUTE_GUARANTEE_REASON=""
BUS_UNIT_OBJECT=""
DB_ROUTE_DROPIN_NAME=zz-deploy-db-route.conf
APP_PORT=3000
# r44 (Codex HIGH): what the SHIPPED unit scan needs to exist, for the same reason as everything
# else in this block -- the functions are lifted, the assignments beside them are not.
#
# The unit name the scan is given is \`\${APP_NAME}.service\`, which on this host is
# \`one-two-inventory.service\` and is NOT a unit systemd has. Since r45 that is a REFUSAL rather
# than a pass on the transport question too -- the guarantee is a property of a loaded unit, and a
# unit systemd does not have carries no property. Every route check that must SUCCEED is therefore
# measured against a STUBBED busctl, where the renderings are systemd's own, taken off this host.
BUS_STRINGS=()
BUS_ENV_IGNORE_FLAGS=()
ENV_VAR_SOURCE_REASON=""
DB_ENV_SNAPSHOT_FILE=/var/lib/one-two-inventory/deploy/db-identity.env
DB_ENV_SNAPSHOT_DROPIN_NAME=zz-deploy-db-identity.conf
DB_ENV_SNAPSHOT_PUBLISHED=false
DB_IDENTITY_REQUIRE_SNAPSHOT=false
# r41 (Codex HIGH): THE SHIPPED READER, at its real path.
#
# In install.sh this resolves from \${IMS_SCRIPT_LIB_DIR}, which is derived from BASH_SOURCE — and
# these functions are run outside the shipped file, so there is no BASH_SOURCE to derive it from.
# It is pointed at the repository's own copy so the tests execute the SHIPPED BYTES; a rig that
# defaulted to nothing would have every test silently measuring the 'reader is missing' refusal
# instead of the mechanism. It is set BEFORE \${assignments}, so a test that wants that refusal —
# and there is one — can still ask for it by name.
IMS_AUTH_REQUEST_PROBE="${join(REPO, 'scripts/lib/pg-auth-request.mjs')}"
${CAPTURE_TERMINATOR_ASSIGNMENT}
# r42 (Codex HIGH): ONE PROBE ON A ROUTE THE TEST STATES, AND NO ROUTE LEFT BEHIND.
#
# The shipped gate gets its route from the authentication-request reader and from nowhere else, and
# a probe with no route REFUSES — which is the fix. That makes the credential half of the gate
# unreachable on its own, and several preconditions in these files exist precisely to measure it on
# its own: on a trust endpoint, on a RADIUS one, on a cleartext one, all of which the METHOD half
# refuses one step earlier. So the tests state a route explicitly for those measurements.
#
# It cannot weaken anything. It is defined in the RIG and not in install.sh, it is used only by
# lines that say what they are measuring, and it CLEARS the route again — so a shipped function
# called afterwards is back to needing the reader, and a test cannot pass on a route left lying
# about by the line above it. The assignments are written out rather than used as a VAR=x cmd
# prefix because bash keeps such an assignment after a FUNCTION call.
on_route() {
  local database="$1" sslmode="$2" status=0
  shift 2
  DB_PROBE_ROUTE_DATABASE="\${database}"
  DB_PROBE_SSLMODE="\${sslmode}"
  "$@" || status=$?
  DB_PROBE_ROUTE_DATABASE=""
  DB_PROBE_SSLMODE=""
  return "\${status}"
}
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
# r46 (Codex MEDIUM): and the published trust root, for the same reason and in the same shape. In
# install.sh this is /etc/ims-db-ca, root-owned — a literal, because a privileged path resolved
# from a variable the application can set is not a privileged path. These are top-level
# ASSIGNMENTS rather than functions, so they are not lifted, and the rig gives itself a directory
# of this run's own; the OWNER is likewise this run's own user, because a rig running as an
# ordinary user has no root to give a file to. What that leaves measurable is everything the
# finding is actually about: the digest, the mode, and who can open the result.
DB_CA_PUBLISH_DIR="\${DB_CA_PUBLISH_DIR:-\${APP_DIR}/db-ca-published}"
# r47 (Codex HIGH): AND IT IS EMPTY UNTIL publish_db_ca() SETS IT. The fixed \`db-ca.crt\` this line
# used to default to is the whole first half of the finding — one path, overwritten in place, which
# on an upgrade is the trust root the running installation is verifying against. A rig that kept
# defaulting it would hand every test a path the shipped code no longer chooses, and the generation
# scheme would be measured nowhere.
DB_CA_PUBLISHED_FILE="\${DB_CA_PUBLISHED_FILE-}"
# The generation grammar, the retention count and the accepted PEM label, LIFTED rather than
# retyped: a rig that spelled the prefix itself would pass while install.sh used another one, and
# the two would disagree only in production.
${DB_CA_ASSIGNMENTS}
${ENV_HEREDOC_DEFAULTS}
${SHIPPED}
${body}
`
  const env = { ...cleanLibpqEnv(), ...(options.env ?? {}) }
  try {
    return {
      status: 0,
      output: execFileSync('bash', ['-c', script, 'install.sh', ...(options.argv ?? [])], {
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

// ---------------------------------------------------------------------------
// WHAT THE CREDENTIAL REGRESSIONS SHARE (moved here in r40)
//
// These were defined in install-credential-representation.test.ts while it was the only file
// that needed them. The probe regressions need the same journal readers, the same base64 door
// and the same 'the run that comes after the interrupted one' body — and two copies of a body
// that models the shipped sequence is how two files come to disagree about what install.sh
// does, which is the reason this rig exists at all.
// ---------------------------------------------------------------------------

/**
 * Values reach the rig as base64, decoded inside the shell.
 *
 * NOT as `KEY="value"`: runShipped() JSON-stringifies its variables into a DOUBLE-quoted shell
 * assignment, and JSON escapes neither `$` nor a backtick — so `a"b\`c$d` would be command
 * substitution before any shipped function saw it, and the test would be measuring bash. base64 is
 * `[A-Za-z0-9+/=]`, which has no meaning in any of the three layers it passes through.
 */
export function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

/**
 * The base64 door into the rig, as a shell function.
 *
 * runShipped() JSON-stringifies its variables into a DOUBLE-quoted shell assignment, so a value
 * containing `$` or a backtick would be evaluated before any shipped function saw it — and a value
 * containing a NEWLINE would not survive the assignment at all. base64 has no meaning in any layer
 * it crosses, and `capture` is what brings the decoded bytes back out of the pipeline intact.
 */
export const DECODE_HELPER = `decode_b64() { printf '%s' "$1" | base64 -d; }`

/** The four values that identify one credential, as the rig's tests supply them. */
export function installVars(cluster: Cluster, root: string): Record<string, string> {
  return {
    APP_DIR: root,
    APP_USER: currentUser(),
    DB_HOST: '127.0.0.1',
    DB_PORT: String(cluster.port),
    DB_NAME: 'one_two_inventory',
    DB_USER: 'imsuser',
    IMS_PG_SOCKET_DIR: cluster.socket,
  }
}

export const JOURNAL = 'cutover-private/db-role-rotation.journal'

/** Does the shipped script's journal exist at the path the rig gives it? */
export function journalPath(root: string): string {
  return join(root, JOURNAL)
}

export function journalValue(root: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(journalPath(root), 'utf8'))
  return match === null ? null : match[1]
}

/** THE APPLICATION'S OWN CONNECTION: the installed driver, the composed URL, the real server. */
export async function connectWithDriver(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const result = await client.query('SELECT current_user AS who')
    return String(result.rows[0].who)
  } finally {
    await client.end()
  }
}

/**
 * THE RUN THAT COMES AFTER THE INTERRUPTED ONE, with no password supplied — which under
 * `--non-interactive`, and under an operator pressing Enter, is the same thing. It is the shipped
 * pre-stop sequence: recover, classify, provision, publish, resolve.
 *
 * WHAT IT PRINTS IS WHAT THE RECONCILIATION DECIDED. DB_PASSWORD_INSTALLED is the credential this
 * run believes the server has; DB_PASSWORD_EFFECTIVE is what it composed the URL from; and
 * JOURNAL_LEFT says whether the record was cleared, which is the difference between "reconciled"
 * and "still in flight".
 */
export const NEXT_RUN_BODY = `
  load_existing_env "\${APP_DIR}/.env"
  prompt_db_password
  ensure_database_role_exists
  classify_database_credential_rotation
  provision_database_role_and_privileges
  write_app_env_file
  resolve_role_rotation_journal_after_env_publication
  echo "INSTALLED_B64=$(printf '%s' "\${DB_PASSWORD_INSTALLED}" | base64 | tr -d '\\n')"
  echo "EFFECTIVE_B64=$(printf '%s' "\${DB_PASSWORD_EFFECTIVE}" | base64 | tr -d '\\n')"
  echo "PENDING=\${DB_PASSWORD_ROTATION_PENDING}"
  echo "RECONCILED=\${DB_ROTATION_JOURNAL_FOUND}"
  echo "JOURNAL_LEFT=$([[ -e "\${DB_ROLE_ROTATION_JOURNAL}" ]] && echo yes || echo no)"
`

/** The shipped rotation, TRUNCATED at one interruption point. Nothing here re-implements it. */
export const SHIPPED_ROTATION_UP_TO_THE_CLEAR = `
  write_role_rotation_journal "\${DB_PASSWORD_EFFECTIVE}" "\${DB_PASSWORD}" || exit 7
  quoted="$(sql_quote_literal "\${DB_PASSWORD}")"
  pg_local_psql -q >/dev/null <<EOSQL || exit 8
    SET standard_conforming_strings = on;
    ALTER USER "\${DB_USER}" WITH PASSWORD \${quoted};
EOSQL
  DB_PASSWORD_EFFECTIVE="\${DB_PASSWORD}"
  DATABASE_URL="$(compose_database_url "\${DB_USER}" "\${DB_PASSWORD_EFFECTIVE}" "\${DB_HOST}" "\${DB_PORT}" "\${DB_NAME}")"
  write_app_env_file || exit 9
`

export function decodeVar(output: string, name: string): string {
  return Buffer.from(readVar(output, name), 'base64').toString('utf8')
}

/**
 * A REAL X.509 CERTIFICATE ON DISK (o3d-2sm1.5 r47).
 *
 * Before r47 the CA tests wrote a line of prose to a `.pem` and the publisher copied it: the whole
 * finding is that it copied ANY bytes. Since the publisher PARSES its input, a test whose CA is not
 * a certificate is a test of the refusal path, and every test that means to measure a SUCCESSFUL
 * publication needs a certificate openssl can decode. The private key is written beside it — at
 * 0600, and it is the material a mixed-PEM or wrong-file test needs to have to hand.
 */
export function writeCertificate(path: string, commonName: string): string {
  execFileSync('openssl', [
    'req', '-new', '-x509', '-days', '2', '-nodes',
    '-subj', `/CN=${commonName}`,
    '-keyout', `${path}.key`,
    '-out', path,
  ], { stdio: 'pipe' })
  chmodSync(`${path}.key`, 0o600)
  return `${path}.key`
}

/**
 * The generation path publishing `caFile` lands on.
 *
 * Derived the way the shipped publisher derives it — the sha256 of openssl's re-encoding of the
 * certificate, not of the source file — so a test that asserts this path is asserting that the
 * published bytes are the NORMALISED ones. The `db-ca-`/`.crt` halves are read out of install.sh
 * for the same reason the shell rig lifts them.
 */
export function caGenerationPath(publishDir: string, caFile: string): string {
  const normalized = execFileSync('openssl', ['x509', '-inform', 'PEM', '-outform', 'PEM', '-in', caFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const digest = createHash('sha256').update(normalized).digest('hex')
  const prefix = /^DB_CA_GENERATION_PREFIX="([^"]*)"$/m.exec(INSTALL_SOURCE)
  const suffix = /^DB_CA_GENERATION_SUFFIX="([^"]*)"$/m.exec(INSTALL_SOURCE)
  assert.ok(prefix && suffix, 'precondition: scripts/install.sh must spell the generation name in two literals')
  return join(publishDir, `${prefix[1]}${digest}${suffix[1]}`)
}
