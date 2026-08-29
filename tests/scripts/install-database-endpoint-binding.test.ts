/**
 * o3d-2sm1.5 r37 — THE TWO THINGS THE INSTALLER ASSERTED AND NEVER OBSERVED.
 *
 * Both findings this round are the same shape as each other: a statement about the system taken
 * on trust at the moment it mattered most.
 *
 *   * the first-install exemption was licensed by "this run created a database" and by
 *     "${DB_HOST}:${DB_PORT}/${DB_NAME}" — a string this script COMPOSED, never a place it
 *     OBSERVED. libpq fills every absent connection value from the environment, so an inherited
 *     PGPORT made both halves true of different servers and skipped the fence over a live one;
 *   * the duplicate-database path changed the application role's password and the database's
 *     owner BEFORE it asked whether it could fence, and then refused with "nothing has been
 *     stopped and nothing has been migrated".
 *
 * SO EVERY TEST HERE RUNS AGAINST REAL POSTGRESQL CLUSTERS. A fake psql would be a test of
 * whether this file's author models libpq's parameter resolution correctly, which is precisely
 * the thing the finding says was modelled wrongly. The clusters are created by initdb into a
 * throwaway directory, listen on loopback ports nothing else holds, and are stopped and deleted
 * in a finally block. Nothing here touches this machine's own cluster: every connection states
 * its socket directory or its host, and its port.
 *
 * This suite FAILS rather than skips when no PostgreSQL server binaries are present. A guard
 * that quietly does nothing on the machine that runs it is the defect this branch keeps
 * shipping, one layer down.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const REPO = process.cwd()
const INSTALL_SOURCE = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')

/** One shipped shell function, lifted whole, so the tests run the real bytes and not a copy. */
function shippedFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `precondition: scripts/install.sh must define ${name}()`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `precondition: ${name}() must end at a } in column 0`)
  return source.slice(start + 1, end + 3)
}

/** Everything the database section of install.sh is made of, in one string. */
const SHIPPED = [
  'libpq_env_unset_args',
  'db_local_socket_dir',
  'pg_local_psql',
  'pg_endpoint_psql',
  'pg_server_identity_select',
  'pg_extract_server_identity',
  'verify_created_database_endpoint',
  'create_database_and_record_newness',
  'ensure_database_role_exists',
  'provision_database_role_and_privileges',
  'first_install_exemption_available',
  'require_fenceable_database',
]
  .map((name) => shippedFunction(INSTALL_SOURCE, name))
  .join('\n')

// ---------------------------------------------------------------------------
// Real clusters
// ---------------------------------------------------------------------------

/** The server binaries, wherever this distribution keeps them. */
function pgBinDir(): string {
  const candidates = execFileSync('bash', [
    '-c',
    'ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1; command -v initdb 2>/dev/null | xargs -r dirname',
  ], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) return dir
  }
  throw new Error(
    'no PostgreSQL server binaries (initdb, pg_ctl) were found. These tests bring up real clusters ' +
      'on purpose — a fake psql would only test this file\'s model of libpq. Install the postgresql ' +
      'server package (Debian: apt-get install postgresql) and re-run.',
  )
}

/** A loopback port nothing currently holds. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

interface Cluster {
  readonly name: string
  readonly data: string
  readonly socket: string
  readonly port: number
  psql(args: string[], options?: { host?: string; password?: string; user?: string; database?: string }): string
  stop(): void
}

/**
 * A cluster of our own: its own data directory, its own socket directory, its own port.
 *
 * `listen` is a parameter because one test needs TWO clusters on the SAME port — which is only
 * possible if at most one of them binds TCP. That pair is what makes the identity comparison
 * reachable at all: the port alone cannot tell them apart.
 */
