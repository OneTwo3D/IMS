import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import pg from 'pg'

import {
  assessMigrationRoleAttributes,
  buildMigrationLoginUrl,
  planConnectionFence,
  scramSha256Verifier,
} from '../../scripts/fence-db-connections.mjs'
import { freePort, pgBinDir, startCluster } from './real-postgres-cluster.ts'
import type { Cluster } from './real-postgres-cluster.ts'

/**
 * THE MIGRATION LOGIN IS A ROLE WORTH NOTHING (owner decision C3, o3d-1bgr).
 *
 * The migration used to connect as the deploy ADMIN with `options=-c role=<app>`. That option is a
 * session default, not a boundary: any statement on that connection can `RESET ROLE` and be the
 * superuser the admin normally is, and the connection is handed to application-owned bytes (prisma
 * from the app's node_modules, the migration SQL, package scripts). These tests run the SHIPPED
 * helper against a real cluster of their own and ask the server what the URL it prints can do.
 *
 * FRESH CLUSTER, OWN ROLES, OWN PORT. initdb into a throwaway directory, scram over TCP like CI, a
 * superuser role of its own with a random password, torn down in a `finally`. Passwords travel in
 * environment variables and URLs held in memory, never on an argv. Nothing here touches this
 * machine's own cluster.
 */

const SCRIPT = join(process.cwd(), 'scripts/fence-db-connections.mjs')
const NONCE = 'a'.repeat(32)

interface Rig {
  readonly cluster: Cluster
  readonly root: string
  readonly port: number
  readonly adminUrl: string
  readonly adminPassword: string
  readonly appPassword: string
  readonly identity: string[]
}

function randomSecret(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

async function withRig(body: (rig: Rig) => Promise<void>, setup: (rig: Rig) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'ims-migrole-'))
  const port = await freePort()
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'mig', port, '127.0.0.1')
    const adminPassword = randomSecret('adm')
    const appPassword = randomSecret('app')
    cluster.psql(['-c', `CREATE ROLE deployadmin SUPERUSER LOGIN PASSWORD '${adminPassword}'`])
    cluster.psql(['-c', `CREATE ROLE imsapp LOGIN PASSWORD '${appPassword}'`])
    cluster.psql(['-c', 'CREATE DATABASE imsdb OWNER imsapp'])
    const rig: Rig = {
      cluster,
      root,
      port,
      adminPassword,
      appPassword,
      adminUrl: `postgresql://deployadmin:${adminPassword}@127.0.0.1:${port}/imsdb`,
      identity: ['--app-host=127.0.0.1', `--app-port=${port}`, '--app-user=imsapp', '--app-database=imsdb'],
    }
    setup(rig)
    await body(rig)
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

/** The shipped helper, run as a real process. The admin URL goes in the ENVIRONMENT, never argv. */
function helper(rig: Rig, args: string[], extra: { migrationRole?: string | null; script?: string; env?: Record<string, string> } = {}) {
  const migrationRole = extra.migrationRole === undefined ? 'imsapp_migrator' : extra.migrationRole
  const run = spawnSync(
    'node',
    [extra.script ?? SCRIPT, ...args, ...rig.identity, ...(migrationRole ? [`--migration-role=${migrationRole}`] : [])],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DEPLOY_ADMIN_DATABASE_URL: rig.adminUrl, ...(extra.env ?? {}) } as unknown as NodeJS.ProcessEnv,
      cwd: rig.root,
    },
  )
  return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
}

async function session<T>(url: string, body: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await body(client)
  } finally {
    await client.end().catch(() => {})
  }
}

function ensure(rig: Rig) {
  const run = helper(rig, ['--ensure-migration-role'])
  assert.equal(run.status, 0, `precondition: the migration role must be ensured:\n${run.stderr}`)
}

function printUrl(rig: Rig): string {
  const run = helper(rig, ['--print-migration-url', `--migration-nonce=${NONCE}`])
  assert.equal(run.status, 0, `precondition: the migration URL must be printed:\n${run.stderr}`)
  const url = run.stdout.trim()
  assert.equal(url.split('\n').length, 1, `stdout is the machine channel and carries exactly one line:\n${run.stdout}`)
  return url
}

