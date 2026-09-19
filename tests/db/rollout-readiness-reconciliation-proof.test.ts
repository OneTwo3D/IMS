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
    return evaluateReconciliationProof({ id: 'p6e4v-new', truncations: [] }, history)
  })
  assert.equal(proof.state, 'not-proven')
  assert.deepEqual(proof.state === 'not-proven' ? proof.unresolved.map((u) => u.runId) : [], ['p6e4v-old'])
})

test('[o3d-6e4v] DB: a later run whose window contains the truncated one proves it', { skip }, async () => {
  const proof = await withRollback(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM "accounting_reconciliation_runs"')
    await insertRun(tx, 'p6e4v-old', 90, 90, TRUNCATED)
    await insertRun(tx, 'p6e4v-new', 0, 200, '[]')
    return evaluateReconciliationProof({ id: 'p6e4v-new', truncations: [] }, await getAccountingReconciliationHistory(newest('p6e4v-new', []), tx))
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
    return { ids: history.runs.map((r) => r.id), proof: evaluateReconciliationProof({ id: 'p6e4v-new', truncations: [] }, history) }
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
