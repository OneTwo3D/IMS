import assert from 'node:assert/strict'
import test from 'node:test'
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
 *   1. the connection really is read-only (SHOW says on);
 *   2. a write through the very same client is REFUSED (the rig can fail);
 *   3. the collectors really ran and returned a result of the shape the verdict reads.
 *
 * Mutation (recorded in the PR): make a collector write (an activity-log insert) => red.
 *
 * `validate:db` is NOT covered by this proof and cannot be: it opens a transaction, inserts a probe product
 * and warehouse to make the CHECK constraints fire, and rolls it back. That is stated in the operator docs.
 */

const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/readiness-gate-read-only.test.ts would have been skipped. Use npm run test:db.',
  )
}

async function readOnlyDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
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
  const [setting] = await db.$queryRawUnsafe<Array<{ ro: string }>>(`SHOW default_transaction_read_only`)
  assert.equal(setting!.ro, 'on', 'precondition: the session is read-only')
  const [identity] = await db.$queryRawUnsafe<Array<{ db: string }>>(`SELECT current_database() AS db`)
  console.log(`precondition: connected to ${identity!.db} with default_transaction_read_only=${setting!.ro}`)

  // Precondition 2: the rig can fail. A write through the same client is refused by the server.
  await assert.rejects(
    () => db.$executeRawUnsafe(`INSERT INTO "activity_logs" ("id", "action", "createdAt") VALUES ('readiness-gate-control', 'CONTROL', NOW())`),
    /read-only transaction/,
    'precondition: a write over this connection is refused',
  )

  const { defaultReadOutbound, defaultReadReconciliation, defaultRunInvariant, collectGateResults } = await import('../../lib/ops/readiness-gate-collect')

  // The collectors, called directly: a write would throw here.
  const invariant = await defaultRunInvariant()
  assert.equal(typeof invariant.result.status, 'string', 'precondition: the invariant check returned a result')
  const outbound = await defaultReadOutbound(new Date())
  assert.equal(outbound.countsAvailable, true, 'precondition: the activity log was read')
  assert.equal(outbound.connectors.length, 3)
  const reconciliation = await defaultReadReconciliation(new Date())
  assert.ok('blockers' in reconciliation && 'warnings' in reconciliation, 'precondition: the reconciliation readiness was evaluated')

  // The whole collection with the real default collectors (validate:db and the pack are not database reads).
  const { results } = await collectGateResults(
    { phase: 'P0', expectGranted: null, rehearsalDir: '/var/tmp/ims-readiness-gate-nonexistent' },
    {
      now: () => new Date(),
      runInvariant: defaultRunInvariant,
      readOutbound: () => defaultReadOutbound(new Date()),
      readReconciliation: defaultReadReconciliation,
      runScript: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      readPackageScripts: () => ({}),
      readNewestRehearsal: () => ({ none: 'not under test' }),
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL },
      repoRoot: process.cwd(),
    },
  )
  const readOnlyRefusals = Object.entries(results).filter(([, result]) => JSON.stringify(result).includes('read-only transaction'))
  console.log(`precondition: ${Object.keys(results).length} results collected; ${readOnlyRefusals.length} mention a read-only refusal`)
  assert.equal(Object.keys(results).length, 21)
  assert.deepEqual(readOnlyRefusals, [], 'no collector attempted a write')
  for (const id of ['invariant-preflight', 'outbound-status', 'reconciliation-completeness']) {
    assert.notEqual(results[id]!.kind, 'unreadable', `${id} was readable over the read-only connection`)
  }
})