test('[o3d-1bgr] RESET ROLE on the migration URL gives no superuser and CREATE ROLE is refused (core property; red on trunk)', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const url = printUrl(rig)
    const parsed = new URL(url)
    console.log(`precondition: printed URL logs in as ${decodeURIComponent(parsed.username)} on ${parsed.host}${parsed.pathname}`)

    // The URL names the migration role and carries neither half of the admin credential.
    assert.equal(decodeURIComponent(parsed.username), 'imsapp_migrator', 'the login is the migration role')
    assert.ok(!url.includes('deployadmin'), 'the admin login name is not in the URL (universal absence)')
    assert.ok(!url.includes(rig.adminPassword), 'the admin password is not in the URL (universal absence)')

    // WHAT ESCAPES `options=-c role=`: `RESET ROLE` returns to the startup DEFAULT, which is the
    // role option itself (measured: it stays on the application role), so the statement that
    // reaches the LOGIN is `SET ROLE NONE`. Both are tried; the property is about the login.
    const escape = async (client: pg.Client) => {
      await client.query('RESET ROLE')
      const reset = (await client.query('SELECT current_user AS c')).rows[0].c
      await client.query('SET ROLE NONE')
      const none = (await client.query(
        'SELECT current_user AS c, (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS superuser',
      )).rows[0]
      return { reset, none }
    }
    await session(url, async (client) => {
      const who = (await client.query('SELECT session_user AS s, current_user AS c')).rows[0]
      assert.deepEqual(who, { s: 'imsapp_migrator', c: 'imsapp' }, 'logs in as the migration role and RUNS AS the application role')
      const escaped = await escape(client)
      console.log(`after RESET ROLE: ${escaped.reset}; after SET ROLE NONE: ${JSON.stringify(escaped.none)}`)
      assert.equal(escaped.none.c, 'imsapp_migrator', 'SET ROLE NONE lands on the login')
      assert.equal(escaped.none.superuser, false, 'and the login is no superuser')
      await assert.rejects(client.query('CREATE ROLE smuggled'), (error: { code?: string }) => error.code === '42501', 'and CREATE ROLE is refused with 42501')
    })

    // THE CONTROL: the same statements over the ADMIN URL find a superuser, so the assertions
    // above are capable of seeing one. Without this the arm would pass on a rig that cannot tell.
    await session(rig.adminUrl, async (client) => {
      const control = await escape(client)
      console.log(`control (admin login): ${JSON.stringify(control)}`)
      assert.equal(control.none.superuser, true, 'control: the admin login IS a superuser')
    })
  })
})

test('[o3d-1bgr] the role option is the SUPPLIED --app-user, whatever PGUSER and DATABASE_URL say', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const run = helper(rig, ['--print-migration-url', `--migration-nonce=${NONCE}`], {
      env: { PGUSER: 'deployrole', DATABASE_URL: 'postgresql://127.0.0.1:5432/ims' },
    })
    assert.equal(run.status, 0, run.stderr)
    const url = run.stdout.trim()
    console.log(`options=${new URL(url).searchParams.get('options')}`)
    assert.equal(new URL(url).searchParams.get('options'), '-c role=imsapp', 'the migration runs as the SUPPLIED role')
    assert.ok(!url.includes('deployrole'), 'and a shell variable such as PGUSER reaches nothing the migration runs through')
    assert.ok(!run.stdout.includes('supplied by the caller'), 'stdout carries the URL and nothing else: the deploy captures it with $(...)')
    assert.match(run.stderr, /as supplied by the caller/, 'and the diagnostic goes to stderr')
  })
})

