import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  OBJECT_ACCESS_QUERY,
  objectionToResolvedRole,
  readStateFileRole,
  resolveAppRole,
  roleFromConnectionString,
  summariseObjectAccess,
} from '@/scripts/check-app-db-object-access.mjs'

// o3d-2sm1.5 (Codex r4, CRITICAL) — MIGRATIONS CREATED OBJECTS THE APPLICATION COULD NOT USE.
//
// The connection fence forces `prisma migrate deploy` through DEPLOY_ADMIN_DATABASE_URL, and
// scripts/install.sh makes the APPLICATION role the database owner while the fence refuses
// when admin == app — so the only fenceable configuration is a separate SUPERUSER admin, and
// everything a migration created was owned by that superuser with no grant to the application.
//
// Nothing in the pipeline could see it. prisma, the drift check, the verification hook and
// pg_dump all use THE SAME ADMIN CONNECTION, which owns the new objects and reads them
// perfectly; the health check hits a route that touches no database. The deploy reported
// success and every request touching the new table failed with `permission denied`.
//
// This script is the check that asks about the APPLICATION role instead of about the caller.

function row(overrides: Record<string, unknown> = {}) {
  return {
    schema_name: 'public',
    object_name: 'sales_order_refunds',
    relkind: 'r',
    owner_role: 'imsapp',
    schema_usable: true,
    missing_privileges: [] as string[],
    ...overrides,
  }
}

const schemaRow = (schema: string, missing: string[] = []) =>
  row({ schema_name: schema, object_name: '', relkind: 'n', schema_usable: missing.length === 0, missing_privileges: missing })

test('a database the application role can use entirely is a pass', () => {
  const summary = summariseObjectAccess(
    [schemaRow('public'), row(), row({ object_name: 'seq', relkind: 'S' })],
    'imsapp',
  )
  assert.equal(summary.ok, true)
  assert.equal(summary.inspected, 3)
  assert.equal(summary.failures, 0)
})

test('a table the migration left owned by the deploy admin fails the deploy, and names the owner', () => {
  const summary = summariseObjectAccess(
    [
      row(),
      row({
        object_name: 'refund_reversal_stage',
        owner_role: 'deployadmin',
        missing_privileges: ['INSERT', 'UPDATE', 'DELETE'],
      }),
    ],
    'imsapp',
  )
  assert.equal(summary.ok, false)
  assert.equal(summary.failures, 1)
  assert.match(summary.lines[0], /table public\.refund_reversal_stage/)
  assert.match(summary.lines[0], /owned by deployadmin/, 'the owner is the fastest way to see what went wrong')
  assert.match(
    summary.lines[0],
    /missing INSERT, UPDATE, DELETE/,
    'and WHICH privileges are missing, because "cannot use it" does not say whether it is readable',
  )
})

test('a sequence is a failure of its own, because a granted table with an ungranted sequence still refuses INSERT', () => {
  const summary = summariseObjectAccess(
    [row({ object_name: 'refunds_id_seq', relkind: 'S', owner_role: 'deployadmin', missing_privileges: ['USAGE', 'UPDATE'] })],
    'imsapp',
  )
  assert.equal(summary.ok, false)
  assert.match(summary.lines[0], /^sequence /)
  assert.match(summary.lines[0], /missing USAGE, UPDATE/)
})

test('a function the application cannot execute is a failure: this repo gates writes with triggers', () => {
  const summary = summariseObjectAccess(
    [row({ object_name: 'enforce_refund_basis()', relkind: 'f', owner_role: 'deployadmin', missing_privileges: ['EXECUTE'] })],
    'imsapp',
  )
  assert.equal(summary.ok, false)
  assert.match(summary.lines[0], /^function public\.enforce_refund_basis\(\)/)
  assert.match(summary.lines[0], /missing EXECUTE/)
})

test('an enum the application cannot use is a failure: the column typed by it is neither readable nor writable', () => {
  const summary = summariseObjectAccess(
    [row({ object_name: 'refund_basis', relkind: 't', owner_role: 'deployadmin', missing_privileges: ['USAGE'] })],
    'imsapp',
  )
  assert.equal(summary.ok, false)
  assert.match(summary.lines[0], /^type public\.refund_basis/)
})

