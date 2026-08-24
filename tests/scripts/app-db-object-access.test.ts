import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  OBJECT_ACCESS_QUERY,
  resolveAppRole,
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
    object_usable: true,
    ...overrides,
  }
}

test('a database the application role can use entirely is a pass', () => {
  const summary = summariseObjectAccess([row(), row({ object_name: 'seq', relkind: 'S' })], 'imsapp')
  assert.equal(summary.ok, true)
  assert.equal(summary.inspected, 2)
  assert.equal(summary.failures, 0)
})

test('a table the migration left owned by the deploy admin fails the deploy, and names the owner', () => {
  const summary = summariseObjectAccess(
    [
      row(),
      row({ object_name: 'refund_reversal_stage', owner_role: 'deployadmin', object_usable: false }),
    ],
    'imsapp',
  )
  assert.equal(summary.ok, false)
  assert.equal(summary.failures, 1)
  assert.match(summary.lines[0], /table public\.refund_reversal_stage/)
  assert.match(summary.lines[0], /owned by deployadmin/, 'the owner is the fastest way to see what went wrong')
  assert.match(summary.lines[0], /imsapp cannot use it/)
})

test('a sequence is a failure of its own, because a granted table with an ungranted sequence still refuses INSERT', () => {
  const summary = summariseObjectAccess(
    [row({ object_name: 'refunds_id_seq', relkind: 'S', owner_role: 'deployadmin', object_usable: false })],
    'imsapp',
  )
  assert.equal(summary.ok, false)
  assert.match(summary.lines[0], /^sequence /)
})

test('a schema the role cannot use is reported once, not once per table inside it', () => {
  const summary = summariseObjectAccess(
    [
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

test('no rows is not a pass by luck: the query is what selects the objects, and it excludes only system schemas', () => {
  assert.match(OBJECT_ACCESS_QUERY, /has_table_privilege\(\$1/, 'it must ask about the role passed in, not about current_user')
  assert.match(OBJECT_ACCESS_QUERY, /has_sequence_privilege\(\$1/)
  assert.match(OBJECT_ACCESS_QUERY, /has_schema_privilege\(\$1/)
  assert.match(OBJECT_ACCESS_QUERY, /SELECT, INSERT, UPDATE, DELETE/, 'a readable table the application cannot write to is still broken')
  assert.match(OBJECT_ACCESS_QUERY, /pg_catalog', 'information_schema'/)
  assert.ok(
    !/current_user/.test(OBJECT_ACCESS_QUERY),
    'asking about current_user is exactly what made the defect invisible: the admin owns everything',
  )
})

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

function runScript(args: string[], env: Record<string, string | undefined>) {
  try {
    const stdout = execFileSync('node', [join(process.cwd(), ...args[0].split('/')), ...args.slice(1)], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      cwd: mkdtempSync(join(tmpdir(), 'ims-noenv-')),
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
  const noRole = runScript(['scripts/fence-db-connections.mjs', '--print-migration-url'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://127.0.0.1:5432/ims',
    DIRECT_URL: '',
  })
  assert.notEqual(noRole.status, 0)
  assert.match(noRole.output, /owned by the admin/)

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
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ database: 'ims' }))
    const result = runScript(
      ['scripts/check-app-db-object-access.mjs', `--state-file=${join(dir, 'state.json')}`],
      { DEPLOY_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:5432/ims', DATABASE_URL: 'postgresql://127.0.0.1:5432/ims', DIRECT_URL: '' },
    )
    assert.notEqual(result.status, 0, 'reporting a pass having asked about nobody is the defect in miniature')
    assert.match(result.output, /No application role could be determined/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