test('[o3d-1bgr] a migration over the minted URL creates tables owned by the application role', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const url = printUrl(rig)
    await session(url, async (client) => {
      await client.query('CREATE TABLE custody_probe (id int primary key)')
    })
    const owner = rig.cluster.psql(['-c', "SELECT tableowner FROM pg_tables WHERE tablename = 'custody_probe'"], { database: 'imsdb' })
    console.log(`custody_probe is owned by ${owner}`)
    assert.equal(owner, 'imsapp', 'the application role owns what the migration created')
    // And the application can use it: the property check-app-db-object-access.mjs asserts after a migration.
    await session(`postgresql://imsapp:${rig.appPassword}@127.0.0.1:${rig.port}/imsdb`, async (client) => {
      await client.query('INSERT INTO custody_probe VALUES (1)')
    })

    // THE TWO CHECKS THAT RUN INSIDE THE WINDOW, over the minted URL, with an UNREACHABLE admin
    // canary in their environment. They must succeed on DATABASE_URL alone: on trunk they preferred
    // the admin variable and so tried the canary (port 1) and failed.
    const canary = 'postgresql://canary_admin:canary@127.0.0.1:1/imsdb'
    for (const script of ['scripts/check-app-db-object-access.mjs', 'scripts/check-db-writers.mjs']) {
      const run = spawnSync('node', [join(process.cwd(), script), '--app-role=imsapp'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', DATABASE_URL: url, DEPLOY_ADMIN_DATABASE_URL: canary } as unknown as NodeJS.ProcessEnv,
        cwd: rig.root,
      })
      console.log(`${script} over the migration URL with an admin canary in the environment: exit ${run.status}`)
      assert.equal(run.status, 0, `${script} must pass on DATABASE_URL alone:\n${run.stdout}${run.stderr}`)
    }
  })
})

test('[o3d-1bgr] after --fence the migration role connects and the application role and PUBLIC are refused', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const stateFile = join(rig.root, 'state.json')
    const aclOf = () => rig.cluster.psql(['-c', "SELECT coalesce(datacl::text, '<default>') FROM pg_database WHERE datname = 'imsdb'"])
    const before = aclOf()
    console.log(`ACL before: ${before}`)
    const appUrl = `postgresql://imsapp:${rig.appPassword}@127.0.0.1:${rig.port}/imsdb`
    await session(appUrl, async (client) => { await client.query('SELECT 1') })

    const plan = helper(rig, ['--plan', `--state-file=${stateFile}`, `--state-owner=${process.getuid?.() ?? 0}`])
    assert.equal(plan.status, 0, `plan:\n${plan.stderr}`)
    const planned = JSON.parse(plan.stdout.trim())
    assert.ok(!planned.revoked.includes('imsapp_migrator'), `the plan does not revoke from the migration role: ${planned.revoked.join(',')}`)
    assert.ok(planned.revoked.includes('imsapp') && planned.revoked.includes('PUBLIC'), 'but it does revoke from the application role and PUBLIC')
    publishPlan(planned, stateFile)
    const fence = helper(rig, ['--fence', `--state-file=${stateFile}`, `--state-owner=${process.getuid?.() ?? 0}`])
    assert.equal(fence.status, 0, `fence:\n${fence.stderr}`)
    const during = aclOf()
    console.log(`ACL during: ${during}`)
    assert.notEqual(during, before, 'precondition: the fence changed the ACL')

    const url = (() => {
      const run = helper(rig, ['--print-migration-url', `--migration-nonce=${NONCE}`])
      assert.equal(run.status, 0, `print-migration-url under the fence:\n${run.stderr}`)
      return run.stdout.trim()
    })()
    await session(url, async (client) => {
      assert.equal((await client.query('SELECT current_user AS c')).rows[0].c, 'imsapp', 'the migration role gets in under the fence')
    })
    await assert.rejects(session(appUrl, async (client) => { await client.query('SELECT 1') }), (error: { code?: string }) => error.code === '42501', 'the application role is refused')
    const bystanderPassword = randomSecret('by')
    rig.cluster.psql(['-c', `CREATE ROLE bystander LOGIN PASSWORD '${bystanderPassword}'`])
    await assert.rejects(session(`postgresql://bystander:${bystanderPassword}@127.0.0.1:${rig.port}/imsdb`, async (client) => { await client.query('SELECT 1') }), (error: { code?: string }) => error.code === '42501', 'and so is a role that only held CONNECT through PUBLIC')

    // RELEASE closes the login again.
    const release = helper(rig, ['--release', `--state-file=${stateFile}`, `--state-owner=${process.getuid?.() ?? 0}`])
    assert.ok(release.status === 0 || release.status === 6, `release:\n${release.stderr}`)
    const login = rig.cluster.psql(['-c', "SELECT rolcanlogin, rolpassword IS NULL FROM pg_authid WHERE rolname = 'imsapp_migrator'"])
    console.log(`after release: rolcanlogin|password-is-null = ${login}`)
    assert.equal(login, 'f|t', 'the migration login is NOLOGIN with no password after the release')
    await assert.rejects(session(url, async (client) => { await client.query('SELECT 1') }), 'logging in with the minted password fails after the release')
    await session(appUrl, async (client) => { await client.query('SELECT 1') })
  })
})

