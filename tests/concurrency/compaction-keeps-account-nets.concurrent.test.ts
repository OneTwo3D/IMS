import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-oyur — COMPACTION KEEPS THE PER-ACCOUNT NET THE A2 POSTING PROOF NEEDS, AGAINST A REAL POSTGRES.
 *
 * What is claimed, and why a double cannot show it:
 *
 *   1. RETENTION'S COMPACTION WRITES THE SUMMARY IN THE SAME STATEMENT THAT EMPTIES THE PAYLOAD. The
 *      claim is about the database state a reader can observe, so it is read back from the row.
 *   2. THE PROOF GIVES THE SAME ANSWER BEFORE AND AFTER. The A2 verdict on the compacted row (payload
 *      `{}`, summary present) is the verdict on the whole row.
 *   3. A JOURNAL WHOSE PAYLOAD CANNOT BE SUMMARISED IS NEVER COMPACTED. Its payload stays, it carries no
 *      stamp, and the run reports it. A non-journal row beside it is still compacted (no summary).
 *   4. COMPACTION AND THE PROOF RUN TOGETHER. The proof reads one row per statement; compaction rewrites
 *      that row in one statement. If the summary were a separate, later statement the proof would see a
 *      window in which the lines were gone and no summary existed, and refuse. Proofs are issued in a
 *      tight loop for the whole of a compaction run and EVERY ONE must be `posted` with the same
 *      figures. (The loop is a probe of that property, not a proof of absence of races: the single
 *      statement is what guarantees it, and assertion 1 pins that the statement carries both.)
 *
 * Retention is global, so this file only creates rows two years old (past any cutoff) and restores the
 * setting it changes. Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const RUN_ID = randomUUID().slice(0, 8)
const OLD = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000)

const LINES = { narration: 'A2 batch', lines: [
  { accountCode: '631', description: 'Allocated Inventory', debit: 120.1, credit: 0 },
  { accountCode: '631', description: 'rounding', debit: 0, credit: 0.05 },
  { accountCode: '200', description: 'Inventory', debit: 0, credit: 120.05 },
] }
const ACCOUNT = '631'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

type Deps = Awaited<ReturnType<typeof loadDeps>>
async function loadDeps() {
  loadEnv()
  const [{ db }, { purgeExpiredData }, proof] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/data-retention'),
    import('@/lib/domain/accounting/allocation-debit-posting-proof'),
  ])
  return { db, purgeExpiredData, proveAllocationDebitPosting: proof.proveAllocationDebitPosting }
}

let deps: Deps
const seeded: string[] = []
let previousSetting: string | null = null

before(async () => {
  if (!RUN) return
  deps = await loadDeps()
  const row = await deps.db.setting.findUnique({ where: { key: 'retention_sync_logs_months' } })
  previousSetting = row?.value ?? null
  await deps.db.setting.upsert({
    where: { key: 'retention_sync_logs_months' },
    create: { key: 'retention_sync_logs_months', value: '1' },
    update: { value: '1' },
  })
})

after(async () => {
  if (!RUN || !deps) return
  await deps.db.accountingSyncLog.deleteMany({ where: { id: { in: seeded } } })
  if (previousSetting === null) await deps.db.setting.deleteMany({ where: { key: 'retention_sync_logs_months' } })
  else await deps.db.setting.update({ where: { key: 'retention_sync_logs_months' }, data: { value: previousSetting } })
  await deps.db.$disconnect()
})

async function seedJournal(label: string, type: 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B', payload: object): Promise<string> {
  const row = await deps.db.accountingSyncLog.create({
    data: {
      connector: 'xero',
      type,
      status: 'SYNCED',
      referenceType: 'DailyBatch',
      referenceId: `OYUR-${RUN_ID}-${label}`,
      externalTransactionId: `JNL-${RUN_ID}-${label}`,
      payload,
      createdAt: OLD,
      syncedAt: OLD,
    },
    select: { id: true },
  })
  seeded.push(row.id)
  return row.id
}

function orderFor(journalId: string, share: number) {
  const pass = { amount: share, syncLogId: journalId, connector: 'xero', accountCode: ACCOUNT, batchRef: 'A2-1', at: OLD.toISOString() }
  return {
    inventoryAllocatedDate: OLD,
    allocationBatchAmount: share,
    allocationBatchPasses: [pass],
    allocationBatchSyncLogId: journalId,
    allocationBatchConnector: 'xero',
    allocationBatchAccountCode: ACCOUNT,
  }
}

function prove(journalId: string, share = 60) {
  return deps.proveAllocationDebitPosting(
    deps.db as never,
    orderFor(journalId, share),
    { activeConnector: 'xero' as const, allocatedInventoryAccount: ACCOUNT },
  )
}

