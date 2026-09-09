import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import {
  collectRolloutReadiness,
  createRolloutReadinessHandler,
  getLatestAccountingReconciliationRun,
  type LatestAccountingReconciliationRunClient,
  type RolloutReadinessResponse,
} from '../../lib/ops/rollout-readiness.ts'
import { createAdminHealth, createPreflight, READINESS_FIXED_DATE } from '../fixtures/rollout-readiness.ts'

/**
 * o3d-11rf r6 (Codex r5, HIGH) — THE DEPLOYMENT GATE, AGAINST A REAL RUN ROW.
 *
 * WHAT THIS PROVES THAT THE UNIT SUITE CANNOT. Codex's finding had two halves: the readiness query
 * did not SELECT `truncations`, and the classifier did not read it. tests/ops/rollout-readiness.test
 * hands `collectRolloutReadiness` a completeness value directly, so it proves the second half and is
 * blind to the first — restore the old `select` block and every one of those tests still passes.
 * Here the value comes out of PostgreSQL, through the same `findFirst` the production adapter runs,
 * so a query that stops asking for the column turns this file red.
 *
 * AND IT IS THE WHOLE PATH. The other two readiness adapters are the shared clean doubles, so the
 * only thing standing between the report and `ready` is what the run row says about its own
 * completeness. A row that says nothing must not produce `ready`; a row that says `[]` must.
 *
 * ROLLED BACK, ALWAYS. Every test runs inside a transaction that aborts. Gated behind
 * RUN_DB_MIGRATION_TESTS=1 (`npm run test:unit` has no database), against a database built from
 * `prisma migrate deploy`. Imports are RELATIVE for the same reason as the rest of tests/db/*.
 */

const skip = process.env.RUN_DB_MIGRATION_TESTS !== '1'

/** Thrown to roll the probe transaction back. Nothing else may throw it. */
class RollbackProbe extends Error {}

type Tx = LatestAccountingReconciliationRunClient & {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>
}

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_MIGRATION_TESTS=1')
  }
}