function startCluster(root: string, name: string, port: number, listen: string): Cluster {
  const bin = pgBinDir()
  const data = join(root, name, 'data')
  const socket = join(root, name, 'sock')
  mkdirSync(socket, { recursive: true })
  execFileSync(join(bin, 'initdb'), [
    '-D', data,
    '--auth-local=trust',
    '--auth-host=scram-sha-256',
    '-E', 'UTF8',
    '--no-sync',
    '-N',
  ], { stdio: 'pipe' })
  execFileSync(join(bin, 'pg_ctl'), [
    '-D', data,
    '-l', join(root, name, 'pg.log'),
    '-o', `-p ${port} -k ${socket} -c listen_addresses=${listen}`,
    '-w', 'start',
  ], { stdio: 'pipe' })

  return {
    name,
    data,
    socket,
    port,
    psql(args, options = {}) {
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (/^(PG|PSQL)/.test(key)) delete env[key]
      if (options.password !== undefined) env.PGPASSWORD = options.password
      return execFileSync('psql', [
        '-X', '-w', '-q', '-tA', '-v', 'ON_ERROR_STOP=1',
        '-h', options.host ?? socket,
        '-p', String(port),
        '-U', options.user ?? execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(),
        '-d', options.database ?? 'postgres',
        ...args,
      ], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    },
    stop() {
      try {
        execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' })
      } catch {
        // A cluster that never came up, or one already gone; the directory removal below is what
        // actually matters and it happens either way.
      }
    },
  }
}

interface Run {
  readonly status: number
  readonly output: string
}

/**
 * The shipped functions, in a shell that has been given exactly the variables install.sh gives
 * them — plus, deliberately, a hostile libpq environment.
 */
function runShipped(vars: Record<string, string>, env: Record<string, string>, body: string): Run {
  const assignments = Object.entries(vars)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')
  const script = `
exec 2>&1
set -uo pipefail
success() { echo "OK: $*"; }
warn()    { echo "WARN: $*"; }
info()    { echo "INFO: $*"; }
error()   { echo "ERROR: $*" >&2; }
die()     { error "$*"; exit 9; }
# install.sh runs the local statements as the postgres OS user; here the cluster belongs to
# whoever is running the tests, so the privilege transition is the identity function. Everything
# else about the invocation — the sanitising, the binding, the flags — is the shipped code.
run_as_user() { shift; "$@"; }
INSTALL_POSTGRES=y
APP_DIR="/nonexistent/app"
DEPLOY_ADMIN_DATABASE_URL=""
DB_CREATED_BY_THIS_RUN=false
DB_CREATED_IDENTITY=""
DB_CREATED_SERVER_IDENTITY=""
DB_NEWNESS_FINDING="unset"
FIRST_INSTALL_EXEMPTION_REFUSAL=""
DB_ROLE_PREEXISTED=false
DB_ROLE_CREDENTIALS_ROTATED=false
${assignments}
${SHIPPED}
${body}
`
  try {
    return {
      status: 0,
      output: execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

/**
 * A psqlrc that MOVES THE SESSION, rather than one that announces itself.
 *
 * The obvious version — `\echo PSQLRC_WAS_READ` — is vacuous here, and that was measured rather
 * than reasoned about: install.sh CAPTURES psql's output into a shell variable and prints it only
 * on the refusal paths, so a startup file that merely writes to stdout never reaches anything a
 * test can assert on. A `\c` does what the finding is actually about: it changes which server the
 * statements after it run on, before ours is sent. Reaching the decoy through its SOCKET keeps it
 * on trust auth, so the redirection succeeds instead of failing on a password prompt.
 */
function psqlrc(root: string, decoy: Cluster): string {
  const path = join(root, 'psqlrc')
  writeFileSync(path, `\\c postgres - ${decoy.socket} ${decoy.port}\n`)
  return path
}

/**
 * The environment the finding is about: every libpq variable that can move a connection, set to
 * the DECOY. install.sh inherits this from whoever invoked it — an operator with a second
 * cluster in their shell, a CI job, a cron entry.
 */
function hostileLibpqEnv(decoy: Cluster, root: string): Record<string, string> {
  return {
    PGHOST: decoy.socket,
    PGPORT: String(decoy.port),
    PGDATABASE: 'postgres',
    PGUSER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(),
    PGSERVICE: 'no-such-service',
    PGOPTIONS: '-c search_path=pg_catalog',
    PSQLRC: psqlrc(root, decoy),
  }
}

// ---------------------------------------------------------------------------
// The control: on one honest cluster, the exemption IS granted
// ---------------------------------------------------------------------------

test('r37: a database this run creates on the migration target earns the exemption', async () => {
  // WITHOUT THIS TEST EVERY OTHER TEST IN THIS FILE PASSES VACUOUSLY. "The exemption was refused"
  // is the assertion three of them make, and a create_database_and_record_newness() that refused
  // unconditionally — or died on every invocation — would satisfy all three. This is the run
  // where the answer must be YES.
  //
  // MUTATION ROUTE (measured, not predicted): make verify_created_database_endpoint() die
  // unconditionally, which is what an over-strict identity comparison amounts to. This test fails
  // on status 9. The two-cluster test and the HIGH's failure-path test stay GREEN, which is the
  // point — they assert refusals, and a build that refuses everything satisfies them. (The other
  // two refusal tests do fail, on the refusal TEXT they assert rather than on the refusal.)
  const root = mkdtempSync(join(tmpdir(), 'ims-pgbind-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'target', await freePort(), '127.0.0.1')
    const run = runShipped(
      {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(cluster.port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        DB_PASSWORD: 'installer-generated',
        IMS_PG_SOCKET_DIR: cluster.socket,
      },
      {},
      `
        ensure_database_role_exists
        create_database_and_record_newness
        first_install_exemption_available
        echo "EXEMPTION=$?"
        echo "CREATED=\${DB_CREATED_BY_THIS_RUN}"
        echo "SERVER_IDENTITY=\${DB_CREATED_SERVER_IDENTITY}"
      `,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /CREATED=true/, 'the server accepted CREATE DATABASE, so the database is new')
    assert.match(run.output, /EXEMPTION=0/, 'and it is on the endpoint the migration will use, so the exemption is earned')
    assert.match(
      run.output,
      /SERVER_IDENTITY=IMS_SERVER_IDENTITY \d+ \d+ \d+/,
      'and the identity is the one the SERVER answered with — port, postmaster start time, database oid',
    )

    // The throwaway verification role is not a leak.
    assert.equal(
      cluster.psql(['-c', "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ims_newness_probe_%'"]),
      '0',
      'the role the endpoint was verified with must be dropped again',
    )
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// CRITICAL — the two-cluster regression Codex asked for
// ---------------------------------------------------------------------------

test('r37: inherited libpq settings cannot redirect CREATE DATABASE away from the migration target', async () => {
  // THE FINDING, RUN. Two clusters. The MIGRATION TARGET already holds a live `one_two_inventory`
  // with a live application role; the DECOY holds nothing. The invoking environment points every
  // libpq variable at the DECOY, which is what an operator with a second cluster in their shell
  // hands this installer.
  //
  // BEFORE THE FIX: `psql -c "CREATE DATABASE ..."` inherits PGPORT, creates the database on the
  // DECOY, exits 0, and install.sh records "127.0.0.1:<target>/one_two_inventory" as proven — so
  // first_install_exemption_available() returns 0 and the live database on the target is migrated
  // with no fence and no drain, under its own writers.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. restore the pre-fix invocation — `run_as_user postgres psql -v ON_ERROR_STOP=1 -q "$@"`,
  //      no sanitising, no binding, no -X: every test in this file that reaches a cluster fails.
  //      This one fails first on the inherited PGSERVICE, which psql refuses before it connects.
  //      Dropping only `-p "${DB_PORT}"` fails the same five: the port is the one parameter that
  //      selects a cluster within a socket directory.
  //   2. drop the `libpq_env_unset_args` call from pg_local_psql() and keep every flag: psql
  //      refuses before it connects, unable to resolve the inherited PGSERVICE, and this test is
  //      the ONLY one of the six that fails — the others do not set a hostile environment.
  //   3. drop BOTH the sanitising and `-X`: the inherited PSQLRC runs its `\c` before our
  //      statement, the CREATE lands on the decoy, and the decoy assertion fails. Dropping `-X`
  //      ALONE changes nothing and that was measured, not assumed: the sanitiser has already
  //      removed PSQLRC by then, and -X is the second lock on the same door.
  const root = mkdtempSync(join(tmpdir(), 'ims-pgbind-'))
  let target: Cluster | undefined
  let decoy: Cluster | undefined
  try {
    target = startCluster(root, 'target', await freePort(), '127.0.0.1')
    decoy = startCluster(root, 'decoy', await freePort(), '127.0.0.1')

    // The live installation the fence exists for: a database somebody else made, an application
    // role somebody else is using, and an owner that is not ours.
    target.psql(['-c', "CREATE ROLE live_owner LOGIN PASSWORD 'owner-password'"])
    target.psql(['-c', "CREATE ROLE imsuser LOGIN PASSWORD 'live-password'"])
    target.psql(['-c', 'CREATE DATABASE one_two_inventory OWNER live_owner'])

    const run = runShipped(
      {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(target.port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        DB_PASSWORD: 'installer-generated',
        IMS_PG_SOCKET_DIR: target.socket,
      },
      hostileLibpqEnv(decoy, root),
      `
        ensure_database_role_exists
        create_database_and_record_newness
        first_install_exemption_available
        echo "EXEMPTION=$?"
        echo "CREATED=\${DB_CREATED_BY_THIS_RUN}"
      `,
    )

    // THE ASSERTION THE WHOLE FINDING TURNS ON, AND IT IS MADE FIRST so that a run which dies for
    // some other reason cannot skip past it: the CREATE went to the server the migration will
    // use, and NOWHERE ELSE. A decoy holding one_two_inventory is a run that created a database
    // on one server and would have spent the proof on another.
    assert.equal(
      decoy.psql(['-c', "SELECT count(*) FROM pg_database WHERE datname = 'one_two_inventory'"]),
      '0',
      `nothing may have been created on the cluster the environment pointed at:\n${run.output}`,
    )
    assert.equal(run.status, 0, `a pre-existing database is a supported outcome, not a crash:\n${run.output}`)
    assert.match(run.output, /CREATED=false/, 'the target refused the CREATE as a duplicate, so this run created nothing')
    assert.match(run.output, /EXEMPTION=1/, 'so the exemption is refused and the run is fenced')
  } finally {
    target?.stop()
    decoy?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r37: a CREATE that lands on another server does not become an exemption, even on the same port', async () => {
  // THE SECOND HALF OF THE FIX, AND WHY BINDING ALONE IS NOT ENOUGH. Sanitising and binding make
  // the connection DETERMINISTIC; they do not make it CORRECT. Two clusters on the SAME PORT —
  // one reachable only by its socket, one holding the TCP bind — is the shape where every
  // parameter this script states is identical and the servers are still different. It is also
  // what a second cluster on the same box looks like after a pg_basebackup clone: same port in
  // its config, same system identifier as its origin, a different postmaster.
  //
  // The proof therefore does not stop at "psql went where we told it". The identity is read off
  // the connection that PERFORMED the CREATE and compared with a connection opened to
  // ${DB_HOST}:${DB_PORT} the way the application opens its own.
  //
  // MUTATION ROUTE (measured): delete the `verify_created_database_endpoint "${created_identity}"`
  // call from create_database_and_record_newness(). The run then exits 0 with CREATED=true and
  // EXEMPTION=0 — an unfenced migration licensed by a database created on a server the migration
  // never touches. THIS test fails and the other five stay green, so it is this protection that
  // is being measured and not something else.
  const root = mkdtempSync(join(tmpdir(), 'ims-pgbind-'))
  let target: Cluster | undefined
  let twin: Cluster | undefined
  try {
    const port = await freePort()
    target = startCluster(root, 'target', port, '127.0.0.1')
    // Same port, no TCP listener: reachable only through its own socket directory, exactly as a
    // clone brought up beside the original is.
    twin = startCluster(root, 'twin', port, '')

    const run = runShipped(
      {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        DB_PASSWORD: 'installer-generated',
        // The one input that can still choose the server, pointed at the wrong one.
        IMS_PG_SOCKET_DIR: twin.socket,
      },
      {},
      `
        ensure_database_role_exists
        create_database_and_record_newness
        first_install_exemption_available
        echo "EXEMPTION=$?"
      `,
    )

    assert.equal(run.status, 9, `the run must stop rather than exempt:\n${run.output}`)
    assert.doesNotMatch(run.output, /EXEMPTION=/, 'and it must not reach the exemption question at all')
    assert.match(run.output, /NOTHING HAS BEEN MIGRATED/, 'and must say what state the box is in')

    // The database the exemption would have been spent on was never created on the target.
    assert.equal(
      target.psql(['-c', "SELECT count(*) FROM pg_database WHERE datname = 'one_two_inventory'"]),
      '0',
      'the endpoint the migration would use never received the database this run created',
    )
    assert.equal(
      twin.psql(['-c', "SELECT count(*) FROM pg_database WHERE datname = 'one_two_inventory'"]),
      '1',
      'precondition: the CREATE really did land on the other server — otherwise this test proves nothing',
    )
  } finally {
    target?.stop()
    twin?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r37: the identity comparison itself refuses, and drops the role it verified with', async () => {
  // THE COMPARISON BRANCH, EXERCISED DIRECTLY. The test above reaches the refusal through the
  // credential — a role created on one server cannot log in on another — which is the route a
  // pair of unrelated clusters takes. A STREAMING REPLICA is the case that route cannot catch:
  // it replays the role, so it accepts the login, and it shares its origin's system identifier
  // too. What separates them is pg_postmaster_start_time(), which is why the identity is that
  // and not the system identifier. This calls verify_created_database_endpoint() against a real
  // server with an identity that is not the one it will answer with, so the comparison — and
  // nothing else — decides.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. make the identity comparison unreachable (`[[ ... == ... ]] && false`): the run exits 0,
  //      this test fails on its status assertion, and the other five stay green.
  //   2. delete the DROP ROLE: this test AND the control both fail on their leftover-role
  //      assertions — the run leaves a login role with a password standing on the server it was
  //      verifying, on the success path as well as the refusal path.
  const root = mkdtempSync(join(tmpdir(), 'ims-pgbind-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'target', await freePort(), '127.0.0.1')
    cluster.psql(['-c', 'CREATE DATABASE one_two_inventory'])

    const run = runShipped(
      {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(cluster.port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        DB_PASSWORD: 'installer-generated',
        IMS_PG_SOCKET_DIR: cluster.socket,
      },
      {},
      `
        verify_created_database_endpoint "IMS_SERVER_IDENTITY 1 1 1"
        echo "VERIFIED=$?"
      `,
    )

    assert.equal(run.status, 9, `an identity that does not match must stop the run:\n${run.output}`)
    assert.doesNotMatch(run.output, /VERIFIED=/, 'the run must not continue past the refusal')
    assert.match(run.output, /NOT ON THE SERVER IT IS ABOUT TO MIGRATE/, 'and must say what disagreed')
    assert.match(run.output, /IMS_SERVER_IDENTITY 1 1 1/, 'quoting the identity the CREATE connection gave')

    assert.equal(
      cluster.psql(['-c', "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ims_newness_probe_%'"]),
      '0',
      'the throwaway role must be dropped on the refusal path too',
    )
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HIGH — the failure-path regression Codex asked for
// ---------------------------------------------------------------------------

test('r37: a duplicate database plus a failed fence preflight leaves credentials and ownership unchanged', async () => {
  // THE FINDING, RUN. A fresh application host pointed at a PRE-EXISTING, LIVE database. The
  // installer used to ALTER the application role's password, then decide newness, then GRANT and
  // move the database's OWNER — and only much later ask whether it could fence. With no
  // DEPLOY_ADMIN_DATABASE_URL the run then refused with "nothing has been stopped and nothing has
  // been migrated", having already taken the live writers' credential away from them.
  //
  // The assertions are made ON THE DATABASE, not on the installer's output: the live password
  // still authenticates over TCP, and the database still has the owner it had.
  //
  // MUTATION ROUTE (measured): move `provision_database_role_and_privileges` back in front of
  // `require_fenceable_database` in the body below — which is exactly what the shipped script did
  // before this round. The login with the live password then fails with "password authentication
  // failed for user imsuser", so this test fails and the other five stay green.
  const root = mkdtempSync(join(tmpdir(), 'ims-pgbind-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    cluster.psql(['-c', "CREATE ROLE live_owner LOGIN PASSWORD 'owner-password'"])
    cluster.psql(['-c', "CREATE ROLE imsuser LOGIN PASSWORD 'live-password'"])
    cluster.psql(['-c', 'CREATE DATABASE one_two_inventory OWNER live_owner'])

    const run = runShipped(
      {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(cluster.port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        DB_PASSWORD: 'installer-generated',
        IMS_PG_SOCKET_DIR: cluster.socket,
        CUTOVER_REASON: 'the database already existed on this server',
      },
      {},
      `
        ensure_database_role_exists
        create_database_and_record_newness
        first_install_exemption_available || echo "FENCED_PATH"
        require_fenceable_database
        provision_database_role_and_privileges
        echo "PROVISIONED"
      `,
    )

    assert.equal(run.status, 9, `a cutover with no admin URL must refuse:\n${run.output}`)
    assert.match(run.output, /FENCED_PATH/, 'precondition: a pre-existing database takes the fenced path')
    assert.doesNotMatch(run.output, /PROVISIONED/, 'and the refusal must land before the role work')
    assert.match(run.output, /DEPLOY_ADMIN_DATABASE_URL is not set/, 'for the reason the finding names')
    assert.match(run.output, /Nothing has been stopped and nothing has been migrated/, 'and it says the box is untouched')

    // ...AND IT IS TRUE. The credential the live writers hold still works.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'the pre-existing application role must still authenticate with the password its clients are using',
    )
    // ...and the database still belongs to whoever owned it.
    assert.equal(
      cluster.psql(['-c', "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'one_two_inventory'"]),
      'live_owner',
      'and the owner must not have moved',
    )
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('r37: the shipped order is the tested order — nothing mutating sits before classification', () => {
  // THE TEST ABOVE RUNS AN ORDER THIS FILE WROTE. This one asserts the SHIPPED script has the
  // same one, so the behavioural test cannot go on passing while install.sh drifts back.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. put an `ALTER USER ... WITH PASSWORD` line back into the database-newness phase: the
  //      phase-content assertion fails, and this is the only one of the six that does.
  //   2. move the fenced path's `provision_database_role_and_privileges` above
  //      `require_fenceable_database`: the ordering assertion fails, again alone. The behavioural
  //      test above cannot see either change, which is why this one exists.
  const lines = INSTALL_SOURCE.split('\n')
  const phaseStart = lines.findIndex((line) => line.includes('@install-phase: database-newness'))
  assert.notEqual(phaseStart, -1, 'precondition: install.sh must mark the newness phase')
  const phaseEnd = lines.findIndex((line, index) => index > phaseStart && line === 'fi')
  assert.notEqual(phaseEnd, -1, 'precondition: the newness phase must end at the INSTALL_POSTGRES block')
  const phase = lines.slice(phaseStart, phaseEnd + 1).join('\n')

  assert.match(phase, /^\s*ensure_database_role_exists$/m, 'the role has to exist for the fence preflight to answer')
  assert.match(phase, /^\s*create_database_and_record_newness$/m, 'and the newness decision belongs here')
  for (const mutation of [/ALTER\s+USER/i, /ALTER\s+ROLE/i, /GRANT\s+ALL/i, /ALTER\s+DATABASE/i]) {
    assert.doesNotMatch(
      phase,
      mutation,
      `nothing matching ${mutation} may run before this run knows whether it is a cutover: ${phase}`,
    )
  }

  const callSites = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line === 'provision_database_role_and_privileges')
  assert.equal(callSites.length, 2, 'exactly two call sites: the fenced path and the first-install path')

  const gates = ['require_fenceable_database', 'first_install_fence_policy'].map((gate) => {
    const index = lines.findIndex((line) => line.trim() === gate)
    assert.notEqual(index, -1, `precondition: install.sh must call ${gate}`)
    return { gate, index }
  })
  for (const { gate, index } of gates) {
    assert.ok(
      callSites.some((call) => call.index > index),
      `${gate} must run before the role work, and no call site follows it`,
    )
  }
  assert.ok(
    callSites[0].index > gates[0].index && callSites[1].index > gates[1].index,
    'each path performs its gate first and its role work second',
  )
})