test('compaction writes the summary with the payload drop; the A2 proof is unchanged; an unsummarisable journal is kept whole', { skip: !RUN }, async () => {
  const good = await seedJournal('good', 'DAILY_BATCH_INVENTORY_ALLOC', LINES)
  const illegible = await seedJournal('bad', 'DAILY_BATCH_GROUP_B', { narration: 'no lines here', lines: 'corrupt' })
  const nonJournal = await deps.db.accountingSyncLog.create({
    data: {
      // A non-journal, non-invoice type: a confirmed xero sales invoice of an order is the one posted-record shape retention now compacts to a projection (tests/db/posted-invoice-records-kept.test.ts), not to {}.
      connector: 'xero', type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrderRefund',
      referenceId: `OYUR-${RUN_ID}-inv`, externalTransactionId: `INV-${RUN_ID}`,
      payload: { contact: { name: 'Jane Doe' }, lines: [{ description: 'x', unitAmount: 5 }] }, createdAt: OLD, syncedAt: OLD,
    },
    select: { id: true },
  })
  seeded.push(nonJournal.id)

  const before = await prove(good)
  assert.equal(before.kind, 'posted', 'PRECONDITION: the whole journal proves the debit')

  const result = await deps.purgeExpiredData()
  assert.ok(result.backReferenceEvidenceCompacted >= 2, `compacted ${result.backReferenceEvidenceCompacted}`)
  assert.ok(result.backReferenceEvidenceKeptUnsummarisable >= 1, 'the illegible journal is reported')

  const rows = await deps.db.accountingSyncLog.findMany({
    where: { id: { in: [good, illegible, nonJournal.id] } },
    select: { id: true, payload: true, payloadAccountNets: true, backReferenceEvidenceCompactedAt: true },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))

  const goodRow = byId.get(good)!
  assert.deepEqual(goodRow.payload, {}, 'the payload is dropped')
  assert.ok(goodRow.backReferenceEvidenceCompactedAt, 'and the row is stamped')
  assert.deepEqual(goodRow.payloadAccountNets, {
    version: 1,
    accounts: { '631': { credit: -120.05, debit: 120.05 }, '200': { credit: 120.05, debit: -120.05 } },
  }, 'in the same statement, the summary is there (and holds no description)')

  const illegibleRow = byId.get(illegible)!
  assert.deepEqual(illegibleRow.payload, { narration: 'no lines here', lines: 'corrupt' }, 'an illegible journal keeps its payload')
  assert.equal(illegibleRow.backReferenceEvidenceCompactedAt, null, 'and is not stamped as compacted')
  assert.equal(illegibleRow.payloadAccountNets, null)

  const nonJournalRow = byId.get(nonJournal.id)!
  assert.deepEqual(nonJournalRow.payload, {}, 'a non-journal row is still compacted')
  assert.equal(nonJournalRow.payloadAccountNets, null, 'and has no summary')

  const after = await prove(good)
  assert.deepEqual(after, before, 'the proof gives the same verdict on the compacted row')

  // And the bar did not move: a share larger than the summarised debit is still refused.
  const tooBig = await prove(good, 120.1)
  assert.equal(tooBig.kind, 'refused')

  // A second run does not touch the kept journal's neighbours again and keeps reporting it.
  const again = await deps.purgeExpiredData()
  assert.ok(again.backReferenceEvidenceKeptUnsummarisable >= 1, 'still reported next run')
  const stillThere = await deps.db.accountingSyncLog.findUnique({ where: { id: illegible }, select: { payload: true } })
  assert.deepEqual(stillThere?.payload, { narration: 'no lines here', lines: 'corrupt' })
})

test('a row compacted BEFORE the summary existed (payload gone, no summary) is still refused', { skip: !RUN }, async () => {
  const legacy = await seedJournal('legacy', 'DAILY_BATCH_INVENTORY_ALLOC', {})
  await deps.db.accountingSyncLog.update({ where: { id: legacy }, data: { backReferenceEvidenceCompactedAt: OLD } })
  const verdict = await prove(legacy)
  assert.equal(verdict.kind, 'refused')
  assert.match(verdict.kind === 'refused' ? verdict.reason : '', /no longer readable/)
  await deps.purgeExpiredData()
  const row = await deps.db.accountingSyncLog.findUnique({ where: { id: legacy }, select: { payloadAccountNets: true } })
  assert.equal(row?.payloadAccountNets, null, 'no backfill: nothing invents a summary for it')
})

test('compaction and the proof running together: every proof, before, during and after, is `posted`', { skip: !RUN }, async () => {
  const ids: string[] = []
  for (let n = 0; n < 40; n += 1) ids.push(await seedJournal(`race-${n}`, 'DAILY_BATCH_INVENTORY_ALLOC', LINES))

  let compacting = true
  const verdicts: Array<{ id: string; kind: string; reason?: string }> = []
  const prover = (async () => {
    while (compacting) {
      for (const id of ids) {
        const verdict = await prove(id)
        verdicts.push({ id, kind: verdict.kind, reason: verdict.kind === 'refused' ? verdict.reason : undefined })
      }
    }
  })()
  const compactor = deps.purgeExpiredData().finally(() => { compacting = false })
  const [result] = await Promise.all([compactor, prover])

  assert.ok(result.backReferenceEvidenceCompacted >= ids.length, `compacted ${result.backReferenceEvidenceCompacted}`)
  assert.ok(verdicts.length >= ids.length, 'the proof ran at least once per journal')
  const bad = verdicts.filter((verdict) => verdict.kind !== 'posted')
  assert.deepEqual(bad, [], 'no proof ever saw lines gone with no summary')

  const rows = await deps.db.accountingSyncLog.findMany({ where: { id: { in: ids } }, select: { payload: true, payloadAccountNets: true } })
  assert.equal(rows.length, ids.length)
  for (const row of rows) {
    assert.deepEqual(row.payload, {})
    assert.ok(row.payloadAccountNets, 'every compacted journal carries its summary')
  }
  for (const id of ids) assert.equal((await prove(id)).kind, 'posted', 'and still proves afterwards')
})
