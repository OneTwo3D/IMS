import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import { getAccountingReconciliationHistory, type ReconciliationHistoryClient } from '../../lib/ops/rollout-readiness'
import { evaluateReconciliationProof } from '../../lib/ops/reconciliation-proof'

/**
 * o3d-6e4v — THE HISTORY READER'S SQL, AGAINST A REAL POSTGRES.
 *
 * The completeness proof is only as good as the rows it is handed, and the reader picks them with jsonb
 * predicates (`jsonb_typeof`, `jsonb_array_length`) and a NULL/JSON-null distinction that no test double
 * can be trusted to reproduce: a double that answered "no truncated run exists" would make every gate
 * verdict green. So the reader runs here against the migrated schema, inside a transaction that is rolled
 * back, over a table the test empties first (inside that transaction) so only its own runs are read.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/rollout-readiness-reconciliation-proof.test.ts would have been skipped. Use npm run test:db.',
  )
}

class RollbackProbe extends Error {}
type Tx = ReconciliationHistoryClient & { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> }

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 4, 1, 10)
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const TRUNCATED = JSON.stringify([{ code: 'reconciliation_row_cap_reached', message: 'more exist', details: { total: 9 } }])

async function insertRun(tx: Tx, id: string, createdDaysAgo: number, windowDays: number, truncations: string | null) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_reconciliation_runs"
       ("id", "fromDate", "toDate", "status", "totalCount", "warningCount", "criticalCount", "createdAt", "truncations")
     VALUES ($1, $2::timestamp, $3::timestamp, 'COMPLETED', 0, 0, 0, $4::timestamp, $5::jsonb)`,
    id, at(createdDaysAgo + windowDays), at(createdDaysAgo), at(createdDaysAgo), truncations,
  )
}

const newest = (id: string, truncations: unknown) => ({
  id, status: 'COMPLETED' as const, totalCount: 0, warningCount: 0, criticalCount: 0, createdAt: at(0), truncations,
})

test('[o3d-6e4v] DB: a clean newest run over an uncovered earlier truncation reads as NOT proven', { skip }, async () => {
  const proof = await withRollback(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM "accounting_reconciliation_runs"')
    await insertRun(tx, 'p6e4v-null', 400, 90, null)          // pre-column: makes no statement
    await insertRun(tx, 'p6e4v-old', 90, 90, TRUNCATED)       // truncated three months ago
    await insertRun(tx, 'p6e4v-new', 0, 90, '[]')             // clean, but a different 90 days
    const history = await getAccountingReconciliationHistory(newest('p6e4v-new', []), tx)
    assert.deepEqual(history.runs.map((r) => r.id), ['p6e4v-old', 'p6e4v-new'],
      'the reader starts at the oldest truncated run and leaves NULL rows out')
    assert.equal(history.recordedBeforeNewest, true)
    return evaluateReconciliationProof({ id: 'p6e4v-new', status: 'COMPLETED', truncations: [] }, history)
  })
  assert.equal(proof.state, 'not-proven')
  assert.deepEqual(proof.state === 'not-proven' ? proof.unresolved.map((u) => u.runId) : [], ['p6e4v-old'])
})

test('[o3d-6e4v] DB: a later run whose window contains the truncated one proves it', { skip }, async () => {
  const proof = await withRollback(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM "accounting_reconciliation_runs"')
    await insertRun(tx, 'p6e4v-old', 90, 90, TRUNCATED)
    await insertRun(tx, 'p6e4v-new', 0, 200, '[]')
    return evaluateReconciliationProof({ id: 'p6e4v-new', status: 'COMPLETED', truncations: [] }, await getAccountingReconciliationHistory(newest('p6e4v-new', []), tx))
  })
  assert.deepEqual(proof, { state: 'proven' })
})

test('[o3d-6e4v] DB: a JSON payload that is not an array is read as UNREADABLE, and JSON null is not SQL NULL', { skip }, async () => {
  const result = await withRollback(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM "accounting_reconciliation_runs"')
    await insertRun(tx, 'p6e4v-object', 30, 90, '{"shape":"future"}')
    await insertRun(tx, 'p6e4v-jsonnull', 20, 90, 'null')
    await insertRun(tx, 'p6e4v-new', 0, 90, '[]')
    const history = await getAccountingReconciliationHistory(newest('p6e4v-new', []), tx)
    return { ids: history.runs.map((r) => r.id), proof: evaluateReconciliationProof({ id: 'p6e4v-new', status: 'COMPLETED', truncations: [] }, history) }
  })
  assert.deepEqual(result.ids, ['p6e4v-object', 'p6e4v-jsonnull', 'p6e4v-new'],
    'the object and the JSON null are both non-NULL records, so both are read')
  assert.equal(result.proof.state, 'not-proven')
  assert.deepEqual(result.proof.state === 'not-proven' ? result.proof.unresolved.map((u) => [u.runId, u.code]) : [],
    [['p6e4v-object', '*'], ['p6e4v-jsonnull', '*']])
})

test('[o3d-6e4v] DB: with NO truncated run the reader returns nothing, and says whether recording had begun', { skip }, async () => {
  const [before, first] = await withRollback(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM "accounting_reconciliation_runs"')
    await insertRun(tx, 'p6e4v-recorded', 10, 90, '[]')
    await insertRun(tx, 'p6e4v-null-newest', 0, 90, null)
    const afterRecording = await getAccountingReconciliationHistory(newest('p6e4v-null-newest', null), tx)
    await tx.$executeRawUnsafe(`DELETE FROM "accounting_reconciliation_runs" WHERE "id" = 'p6e4v-recorded'`)
    const onlyNull = await getAccountingReconciliationHistory(newest('p6e4v-null-newest', null), tx)
    return [afterRecording, onlyNull]
  })
  assert.deepEqual(before, { runs: [], overflow: false, recordedBeforeNewest: true })
  assert.deepEqual(first, { runs: [], overflow: false, recordedBeforeNewest: false })
})

// ---------------------------------------------------------------------------------------------------
// THE SNAPSHOT: a reconciliation that lands between the two reads must not change what the proof sees.
// ---------------------------------------------------------------------------------------------------

test('[o3d-6e4v] DB: a complete run committed BETWEEN the newest-run read and the history read is NOT in the history (one REPEATABLE READ snapshot)', { skip }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('../../lib/db')
  const { getAccountingReconciliationSnapshot, collectAccountingReconciliationReadiness } = await import('../../lib/ops/rollout-readiness')
  const prefix = `rrsnap-${Date.now().toString(36)}-`
  const insert = (id: string, createdAt: string, from: string, to: string, truncations: string) => db.$executeRawUnsafe(
    `INSERT INTO "accounting_reconciliation_runs"
       ("id", "fromDate", "toDate", "status", "totalCount", "warningCount", "criticalCount", "createdAt", "truncations")
     VALUES ($1, $2::timestamp, $3::timestamp, 'COMPLETED', 0, 0, 0, $4::timestamp, $5::jsonb)`,
    id, from, to, createdAt, truncations,
  )
  try {
    // Dates in 2099 so these two are the newest rows whatever else the shared database holds.
    await insert(`${prefix}T`, '2099-03-01T00:00:00', '2098-12-01T00:00:00', '2099-03-01T00:00:00', TRUNCATED)
    let injected = false
    const snapshot = await getAccountingReconciliationSnapshot({
      afterLatestRead: async () => {
        // A DIFFERENT connection commits a later complete run whose window contains T's.
        await insert(`${prefix}C`, '2099-03-02T00:00:00', '2098-11-01T00:00:00', '2099-03-02T00:00:00', '[]')
        injected = true
      },
    })
    assert.equal(injected, true, 'precondition: the interleaving ran between the two reads')
    assert.equal(snapshot.latest?.id, `${prefix}T`, 'precondition: T was the newest run when it was read')
    const committed = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "accounting_reconciliation_runs" WHERE "id" = $1`, `${prefix}C`)
    assert.equal(committed.length, 1, 'precondition: C really is committed and visible to a new reader')
    assert.ok(!('unreadable' in snapshot.history), 'the history was readable')
    const ids = 'runs' in snapshot.history ? snapshot.history.runs.map((r) => r.id) : []
    console.log(`precondition: snapshot history ids ${JSON.stringify(ids.filter((id) => id.startsWith(prefix)))}`)
    assert.equal(ids.includes(`${prefix}C`), false, 'C was committed after the snapshot began, so the history must not contain it')
    assert.equal(ids.includes(`${prefix}T`), true)

    // And through the readiness evaluation: T is still an UNRESOLVED truncation in that snapshot, so it blocks and says why.
    const readiness = await collectAccountingReconciliationReadiness({ accountingReconciliationSnapshot: async () => snapshot }, new Date('2099-03-03T00:00:00Z'))
    assert.ok(readiness.blockers.some((b) => b.id === 'accounting-reconciliation:truncation-unresolved'), 'blocked by the unresolved truncation')
  } finally {
    await db.$executeRawUnsafe(`DELETE FROM "accounting_reconciliation_runs" WHERE "id" LIKE $1`, `${prefix}%`)
  }
})

// ---------------------------------------------------------------------------------------------------
// TIES, through the SQL reader: two rows with the IDENTICAL createdAt (set explicitly).
// ---------------------------------------------------------------------------------------------------

test('[o3d-6e4v] DB: tied newest runs are read as a GROUP: COMPLETED + PARTIAL blocks; COMPLETED + COMPLETED with a truncation in one is not proven', { skip }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('../../lib/db')
  const { getAccountingReconciliationSnapshot, collectAccountingReconciliationReadiness } = await import('../../lib/ops/rollout-readiness')
  const prefix = `rrtie-${Date.now().toString(36)}-`
  const AT = '2099-06-01T00:00:00'
  const insert = (id: string, status: string, from: string, truncations: string) => db.$executeRawUnsafe(
    `INSERT INTO "accounting_reconciliation_runs"
       ("id", "fromDate", "toDate", "status", "totalCount", "warningCount", "criticalCount", "createdAt", "truncations")
     VALUES ($1, $2::timestamp, $3::timestamp, $4, 0, 0, 0, $5::timestamp, $6::jsonb)`,
    id, from, AT, status, AT, truncations,
  )
  const readiness = async () => collectAccountingReconciliationReadiness({ accountingReconciliationSnapshot: () => getAccountingReconciliationSnapshot() }, new Date('2099-06-02T00:00:00Z'))
  try {
    // Shape 1: COMPLETED (id sorts first) and PARTIAL at the same instant.
    await insert(`${prefix}a`, 'COMPLETED', '2099-03-01T00:00:00', '[]')
    await insert(`${prefix}b`, 'PARTIAL', '2099-03-01T00:00:00', '[]')
    const snapshot = await getAccountingReconciliationSnapshot()
    console.log(`precondition: newest group ${JSON.stringify(snapshot.latest?.tiedRunIds)} status ${snapshot.latest?.status}`)
    assert.deepEqual(snapshot.latest?.tiedRunIds, [`${prefix}a`, `${prefix}b`], 'both tied rows were read')
    assert.equal(snapshot.latest?.status, 'PARTIAL', 'the group is assessed as its worst member')
    const first = await readiness()
    assert.ok(first.blockers.some((b) => b.id === 'accounting-reconciliation:newest-run-not-completed'), 'COMPLETED/PARTIAL tie blocks')

    // Shape 2: COMPLETED + COMPLETED at the same instant, one truncated, the OTHER one's window containing it.
    await db.$executeRawUnsafe(`DELETE FROM "accounting_reconciliation_runs" WHERE "id" LIKE $1`, `${prefix}%`)
    await insert(`${prefix}a`, 'COMPLETED', '2099-03-01T00:00:00', TRUNCATED)
    await insert(`${prefix}b`, 'COMPLETED', '2098-01-01T00:00:00', '[]')
    const second = await readiness()
    assert.ok(second.blockers.some((b) => b.id === 'accounting-reconciliation:truncation-unresolved'), 'a tied member cannot clear its sibling: not proven, blocked')
    assert.notEqual(second.proof?.state, 'proven')
  } finally {
    await db.$executeRawUnsafe(`DELETE FROM "accounting_reconciliation_runs" WHERE "id" LIKE $1`, `${prefix}%`)
  }
})

// ---------------------------------------------------------------------------------------------------
// THE NEWEST RUN OF ANY STATUS, through the SQL reader.
//
// accounting_reconciliation_runs_status_check (20260517153500) lets only COMPLETED, FAILED and PARTIAL exist today, so a
// RUNNING or unrecognised row is impossible in this schema. The reader must still never SKIP such a row (a future migration
// widening the check would otherwise make an unfinished run invisible), so this test drops the constraint INSIDE a
// transaction that is always rolled back, inserts the rows, reads them through the real reader and rolls back. Nothing
// is committed; the table is locked for the few milliseconds the transaction lives.
// ---------------------------------------------------------------------------------------------------

test('[o3d-6e4v] DB: a RUNNING or unrecognised-status row NEWER than (or tied with) a clean COMPLETED row is the newest run and BLOCKS', { skip }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('../../lib/db')
  const { getAccountingReconciliationSnapshot, collectAccountingReconciliationReadiness } = await import('../../lib/ops/rollout-readiness')
  const readiness = (tx: unknown) => collectAccountingReconciliationReadiness(
    { accountingReconciliationSnapshot: () => getAccountingReconciliationSnapshot({ client: { $transaction: (async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) as never } }) },
    new Date('2099-09-02T00:00:00Z'),
  )
  const shapes: Array<[string, Array<[string, string, string]>, string]> = [
    ['COMPLETED then a NEWER RUNNING row', [['a', 'COMPLETED', '2099-09-01T00:00:00'], ['b', 'RUNNING', '2099-09-01T00:00:01']], 'RUNNING'],
    ['COMPLETED then a NEWER row of an unrecognised status', [['a', 'COMPLETED', '2099-09-01T00:00:00'], ['b', 'weird', '2099-09-01T00:00:01']], 'weird'],
    ['COMPLETED and a RUNNING row at the SAME instant', [['a', 'COMPLETED', '2099-09-01T00:00:00'], ['b', 'RUNNING', '2099-09-01T00:00:00']], 'RUNNING'],
    ['COMPLETED and an unrecognised row at the SAME instant', [['a', 'COMPLETED', '2099-09-01T00:00:00'], ['b', 'weird', '2099-09-01T00:00:00']], 'weird'],
  ]
  let examined = 0
  class RollbackProbe extends Error {}
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`)
      await tx.$executeRawUnsafe(`ALTER TABLE "accounting_reconciliation_runs" DROP CONSTRAINT "accounting_reconciliation_runs_status_check"`)
      await tx.$executeRawUnsafe('DELETE FROM "accounting_reconciliation_runs"')
      const insert = (id: string, status: string, createdAt: string) => tx.$executeRawUnsafe(
        `INSERT INTO "accounting_reconciliation_runs"
           ("id", "fromDate", "toDate", "status", "totalCount", "warningCount", "criticalCount", "createdAt", "truncations")
         VALUES ($1, '2098-01-01'::timestamp, $2::timestamp, $3, 0, 0, 0, $2::timestamp, '[]'::jsonb)`,
        id, createdAt, status,
      )
      // Control: a lone clean COMPLETED row is proven (so the blockers below are the shapes', not the rig's).
      await insert('rrany-a', 'COMPLETED', '2099-09-01T00:00:00')
      const control = await readiness(tx)
      assert.equal(control.blockers.length, 0, `control: a clean COMPLETED newest run does not block (${control.blockers.map((b) => b.id).join(',')})`)
      assert.equal(control.proof?.state, 'proven')
      console.log('precondition: the control (lone COMPLETED row) is proven; now the any-status shapes')
      for (const [label, rows, worst] of shapes) {
        await tx.$executeRawUnsafe('DELETE FROM "accounting_reconciliation_runs"')
        for (const [suffix, status, at] of rows) await insert(`rrany-${suffix}`, status, at)
        const snapshot = await getAccountingReconciliationSnapshot({ client: { $transaction: (async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) as never } })
        assert.equal(snapshot.latest?.status, worst, `${label}: the newest run is the ${worst} row`)
        const result = await readiness(tx)
        assert.ok(result.blockers.some((b) => b.id === 'accounting-reconciliation:in-progress-or-unrecognised'), `${label}: blocked as in progress / unrecognised`)
        assert.ok(result.blockers.some((b) => b.id === 'accounting-reconciliation:newest-run-not-completed'), `${label}: the proof refuses it too`)
        examined += 1
      }
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  console.log(`precondition: ${examined} any-status shapes examined`)
  assert.equal(examined, shapes.length)
  // Nothing was committed: the constraint is still there.
  const [still] = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'accounting_reconciliation_runs_status_check'`)
  assert.equal(still!.n, 1, 'the rolled-back transaction left the status check in place')
})