test('a schema the role cannot use is reported once, not once per table inside it', () => {
  const summary = summariseObjectAccess(
    [
      schemaRow('reporting', ['USAGE']),
      row({ schema_name: 'reporting', schema_usable: false, object_name: 'a' }),
      row({ schema_name: 'reporting', schema_usable: false, object_name: 'b' }),
      row({ schema_name: 'reporting', schema_usable: false, object_name: 'c' }),
    ],
    'imsapp',
  )
  assert.equal(summary.failures, 1, 'the schema is the cause; the tables are the symptom')
  assert.match(summary.lines[0], /schema reporting/)
  assert.match(summary.lines[0], /nothing in it is reachable/)
})

test('an EMPTY schema the role cannot use still fails, instead of contributing no rows and therefore no failure', () => {
  // The query asks pg_namespace directly for exactly this: a schema with nothing in it used
  // to produce no relation rows at all, so an unusable one passed silently.
  const summary = summariseObjectAccess([schemaRow('public'), schemaRow('reporting', ['USAGE'])], 'imsapp')
  assert.equal(summary.ok, false)
  assert.equal(summary.failures, 1)
  assert.match(summary.lines[0], /schema reporting/)
})

test('no rows at all is a FAILURE, not "the application can use all 0 objects"', () => {
  const summary = summariseObjectAccess([], 'imsapp')
  assert.equal(summary.ok, false)
  assert.match(summary.lines[0], /nothing was inspected/)
})

// ---------------------------------------------------------------------------
// THE ANY/ALL DEFECT. `has_table_privilege(role, oid, 'SELECT, INSERT, UPDATE, DELETE')` is
// ANY, not ALL: verified on PostgreSQL 17, a role holding SELECT alone answers TRUE, and
// `has_sequence_privilege(role, oid, 'USAGE, SELECT, UPDATE')` answers TRUE for a role holding
// SELECT and no USAGE — the exact "serial column fails INSERT" case this script exists to
// catch. A comma-list therefore turns a read-only grant into a GREEN CHECK over a database the
// application cannot write, on the check that closes the branch's CRITICAL.
//
// The assertion this replaced was `assert.match(QUERY, /SELECT, INSERT, UPDATE, DELETE/)` —
// it asserted the presence of the bug, under a comment claiming the opposite.
// ---------------------------------------------------------------------------

test('the query never asks for more than one privilege at a time, because a comma-list is ANY and not ALL', () => {
  const calls = [...OBJECT_ACCESS_QUERY.matchAll(/has_(?:table|sequence|schema|function|type|database)_privilege\s*\(([^)]*)\)/g)]
  assert.ok(calls.length >= 8, 'the query must actually ask about privileges')
  for (const call of calls) {
    const privilege = call[1].slice(call[1].lastIndexOf(',') + 1).trim()
    assert.match(privilege, /^'[A-Z]+'$/, `one privilege per call; got ${call[0]}`)
    assert.ok(
      !privilege.includes(','),
      `a comma-separated privilege list is ANY, so this passes on a read-only grant: ${call[0]}`,
    )
  }
})

test('and it asks for every privilege the application actually needs, each on its own', () => {
  const asks = (fn: string, privilege: string) =>
    new RegExp(`has_${fn}_privilege\\(\\$1,[^)]*'${privilege}'\\)`).test(OBJECT_ACCESS_QUERY)

  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.ok(asks('table', privilege), `a table the application cannot ${privilege} is broken`)
  }
  for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
    assert.ok(asks('sequence', privilege), `a serial column consumes sequence ${privilege}`)
  }
  assert.ok(asks('schema', 'USAGE'))
  assert.ok(asks('function', 'EXECUTE'), 'trigger functions in this repo GATE WRITES')
  assert.ok(asks('type', 'USAGE'), 'a column typed by an unusable enum is unreadable and unwritable')
  assert.ok(
    !/current_user/.test(OBJECT_ACCESS_QUERY),
    'asking about current_user is exactly what made the defect invisible: the admin owns everything',
  )
  assert.match(OBJECT_ACCESS_QUERY, /pg_catalog', 'information_schema'/)
  assert.match(OBJECT_ACCESS_QUERY, /pg_catalog\.pg_namespace/, 'schemas are asked about directly, not inferred from their contents')
})