function publishPlan(plan: Record<string, unknown>, destination: string) {
  const source = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  const opener = "  cat <<'AUTHORISE_PLAN_EOF'\n"
  const from = source.indexOf(opener)
  assert.notEqual(from, -1, 'the library emits the plan validator from one heredoc')
  const to = source.indexOf('\nAUTHORISE_PLAN_EOF\n', from)
  const program = source.slice(from + opener.length, to + 1)
  const run = spawnSync('node', ['-e', program, '--', String(plan.database), String(plan.app_role), destination], {
    input: `${JSON.stringify(plan)}\n`,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, `the plan must publish through the shipped validator:\n${run.stdout}${run.stderr}`)
}

test('[o3d-1bgr] the preflight refuses a migration role that is not worth nothing, one fixture each', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const ok = helper(rig, ['--preflight'])
    console.log(`control: preflight on the proper role exits ${ok.status}`)
    assert.equal(ok.status, 0, `control: a proper migration role passes the preflight:\n${ok.stderr}`)

    const fixtures: Array<{ role: string; setup: string[]; expect: RegExp }> = [
      { role: 'mig_super', setup: ['SUPERUSER'], expect: /SUPERUSER/ },
      { role: 'mig_createrole', setup: ['CREATEROLE'], expect: /CREATEROLE/ },
      { role: 'mig_createdb', setup: ['CREATEDB'], expect: /CREATEDB/ },
      { role: 'mig_replication', setup: ['REPLICATION'], expect: /REPLICATION/ },
      { role: 'mig_bypassrls', setup: ['BYPASSRLS'], expect: /BYPASSRLS/ },
    ]
    for (const { role, setup, expect } of fixtures) {
      rig.cluster.psql(['-c', `CREATE ROLE ${role} NOLOGIN ${setup.join(' ')}`])
      rig.cluster.psql(['-c', `GRANT imsapp TO ${role}`])
      rig.cluster.psql(['-c', `GRANT CONNECT ON DATABASE imsdb TO ${role}`])
      const run = helper(rig, ['--preflight'], { migrationRole: role })
      console.log(`${role}: preflight exit ${run.status}`)
      assert.equal(run.status, 3, `${role} must be refused:\n${run.stderr}`)
      assert.match(run.stderr, expect, `and the refusal names the attribute:\n${run.stderr}`)
    }

    // A membership the application role does not have.
    rig.cluster.psql(['-c', 'CREATE ROLE other_privilege NOLOGIN'])
    rig.cluster.psql(['-c', 'CREATE ROLE mig_extra NOLOGIN'])
    rig.cluster.psql(['-c', 'GRANT imsapp, other_privilege TO mig_extra'])
    rig.cluster.psql(['-c', 'GRANT CONNECT ON DATABASE imsdb TO mig_extra'])
    const extra = helper(rig, ['--preflight'], { migrationRole: 'mig_extra' })
    assert.equal(extra.status, 3, `a migration role reaching a role the application cannot is refused:\n${extra.stderr}`)
    assert.match(extra.stderr, /member of a role the application role is not/)

    // No direct CONNECT: the fence would lock it out together with the application role.
    rig.cluster.psql(['-c', 'CREATE ROLE mig_noconnect NOLOGIN'])
    rig.cluster.psql(['-c', 'GRANT imsapp TO mig_noconnect'])
    const noConnect = helper(rig, ['--preflight'], { migrationRole: 'mig_noconnect' })
    assert.equal(noConnect.status, 3, `a migration role with no CONNECT of its own is refused:\n${noConnect.stderr}`)
    assert.match(noConnect.stderr, /holds no CONNECT of its own/)

    // Missing entirely.
    const missing = helper(rig, ['--preflight'], { migrationRole: 'mig_not_there' })
    assert.equal(missing.status, 3, missing.stderr)
    assert.match(missing.stderr, /does not exist/)
  })
})