async function withRollback<T>(fn: (tx: Tx) => Promise<T>, timeout = 60_000): Promise<T> {
  loadEnv()
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

/**
 * Write one COMPLETED run with zero findings — clean by every signal the gate reads EXCEPT the one
 * under test. `truncationsJson` is passed as raw SQL text so `NULL` can be written as an actual SQL
 * NULL rather than as the JSON literal `null`, which is a different value in a JSONB column and
 * would make the test agree with itself instead of with the database.
 */
async function insertRun(tx: Tx, id: string, truncationsSql: string) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_reconciliation_runs"
       ("id", "fromDate", "toDate", "status", "totalCount", "warningCount", "criticalCount",
        "createdAt", "truncations")
     VALUES ($1, NULL, NULL, 'COMPLETED', 0, 0, 0, now() + interval '1 day', ${truncationsSql})`,
    id,
  )
}

function readinessAdapters(tx: Tx) {
  return {
    now: () => READINESS_FIXED_DATE,
    runPreflight: async () => createPreflight(),
    collectAdminHealth: async () => createAdminHealth(),
    latestAccountingReconciliationRun: () => getLatestAccountingReconciliationRun(tx),
  }
}

/**
 * o3d-11rf r7 — THE ANSWER DEPLOYMENT TOOLING ACTUALLY READS, for a row that came out of PostgreSQL.
 *
 * The severity split this file proves is only worth anything at the HTTP boundary: `blocker` and
 * `warning` differ precisely in that `?allowWarnings=true` converts the second to 200 and cannot
 * touch the first. A test that stopped at `report.status` would be re-asserting the classifier.
 */
async function gateStatuses(report: RolloutReadinessResponse) {
  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => report,
  })
  const plain = await handler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  const overridden = await handler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  return { plain: plain.status, overridden: overridden.status }
}

test('o3d-11rf r6: a run row with a NULL truncations column does not read as ready at the rollout gate', { skip }, async () => {
  await withRollback(async (tx) => {
    await insertRun(tx, 'o3d-11rf-r6-null', 'NULL')

    // THE QUERY. This is the half a fixture cannot reach: the column has to be asked for.
    const latest = await getLatestAccountingReconciliationRun(tx)
    assert.equal(latest?.id, 'o3d-11rf-r6-null', 'the row under test is the one the gate picked up')
    assert.equal(latest?.status, 'COMPLETED')
    assert.equal(latest?.warningCount, 0)
    assert.equal(latest?.criticalCount, 0)
    assert.equal(latest?.completeness.state, 'unknown',
      'a NULL column is unknown completeness, read out of PostgreSQL and not out of a fixture')
    assert.equal(latest?.completeness.truncations, null)

    // THE GATE. Everything else is clean, so `ready` here would be the deploy going ahead on a run
    // that never said whether the check this branch adds had run at all.
    const report = await collectRolloutReadiness(readinessAdapters(tx))
    assert.notEqual(report.status, 'ready', 'unknown completeness is not a green light')
    assert.equal(report.ok, false)
    assert.equal(
      report.warnings.some((finding) => finding.id === 'accounting-reconciliation:completeness-unknown'),
      true,
      'and the gate says so by name',
    )

    // o3d-11rf r7 — a NULL column is the state of EVERY row on the deploy that ships the column, so
    // this one stays a warning and stays overridable. That is deliberate, and it is the boundary the
    // two tests below are on the other side of.
    assert.deepEqual(await gateStatuses(report), { plain: 412, overridden: 200 })
  })
})

test('o3d-11rf r6: the same row recording [] IS ready, so the gate is stopped by the missing claim and not by the column', { skip }, async () => {
  await withRollback(async (tx) => {
    await insertRun(tx, 'o3d-11rf-r6-empty', `'[]'::jsonb`)

    const latest = await getLatestAccountingReconciliationRun(tx)
    assert.equal(latest?.id, 'o3d-11rf-r6-empty')
    assert.equal(latest?.completeness.state, 'complete', 'an empty array is proven completeness')
    assert.deepEqual(latest?.completeness.truncations, [])

    const report = await collectRolloutReadiness(readinessAdapters(tx))
    assert.equal(report.status, 'ready', 'a run that proved itself complete clears the gate')
    assert.equal(report.ok, true)
    assert.deepEqual(report.warnings, [])
    assert.deepEqual(await gateStatuses(report), { plain: 200, overridden: 200 },
      'and needs no override to do it, so the 412s below are about completeness and not about the fixture')
  })
})

test('o3d-11rf r7: a row recording a truncation blocks the gate, and the override does not get past it', { skip }, async () => {
  await withRollback(async (tx) => {
    await insertRun(
      tx,
      'o3d-11rf-r6-truncated',
      `'[{"code":"void_mirror_basis_unknown_contradictions_truncated","message":"917 found, 500 reported","details":{"reported":500,"total":917}}]'::jsonb`,
    )

    const latest = await getLatestAccountingReconciliationRun(tx)
    assert.equal(latest?.completeness.state, 'truncated')
    assert.deepEqual(
      latest?.completeness.truncations?.map((truncation) => truncation.code),
      ['void_mirror_basis_unknown_contradictions_truncated'],
    )

    const report = await collectRolloutReadiness(readinessAdapters(tx))
    assert.equal(report.status, 'blocked')
    const blocker = report.blockers.find((finding) => finding.id === 'accounting-reconciliation:truncated')
    assert(blocker, 'the gate reports the report as incomplete, not merely as carrying warnings')
    assert.deepEqual(blocker?.details?.codes, ['void_mirror_basis_unknown_contradictions_truncated'])

    // o3d-11rf r7 (Codex r6, HIGH) — THE DECISIVE ONE. A run that says its own findings are short is
    // a fact about real data, not an artefact of this deploy, and `allowWarnings` records nothing
    // about who accepted it or why (o3d-yby2). So the override must not reach it.
    assert.deepEqual(await gateStatuses(report), { plain: 412, overridden: 412 })
  })
})

test('o3d-11rf r7: a row holding a payload the reader cannot parse blocks the gate, override or not', { skip }, async () => {
  await withRollback(async (tx) => {
    // A JSONB value that is neither NULL nor an array of sentinels. Nothing in this codebase writes
    // one — `persistAccountingReconciliationReport` always writes the array — so this is corruption
    // or an unexplained writer, and there is no correct deploy on which it is expected.
    await insertRun(tx, 'o3d-11rf-r7-unreadable', `'{"truncated": true}'::jsonb`)

    const latest = await getLatestAccountingReconciliationRun(tx)
    assert.equal(latest?.id, 'o3d-11rf-r7-unreadable')
    assert(latest && latest.completeness.state === 'unknown' && latest.completeness.reason === 'unreadable',
      'read out of PostgreSQL, an unparseable payload fails closed to unreadable rather than to complete')

    const report = await collectRolloutReadiness(readinessAdapters(tx))
    assert.equal(report.status, 'blocked')
    assert.equal(
      report.blockers.some((finding) => finding.id === 'accounting-reconciliation:completeness-unreadable'),
      true,
      'and it is reported apart from the run that merely never said',
    )
    assert.deepEqual(await gateStatuses(report), { plain: 412, overridden: 412 })
  })
})

test('o3d-11rf r6: nothing was left behind', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db')
  const surviving = await db.accountingReconciliationRun.count({
    where: { id: { in: ['o3d-11rf-r6-null', 'o3d-11rf-r6-empty', 'o3d-11rf-r6-truncated', 'o3d-11rf-r7-unreadable'] } },
  })
  assert.equal(surviving, 0, 'every probe transaction aborted')
})