// ---------------------------------------------------------------------------
// AND THE SAME THING ASKED OF A REAL POSTGRES. The assertions above are about the SHAPE of
// the SQL; this one runs it. It creates a role with SELECT and nothing else — the grant the
// old query called usable — and requires the check to name the missing privileges.
//
// Needs a superuser DATABASE_URL, so it runs in CI's fresh-db-drift job (which has one) and
// skips in `npm run test:unit`. Set RUN_DB_OBJECT_ACCESS_TEST=1 to run it locally.
// ---------------------------------------------------------------------------

const DB_TEST_URL = process.env.RUN_DB_OBJECT_ACCESS_TEST === '1' ? (process.env.DATABASE_URL ?? '') : ''

test(
  'against a real Postgres, a SELECT-only grant FAILS — the case a comma-separated privilege list passes',
  { skip: DB_TEST_URL ? false : 'set RUN_DB_OBJECT_ACCESS_TEST=1 and DATABASE_URL to a superuser connection' },
  async () => {
    const { default: pg } = await import('pg')
    const client = new pg.Client({ connectionString: DB_TEST_URL })
    await client.connect()
    const role = `ims_objaccess_probe_${process.pid}`
    const schema = `ims_objaccess_${process.pid}`
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.query(`DROP ROLE IF EXISTS ${role}`)
      await client.query(`CREATE ROLE ${role} NOLOGIN`)
      await client.query(`CREATE SCHEMA ${schema}`)
      await client.query(`CREATE TABLE ${schema}.probe (id serial PRIMARY KEY, note text)`)
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
      // Exactly the read-only grant the old query reported as usable.
      await client.query(`GRANT SELECT ON ${schema}.probe TO ${role}`)
      await client.query(`GRANT SELECT ON SEQUENCE ${schema}.probe_id_seq TO ${role}`)
      // The three the relation-only query could not see at all.
      await client.query(`CREATE TYPE ${schema}.probe_state AS ENUM ('NEW', 'DONE')`)
      await client.query(`CREATE FUNCTION ${schema}.probe_gate() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$`)
      await client.query(`REVOKE USAGE ON TYPE ${schema}.probe_state FROM PUBLIC`)
      await client.query(`REVOKE EXECUTE ON FUNCTION ${schema}.probe_gate() FROM PUBLIC`)
      await client.query(`CREATE SCHEMA ${schema}_empty`) // nothing in it, and no USAGE granted

      const { rows } = await client.query(OBJECT_ACCESS_QUERY, [role])
      const mine = rows.filter((entry: { schema_name: string }) => entry.schema_name === schema)
      const table = mine.find((entry: { object_name: string }) => entry.object_name === 'probe')
      const sequence = mine.find((entry: { object_name: string }) => entry.object_name === 'probe_id_seq')

      assert.ok(table, 'the probe table must be inspected')
      assert.deepEqual(
        table.missing_privileges.slice().sort(),
        ['DELETE', 'INSERT', 'UPDATE'],
        'SELECT alone is not usable, however cheerfully a comma-list answers true',
      )
      assert.ok(sequence, 'the serial sequence must be inspected')
      assert.deepEqual(
        sequence.missing_privileges.slice().sort(),
        ['UPDATE', 'USAGE'],
        'a sequence with SELECT and no USAGE refuses every INSERT through the serial column',
      )

      const gate = mine.find((entry: { object_name: string }) => entry.object_name.startsWith('probe_gate('))
      assert.ok(gate, 'a trigger function must be inspected: in this repo they GATE WRITES')
      assert.deepEqual(gate.missing_privileges, ['EXECUTE'])

      const enumType = mine.find((entry: { object_name: string }) => entry.object_name.endsWith('probe_state'))
      assert.ok(enumType, 'an enum type must be inspected')
      assert.deepEqual(enumType.missing_privileges, ['USAGE'])

      // An EMPTY schema contributes no relation rows, so a relations-only query saw nothing
      // to fail on. It is asked about directly.
      const emptySchema = rows.find(
        (entry: { schema_name: string; relkind: string }) =>
          entry.schema_name === `${schema}_empty` && entry.relkind === 'n',
      )
      assert.ok(emptySchema, 'a schema with nothing in it must still be inspected')
      assert.deepEqual(emptySchema.missing_privileges, ['USAGE'])
      assert.equal(summariseObjectAccess([emptySchema], role).ok, false)

      const summary = summariseObjectAccess(mine, role)
      assert.equal(summary.ok, false, 'and the whole run must fail, not merely record it')

      // The proof that the assertions are not vacuous: grant the rest and it goes green.
      await client.query(`GRANT INSERT, UPDATE, DELETE ON ${schema}.probe TO ${role}`)
      await client.query(`GRANT USAGE, UPDATE ON SEQUENCE ${schema}.probe_id_seq TO ${role}`)
      await client.query(`GRANT USAGE ON TYPE ${schema}.probe_state TO ${role}`)
      await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.probe_gate() TO ${role}`)
      const after = await client.query(OBJECT_ACCESS_QUERY, [role])
      assert.equal(
        summariseObjectAccess(
          after.rows.filter((entry: { schema_name: string }) => entry.schema_name === schema),
          role,
        ).ok,
        true,
        'a fully granted schema must pass, or the check would fail every deploy',
      )
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
      await client.query(`DROP SCHEMA IF EXISTS ${schema}_empty CASCADE`).catch(() => {})
      await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
      await client.end()
    }
  },
)

// THE ROLE IT ASKS ABOUT. During a fenced window DATABASE_URL is the ADMIN url — asking about
// that role would answer "yes" for every object the admin just created, which is the defect.
test('the fence state file outranks DATABASE_URL, because DATABASE_URL is the admin during a fenced window', () => {
  assert.deepEqual(
    resolveAppRole({ flagRole: '', stateFileRole: 'imsapp', connectionRole: 'deployadmin' }),
    { role: 'imsapp', source: 'the connection fence state file' },
  )
  assert.deepEqual(resolveAppRole({ flagRole: 'explicit', stateFileRole: 'imsapp', connectionRole: 'x' }), {
    role: 'explicit',
    source: '--app-role',
  })
  assert.deepEqual(resolveAppRole({ flagRole: '', stateFileRole: '', connectionRole: 'imsapp' }), {
    role: 'imsapp',
    source: 'DATABASE_URL',
  })
  assert.equal(resolveAppRole({ flagRole: '', stateFileRole: '', connectionRole: '' }).role, '')
})

test('DATABASE_URL names the role by its `-c role=` option, not by the admin it authenticates as', () => {
  // This is what the deploy actually sets inside the fenced window: authenticate as the
  // admin, become the application. Reading the username there names the DEPLOY ADMIN — the
  // role that owns everything the migration just created, for which every answer is yes.
  assert.equal(
    roleFromConnectionString('postgresql://deployadmin:pw@127.0.0.1:5432/ims?options=-c%20role%3Dimsapp'),
    'imsapp',
  )
  assert.equal(
    roleFromConnectionString('postgresql://deployadmin@127.0.0.1:5432/ims?options=-c%20search_path%3Dpublic%20-c%20role%3Dims%5C%20app'),
    'ims app',
  )
  assert.equal(roleFromConnectionString('postgresql://imsapp@127.0.0.1:5432/ims'), 'imsapp')
  assert.equal(roleFromConnectionString(''), '')
  assert.equal(roleFromConnectionString('not a url'), '')
})

test('a fence state file that EXISTS but names no role is fatal, and an absent one is not', () => {
  // Swallowing every error to '' fell through to DATABASE_URL, which during a fenced window
  // is the admin — and the check then reported green unconditionally.
  const absent = readStateFileRole('/no/such/state.json', () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  assert.deepEqual(absent, { role: '', absent: true, error: '' }, 'an unfenced deploy has no state file; that is normal')

  const unreadable = readStateFileRole('/x/state.json', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
  })
  assert.equal(unreadable.absent, false)
  assert.match(unreadable.error, /could not be read/)

  const notJson = readStateFileRole('/x/state.json', () => 'this is not json')
  assert.equal(notJson.absent, false)
  assert.match(notJson.error, /not valid JSON/)

  const noRole = readStateFileRole('/x/state.json', () => JSON.stringify({ database: 'ims' }))
  assert.equal(noRole.absent, false)
  assert.match(noRole.error, /records no app_role/)

  assert.deepEqual(readStateFileRole('/x/state.json', () => JSON.stringify({ app_role: 'imsapp' })), {
    role: 'imsapp',
    absent: false,
    error: '',
  })
  assert.deepEqual(readStateFileRole(''), { role: '', absent: true, error: '' })
})

test('it refuses to ask the deploy admin whether the deploy admin can use what it created', () => {
  assert.match(
    objectionToResolvedRole({ role: 'deployadmin', source: 'DATABASE_URL', adminRole: 'deployadmin' }),
    /the same role as DEPLOY_ADMIN_DATABASE_URL/,
  )
  // An unfenced deploy: DATABASE_URL is the application's own URL and there is no admin.
  assert.equal(objectionToResolvedRole({ role: 'imsapp', source: 'DATABASE_URL', adminRole: '' }), '')
  assert.equal(objectionToResolvedRole({ role: 'imsapp', source: 'DATABASE_URL', adminRole: 'deployadmin' }), '')
  // An explicitly named role is the operator's assertion, not a fall-through.
  assert.equal(objectionToResolvedRole({ role: 'deployadmin', source: '--app-role', adminRole: 'deployadmin' }), '')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, HIGH) — THE FENCE'S OWN DEPENDENCY WAS A devDependency.
//
// All of these scripts import `dotenv`, and the documented manual upgrade runs
// `npm ci --omit=dev`. The deploy scripts' preflight only checked that the FILE EXISTED, so
// the fence died with a missing module at drain-verify — AFTER the stop. An outage for an
// import. These run the shipped scripts, so a dependency that is not installable in a
// production tree fails here instead of on the box.
// ---------------------------------------------------------------------------

test('dotenv is a runtime dependency, because `npm ci --omit=dev` has to be able to run the fence', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  assert.ok(pkg.dependencies?.dotenv, 'dotenv must be a runtime dependency')
  assert.equal(pkg.devDependencies?.dotenv, undefined, 'and must not also be a devDependency')
})

function runScript(args: string[], env: Record<string, string | undefined>, identity?: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'ims-noenv-'))
  // THE APPLICATION'S IDENTITY IS ON THE COMMAND LINE (o3d-2sm1.5 r19). scripts/fence-db-connections.mjs
  // no longer works out where the application connects — from this process's environment, from a
  // dotenv overlay or from systemd — so every run of it here supplies the four values the way the
  // deploy scripts do, and a run without them would be refused before anything is opened.
  const isFence = args[0].endsWith('fence-db-connections.mjs')
  const extra = isFence
    ? (identity ?? ['--app-host=127.0.0.1', '--app-port=5432', '--app-user=imsapp', '--app-database=ims'])
    : []
  try {
    const stdout = execFileSync('node', [join(process.cwd(), ...args[0].split('/')), ...args.slice(1), ...extra], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

test('the fence script runs its imports and refuses without a privileged connection, rather than being merely present', () => {
  // The whole point of --preflight: EXECUTE the script before anything is stopped. A module
  // that cannot be imported fails here, where the predecessor is still up.
  const result = runScript(['scripts/fence-db-connections.mjs', '--preflight'], {
    DEPLOY_ADMIN_DATABASE_URL: '',
    DATABASE_URL: '',
    DIRECT_URL: '',
  })
  assert.equal(result.status, 3, 'no privileged connection is NOT FENCEABLE, not a crash and not a pass')
  assert.match(result.output, /DEPLOY_ADMIN_DATABASE_URL is not set/)
  assert.ok(!/Cannot find module/.test(result.output), 'and it must have got far enough to say so')
})

test('--print-migration-url composes the URL the migration runs through, and opens no connection', () => {
  const result = runScript(['scripts/fence-db-connections.mjs', '--print-migration-url'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin:pw@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://imsapp:pw@127.0.0.1:5432/ims',
    DIRECT_URL: '',
  })
  assert.equal(result.status, 0, '127.0.0.1:5432 is not listening in this test, so a connection attempt would fail')
  const url = new URL(result.output.trim())
  assert.equal(url.username, 'deployadmin')
  assert.equal(url.searchParams.get('options'), '-c role=imsapp')
})

test('--print-migration-url refuses rather than emitting a URL that would create admin-owned objects', () => {
  // THE ROLE THE MIGRATION RUNS AS IS THE SUPPLIED --app-user (o3d-2sm1.5 r19), so the refusal is
  // now the case where the caller supplied no role at all — and `-c role=` is still never emitted
  // empty. A run that supplies three of four is refused before any URL is composed.
  const noRole = runScript(['scripts/fence-db-connections.mjs', '--print-migration-url'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://127.0.0.1:5432/ims',
    USER: '',
    DIRECT_URL: '',
  }, ['--app-host=127.0.0.1', '--app-port=5432', '--app-user=', '--app-database=ims'])
  assert.notEqual(noRole.status, 0)
  assert.match(noRole.output, /--app-user was not supplied/)

  const noAdmin = runScript(['scripts/fence-db-connections.mjs', '--print-migration-url'], {
    DEPLOY_ADMIN_DATABASE_URL: '',
    DATABASE_URL: 'postgresql://imsapp@127.0.0.1:5432/ims',
    DIRECT_URL: '',
  })
  assert.notEqual(noAdmin.status, 0)
})

test('the object-access script refuses when it cannot tell which role to ask about', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ims-objaccess-'))
  try {
    // A state file that EXISTS and names no role. It must NOT fall through to DATABASE_URL,
    // which during a fenced window is the admin — it must refuse and say why.
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ database: 'ims' }))
    const result = runScript(
      ['scripts/check-app-db-object-access.mjs', `--state-file=${join(dir, 'state.json')}`],
      { DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims', DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims', DIRECT_URL: '' },
    )
    assert.notEqual(result.status, 0, 'reporting a pass having asked about nobody is the defect in miniature')
    assert.match(result.output, /records no app_role/)
    assert.ok(!/can use all/.test(result.output), 'and it must not have reported a pass on the way out')

    // Nothing at all: no flag, no state file, and a DATABASE_URL with no role in it.
    const silent = runScript(['scripts/check-app-db-object-access.mjs'], {
      DEPLOY_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:5432/ims',
      DATABASE_URL: 'postgresql://127.0.0.1:5432/ims',
      DIRECT_URL: '',
    })
    assert.notEqual(silent.status, 0)
    assert.match(silent.output, /No application role could be determined/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the object-access script refuses when the only role it could find is the deploy admin', () => {
  // The fenced window sets DATABASE_URL to the PRIVILEGED url. With no state file and no
  // flag, the fall-back names the admin — and every object the migration just created is
  // owned by the admin, so the check would pass unconditionally. That is the CRITICAL
  // wearing a green tick, so it exits non-zero instead.
  const result = runScript(['scripts/check-app-db-object-access.mjs', '--state-file=/nonexistent/state.json'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:59004/ims',
    DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:59004/ims',
    DIRECT_URL: '',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /Refusing to check the wrong role/)
  assert.ok(!/59004/.test(result.output), 'and it must refuse BEFORE opening a connection')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, HIGH) — TWO CALLERS PREFERRED DIRECT_URL OVER THE INJECTED ADMIN URL.
//
// The deploy invokes both of these INSIDE the connection fence, with DATABASE_URL set to the
// privileged URL — and both then preferred DIRECT_URL, which on the day anyone sets it is the
// APPLICATION role: the very role whose CONNECT the fence had just revoked. The step would die
// with "permission denied for database" after the stop, on a deploy that had done everything
// right. fence-db-connections.mjs already refused that fallback; its callers did not.
//
// Executed rather than read: each script is run with the two URLs pointing at DIFFERENT ports,
// neither listening, and the connection error names the one it chose.
// ---------------------------------------------------------------------------

for (const script of [
  'scripts/check-db-writers.mjs',
  'scripts/run-migration-verifications.mjs',
  'scripts/check-app-db-object-access.mjs',
] as const) {
  test(`${script.split('/')[1]} connects through the admin URL, not through DIRECT_URL`, () => {
    const result = runScript([script, '--app-role=imsapp'], {
      DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:59001/ims',
      DIRECT_URL: 'postgresql://imsapp@127.0.0.1:59002/ims',
      DATABASE_URL: 'postgresql://imsapp@127.0.0.1:59003/ims',
      PRISMA_MIGRATIONS_DIR: join(process.cwd(), 'prisma/migrations'),
    })
    assert.notEqual(result.status, 0, 'nothing is listening on any of those ports')
    assert.match(
      result.output,
      /59001/,
      'it must have tried the privileged connection — DIRECT_URL is the role the fence just shut out',
    )
    assert.ok(!/59002/.test(result.output), 'and must not have fallen back to DIRECT_URL')
  })
}