test('[o3d-1bgr] --print-migration-url refuses a privileged migration role rather than printing it, and never falls back to the admin login', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    rig.cluster.psql(['-c', 'ALTER ROLE imsapp_migrator SUPERUSER'])
    const run = helper(rig, ['--print-migration-url', `--migration-nonce=${NONCE}`])
    console.log(`superuser migration role: exit ${run.status}, stdout bytes ${run.stdout.length}`)
    assert.notEqual(run.status, 0)
    assert.equal(run.stdout, '', 'nothing is printed on stdout')
    assert.match(run.stderr, /SUPERUSER/)
    assert.ok(!run.stdout.includes('deployadmin') && !run.stderr.includes(rig.adminPassword), 'and the admin credential is nowhere in the output')

    const none = helper(rig, ['--print-migration-url', `--migration-nonce=${NONCE}`], { migrationRole: null })
    assert.notEqual(none.status, 0, 'no --migration-role: it refuses instead of composing the admin URL')
    assert.equal(none.stdout, '')
    assert.match(none.stderr, /--migration-role names no role/)
  })
})

test('[o3d-1bgr] the minted password is in no server log: the verifier is sent, not the plaintext', async () => {
  await withRig(async (rig) => {
    rig.cluster.psql(['-c', "ALTER SYSTEM SET log_statement = 'all'"])
    rig.cluster.psql(['-c', 'SELECT pg_reload_conf()'])
    ensure(rig)
    const url = printUrl(rig)
    const password = decodeURIComponent(new URL(url).password)
    assert.ok(password.length >= 32, 'precondition: the password is long and random')
    // log_statement is reloaded asynchronously; one bounded wait on the log, not on a sleep.
    const log = join(rig.root, 'mig', 'pg.log')
    let text = ''
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      text = readFileSync(log, 'utf8')
      if (/ALTER ROLE "imsapp_migrator" LOGIN PASSWORD 'SCRAM-SHA-256\$/.test(text)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const alters = text.split('\n').filter((line) => line.includes('ALTER ROLE "imsapp_migrator" LOGIN PASSWORD'))
    console.log(`precondition: ${alters.length} logged ALTER ROLE statement(s) carrying a SCRAM verifier`)
    assert.ok(alters.length >= 1 && alters.every((line) => line.includes("'SCRAM-SHA-256$")), 'the statement was logged, and it carries a verifier')
    assert.ok(!text.includes(password), 'the plaintext password appears nowhere in the server log (universal absence)')
    assert.ok(!text.includes(rig.adminPassword), 'nor does the admin password')
  })
})

test('[o3d-1bgr] --ensure-migration-role never demotes or adopts a role someone else made under that name', async () => {
  await withRig(async (rig) => {
    rig.cluster.psql(['-c', 'CREATE ROLE imsapp_migrator NOLOGIN SUPERUSER'])
    const run = helper(rig, ['--ensure-migration-role'])
    console.log(`pre-existing superuser role: exit ${run.status}`)
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /SUPERUSER/)
    assert.equal(rig.cluster.psql(['-c', "SELECT rolsuper FROM pg_roles WHERE rolname = 'imsapp_migrator'"]), 't', 'the existing role is left exactly as it was found')
  })
})

