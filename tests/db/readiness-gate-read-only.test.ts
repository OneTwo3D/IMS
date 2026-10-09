import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { config } from 'dotenv'

/**
 * THE READINESS GATE WRITES NOTHING TO THE DATABASE IT IS POINTED AT.
 *
 * The proof is the database's own, not a double's: the gate's DEFAULT collectors (the invariant report,
 * the outbound status with its activity-log read, the reconciliation completeness proof) run here against
 * a real, migrated PostgreSQL over connections that were opened with `default_transaction_read_only=on`.
 * The server refuses any write on such a connection ("cannot execute INSERT in a read-only transaction"),
 * so a collector that wrote anything would throw here, and a collector that swallowed the error would show
 * as an `unreadable` result carrying that text.
 *
 * Three preconditions are asserted first, because a test that examined nothing would pass anyway:
 *   1. the connection really is read-only (current_setting says on);
 *   2. a write through the very same client is REFUSED (the rig can fail);
 *   3. the collectors really ran and returned a result of the shape the verdict reads.
 *
 * Mutation (recorded in the PR): make a collector write (an activity-log insert) => red.
 *
 * The gate does not run `validate:db` (its constraint probe inserts rows in a rolled-back transaction and it regenerates the
 * client); it runs `db:migrate:status`, `db:schema:diff`, `db:schema:drift` and reads `pg_constraint` instead. The whole-gate part
 * of this test would go red if a write reached the database (the URL is read-only) or the checkout (the snapshot).
 */

const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/readiness-gate-read-only.test.ts would have been skipped. Use npm run test:db.',
  )
}

let originalUrl = ''

async function readOnlyDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  originalUrl = process.env.DATABASE_URL
  const url = new URL(process.env.DATABASE_URL)
  assert.equal(url.searchParams.has('options'), false, 'precondition: the test owns the options parameter of the URL')
  url.searchParams.set('options', '-c default_transaction_read_only=on')
  // This file runs in its own process (node --test runs each file separately), so changing the variable
  // here cannot reach another test file.
  process.env.DATABASE_URL = url.toString()
  const { db } = await import('../../lib/db')
  return db
}

test('[readiness gate] DB: the default collectors complete over a READ-ONLY connection (so they write nothing)', { skip }, async () => {
  const db = await readOnlyDb()

  // Precondition 1: the connection is read-only.
  const [setting] = await db.$queryRawUnsafe<Array<{ ro: string }>>(`SELECT current_setting('default_transaction_read_only') AS ro`)
  assert.equal(setting!.ro, 'on', 'precondition: the session is read-only')
  const [identity] = await db.$queryRawUnsafe<Array<{ db: string }>>(`SELECT current_database() AS db`)
  console.log(`precondition: connected to ${identity!.db} with default_transaction_read_only=${setting!.ro}`)

  // Precondition 2: the rig can fail. A write through the same client is refused by the server.
  await assert.rejects(
    () => db.$executeRawUnsafe(`INSERT INTO "activity_logs" ("id", "action", "createdAt") VALUES ('readiness-gate-control', 'CONTROL', NOW())`),
    /read-only transaction/,
    'precondition: a write over this connection is refused',
  )

  const { defaultReadOutbound, defaultReadReconciliation, defaultRunInvariant } = await import('../../lib/ops/readiness-gate-collect')

  // The collectors, called directly: a write would throw here.
  const invariant = await defaultRunInvariant()
  assert.equal(typeof invariant.result.status, 'string', 'precondition: the invariant check returned a result')
  const outbound = await defaultReadOutbound(new Date())
  assert.equal(outbound.countsAvailable, true, 'precondition: the activity log was read')
  assert.equal(outbound.connectors.length, 3)
  const reconciliation = await defaultReadReconciliation(new Date())
  assert.ok('blockers' in reconciliation && 'warnings' in reconciliation, 'precondition: the reconciliation readiness was evaluated')

  // THE WHOLE GATE, real default collectors and real children (migrate status, schema diff, drift check), over the
  // read-only URL, with a snapshot of every file of the checkout before and after.
  const { runReadinessGate } = await import('../../scripts/readiness-gate')
  const before = snapshotCheckout(process.cwd())
  console.log(`precondition: ${before.size} checkout files snapshotted (generated client, schema, lib, scripts, manifests)`)
  assert.ok(before.size > 500,  'precondition: the snapshot saw the checkout')
  const reportDir = mkdtempSync(path.join('/var/tmp', 'ims-gate-ro-'))
  try {
    const out: string[] = []
    const code = await runReadinessGate({
      argv: ['--phase', 'P0', '--report-dir', path.join(reportDir, 'reports'), '--rehearsal-dir', path.join(reportDir, 'no-rehearsals')],
      // PRISMA_DEV_DB_CONFIRM: CI's database is on another host (a service container), and the schema scripts refuse that without it;
      // it is the operator's opt-in and the gate only passes it through. The ORIGINAL url, not the read-only one: the schema commands are Prisma children, and Prisma's connection string
      // grammar does not take an `options` parameter next to `?schema=` (CI's URL has one). The server-enforced proof is the
      // direct collector calls above; this run's proof is that no file of the checkout changed and every check completed.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: originalUrl, PRISMA_DEV_DB_CONFIRM: '1' },
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      disconnect: async () => undefined,
    })
    assert.equal(code, 1, 'no rehearsal and no reconciliation run exist, so NO-GO; any other code means the gate broke')
    const [runId] = readdirSync(path.join(reportDir, 'reports'))
    const record = JSON.parse(readFileSync(path.join(reportDir, 'reports', runId!, 'readiness-gate.json'), 'utf8')) as { checks: Array<{ id: string; status: string; summary: string }> }
    const status = Object.fromEntries(record.checks.map((row) => [row.id, row.status]))
    console.log(`precondition: collected ${record.checks.length} checks; schema-state=${status['schema-state']} invariant-preflight=${status['invariant-preflight']} outbound-status=${status['outbound-status']}`)
    const summaries = Object.fromEntries(record.checks.map((row) => [row.id, row.summary]))
    console.log(`schema-state: ${summaries['schema-state']}`)
    for (const id of ['schema-state', 'invariant-preflight', 'outbound-status']) assert.equal(status[id], 'PASS', `${id} ran to completion: ${summaries[id]}`)
    assert.equal(record.checks.some((row) => /read-only transaction/.test(row.summary)), false, 'no check attempted a write')
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }
  const after = snapshotCheckout(process.cwd())
  const changed = [...after].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file)
  const removed = [...before.keys()].filter((file) => !after.has(file))
  assert.deepEqual([...changed, ...removed], [], 'the gate wrote nothing into the checkout')
})

/** The places a stray write would land (the generated client, the schema, the code, the manifests); path -> "mtimeMs:size". */
const SNAPSHOT_ROOTS = ['app/generated', 'prisma', 'lib', 'scripts', 'package.json', 'prisma.config.ts']
function snapshotCheckout(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const info = statSync(full)
        out.set(full, `${info.mtimeMs}:${info.size}`)
      }
    }
  }
  for (const entry of SNAPSHOT_ROOTS) {
    const full = path.join(root, entry)
    const info = statSync(full)
    if (info.isDirectory()) walk(full)
    else out.set(full, `${info.mtimeMs}:${info.size}`)
  }
  return out
}