test('assessMigrationRoleAttributes: administrability, one fixture each (pure)', () => {
  const proper = {
    migrationRole: 'm', appRole: 'a', database: 'd', adminRole: 'adm', serverVersionNum: 160000, exists: true,
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
    canSetAppRole: true, appIsMember: false, reachesOtherRoles: false, directConnect: true,
    adminIsSuperuser: false, adminCreaterole: true, adminHasAdminOption: true,
  }
  assert.equal(assessMigrationRoleAttributes(proper).usable, true, 'control: CREATEROLE with ADMIN OPTION on PG16 can alter it')
  const noAdmin = assessMigrationRoleAttributes({ ...proper, adminHasAdminOption: false })
  assert.equal(noAdmin.usable, false, 'CREATEROLE without ADMIN OPTION cannot alter it on PG16')
  assert.match(noAdmin.reason, /cannot be administered/)
  assert.equal(assessMigrationRoleAttributes({ ...proper, serverVersionNum: 150000, adminHasAdminOption: false }).usable, true, 'before PG16 CREATEROLE alone can alter a non-superuser role')
  // PostgreSQL refuses a circular GRANT, so on a real server `app member of migration role` cannot
  // coexist with `migration role may SET ROLE to app`; the check is a belt over that, and is
  // exercised here on a fixture rather than a server that will not build it.
  const circular = assessMigrationRoleAttributes({ ...proper, appIsMember: true })
  assert.equal(circular.usable, false)
  assert.match(circular.reason, /has the application role a as a member/)
  const plain = assessMigrationRoleAttributes({ ...proper, adminCreaterole: false })
  assert.equal(plain.usable, false, 'an admin with neither SUPERUSER nor CREATEROLE cannot alter it')
  assert.equal(assessMigrationRoleAttributes({ ...proper, adminCreaterole: false, adminIsSuperuser: true }).usable, true, 'a superuser admin can')
})

test('planConnectionFence exempts the migration role from the revoke, and refuses one that is the app or the admin (pure)', () => {
  const base = {
    appRole: 'imsapp', appRoleIsSuperuser: false, adminRole: 'deployadmin', adminIsSuperuser: true, adminIsOwner: false,
    publicHasConnect: true, appRoleHasConnect: true, appRoleHasEffectiveConnect: true,
    directConnectGrantees: ['imsapp', 'imsapp_migrator'],
  }
  const without = planConnectionFence(base)
  assert.deepEqual(without.revoke, ['PUBLIC', 'imsapp', 'imsapp_migrator'], 'precondition: with no migration role named, a direct grantee is revoked')
  const exempt = planConnectionFence({ ...base, migrationRole: 'imsapp_migrator' })
  assert.deepEqual(exempt.revoke, ['PUBLIC', 'imsapp'], 'the named migration role is not revoked')
  assert.equal(planConnectionFence({ ...base, migrationRole: 'imsapp' }).fenceable, false, 'the app role cannot be its own exemption')
  assert.equal(planConnectionFence({ ...base, migrationRole: 'deployadmin' }).fenceable, false, 'nor can the admin')
})

test('buildMigrationLoginUrl replaces the admin userinfo and keeps host, port, database and query (pure)', () => {
  const built = buildMigrationLoginUrl('postgresql://deployadmin:adminpw@db.internal:6432/imsdb?sslmode=require', 'imsapp_migrator', 'pw/with+odd', 'imsapp', NONCE)
  const url = new URL(built)
  assert.equal(decodeURIComponent(url.username), 'imsapp_migrator')
  assert.equal(decodeURIComponent(url.password), 'pw/with+odd')
  assert.equal(url.host, 'db.internal:6432')
  assert.equal(url.pathname, '/imsdb')
  assert.equal(url.searchParams.get('sslmode'), 'require')
  assert.ok(!built.includes('deployadmin') && !built.includes('adminpw'))
  assert.throws(() => buildMigrationLoginUrl('postgresql://a:b@h/d', '', 'pw', 'imsapp'), /No migration role/)
  assert.throws(() => buildMigrationLoginUrl('postgresql://a:b@h/d', 'm', '', 'imsapp'), /No migration password/)
})

test('scramSha256Verifier has the shape PostgreSQL stores', () => {
  const verifier = scramSha256Verifier('secret', Buffer.from('0123456789abcdef'))
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
  assert.equal(existsSync(SCRIPT), true)
})

// ---------------------------------------------------------------------------
// ONE NAMED MUTATION PER ARM, run against a real cluster. Each applies one edit to a COPY of the
// shipped helper (with a node_modules link so its imports resolve) and shows the property the
// arm above asserts is then false -- i.e. that arm would be red. The shipped file is never edited.
// ---------------------------------------------------------------------------

function mutatedHelper(rig: Rig, find: string, replacement: string, label: string): string {
  const original = readFileSync(SCRIPT, 'utf8')
  const mutated = original.replace(find, replacement)
  assert.notEqual(mutated, original, `mutation "${label}" must change the helper (precondition)`)
  const dir = join(rig.root, `mutant-${label}`)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'))
  const copy = join(dir, 'scripts', 'fence-db-connections.mjs')
  writeFileSync(copy, mutated)
  return copy
}

test('[o3d-1bgr] MUTATION compose-from-admin: a URL built from the admin userinfo logs in as the superuser (core arm would be red)', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const script = mutatedHelper(
      rig,
      'buildMigrationLoginUrl(adminUrl, options.migrationRole, password, appRole, options.migrationNonce)',
      'buildMigrationConnectionString(adminUrl, appRole, options.migrationNonce)',
      'admin-userinfo',
    )
    const run = helper(rig, ['--print-migration-url', `--migration-nonce=${NONCE}`], { script })
    assert.equal(run.status, 0, run.stderr)
    const url = run.stdout.trim()
    console.log(`mutated URL logs in as ${decodeURIComponent(new URL(url).username)}`)
    await session(url, async (client) => {
      await client.query('SET ROLE NONE')
      const row = (await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = session_user')).rows[0]
      assert.equal(row.rolsuper, true, 'the mutated URL is the admin: SET ROLE NONE reaches a superuser, so the core arm would be red')
    })
  })
})

test('[o3d-1bgr] MUTATION drop-exemption: revoking CONNECT from the migration role too locks the window out (fence arm would be red)', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const script = mutatedHelper(rig, "    if (migrationRole && grantee === migrationRole) continue\n", '', 'no-exemption')
    const stateFile = join(rig.root, 'state.json')
    const plan = helper(rig, ['--plan', `--state-file=${stateFile}`, `--state-owner=${process.getuid?.() ?? 0}`], { script })
    assert.equal(plan.status, 0, plan.stderr)
    const planned = JSON.parse(plan.stdout.trim())
    console.log(`mutated plan revokes from: ${planned.revoked.join(', ')}`)
    assert.ok(planned.revoked.includes('imsapp_migrator'), 'the mutated plan revokes from the migration role: the fence arm above would be red')
  })
})

test('[o3d-1bgr] MUTATION no-superuser-check: a superuser migration role passes the preflight (preflight arm would be red)', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    rig.cluster.psql(['-c', 'ALTER ROLE imsapp_migrator SUPERUSER'])
    const script = mutatedHelper(rig, "  if (f.rolsuper) forbidden.push('SUPERUSER')\n", '', 'no-superuser-check')
    const run = helper(rig, ['--preflight'], { script })
    console.log(`mutated preflight over a SUPERUSER migration role: exit ${run.status}`)
    assert.equal(run.status, 0, 'the mutated preflight accepts a superuser migration login: the real arm above would be red')
  })
})

test('[o3d-1bgr] MUTATION skip-NOLOGIN: without the closing statement the minted password still logs in after the release (release arm would be red)', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const script = mutatedHelper(rig, '    await client.query(buildMigrationLogoutStatement(migrationRole))\n', '', 'no-logout')
    const url = printUrl(rig)
    const stateFile = join(rig.root, 'state.json')
    const plan = helper(rig, ['--plan', `--state-file=${stateFile}`, `--state-owner=${process.getuid?.() ?? 0}`])
    publishPlan(JSON.parse(plan.stdout.trim()), stateFile)
    assert.equal(helper(rig, ['--fence', `--state-file=${stateFile}`, `--state-owner=${process.getuid?.() ?? 0}`]).status, 0)
    const release = helper(rig, ['--release', `--state-file=${stateFile}`, `--state-owner=${process.getuid?.() ?? 0}`], { script })
    assert.ok(release.status === 0 || release.status === 6, release.stderr)
    await session(url, async (client) => { await client.query('SELECT 1') })
    console.log('mutated release: the minted login still connects')
  })
})

test('[o3d-1bgr] MUTATION plaintext-password: sending the password itself puts it in the server log (log arm would be red)', async () => {
  await withRig(async (rig) => {
    rig.cluster.psql(['-c', "ALTER SYSTEM SET log_statement = 'all'"])
    rig.cluster.psql(['-c', 'SELECT pg_reload_conf()'])
    ensure(rig)
    const script = mutatedHelper(
      rig,
      'await client.query(buildMigrationLoginStatement(options.migrationRole, scramSha256Verifier(password)))',
      'await client.query(buildMigrationLoginStatement(options.migrationRole, password))',
      'plaintext-password',
    )
    const run = helper(rig, ['--print-migration-url', `--migration-nonce=${NONCE}`], { script })
    assert.equal(run.status, 0, run.stderr)
    const password = decodeURIComponent(new URL(run.stdout.trim()).password)
    const log = join(rig.root, 'mig', 'pg.log')
    let text = ''
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      text = readFileSync(log, 'utf8')
      if (text.includes(password)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(text.includes(password), 'the mutated helper leaks the plaintext into the server log: the real arm above would be red')
  })
})

test('[o3d-1bgr] pg_dump through the migration URL: the dump is taken as the migration login and the URL is on no command line', async () => {
  await withRig(async (rig) => {
    ensure(rig)
    const url = printUrl(rig)
    await session(url, async (client) => { await client.query('CREATE TABLE dump_probe (id int primary key)') })
    const password = decodeURIComponent(new URL(url).password)

    // A pg_dump on PATH that records its own argv (what `ps` would show) and then runs the real one.
    const bin = join(rig.root, 'dumpbin')
    mkdirSync(bin)
    const argvLog = join(rig.root, 'pg_dump.argv')
    writeFileSync(join(bin, 'pg_dump'), ['#!/bin/bash', `echo "$*" >> ${JSON.stringify(argvLog)}`, `exec ${JSON.stringify(join(pgBinDir(), 'pg_dump'))} "$@"`].join('\n') + '\n')
    chmodSync(join(bin, 'pg_dump'), 0o755)

    const library = join(process.cwd(), 'scripts/lib/db-fence-protected.sh')
    const run = spawnSync('bash', ['-c', 'source "$1"; db_pg_dump_through_url "${RIG_URL}"', 'rig', library], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, RIG_URL: url, TMPDIR: rig.root } as unknown as NodeJS.ProcessEnv,
    })
    const argv = readFileSync(argvLog, 'utf8')
    console.log(`pg_dump exit ${run.status}; its argv: ${JSON.stringify(argv.trim())}; dump bytes ${run.stdout.length}`)
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /CREATE TABLE public\.dump_probe/, 'the dump is of the database the URL names, taken over the service file')
    assert.ok(!argv.includes(password) && !argv.includes('imsapp_migrator'), 'the URL (its login and password) is on no command line')
    assert.match(argv, /service=ims_migration/, 'precondition: the recorded argv is the service form')
    assert.equal(existsSync(join(rig.root, 'service.conf')), false)
    const leftovers = spawnSync('bash', ['-c', 'ls -A "$1" | grep -c "^tmp\\." || true', 'rig', rig.root], { encoding: 'utf8' }).stdout.trim()
    assert.equal(leftovers, '0', 'and the directory holding the service file is gone')
  })
})
