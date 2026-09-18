import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-sidy review M2 — THE GROUP B RECREATE SWEEP REBUILT A NEGATIVE COGS REVENUE-ONLY.
//
// The sweep rebuilds a lost or cancelled Group B journal from each shipment's LIVE cogsBatchAmount,
// which a landed-cost revaluation rewrites (refreshShipmentCogsForCostLayerChange). A revalued
// negative went through the same `> 0` gate the live batch had: the review observed a rebuilt journal
// whose narration read "COGS £-6.00" carrying only the revenue pair, and a DISPATCH subledger row at
// the negative amount. The sweep now refuses the batch by name, the way it already refuses an A2
// batch whose share it cannot establish, and a later sweep rebuilds it once the basis is corrected.
//
// Drives the real recreateMissingDailyBatchLogs against the in-memory doubles of
// daily-batch-recreate-persisted-ref.test.ts, trimmed to Group B.

type SyncLogRow = { connector: string; type: string; referenceId: string; status: string }
let shipmentRows: unknown[] = []
const created: Array<{ type: string; referenceId: string; payload: Record<string, unknown> }> = []
const cogsMovements: Array<{ sourceRef: string; baseDelta: unknown }> = []
const syncLogs: SyncLogRow[] = []

const tx = {
  accountingSyncLog: {
    create: async ({ data }: { data: { type: string; referenceId: string; payload: Record<string, unknown> } }) => {
      created.push({ type: data.type, referenceId: data.referenceId, payload: data.payload })
      return { id: `log-${created.length}` }
    },
  },
  salesOrder: { update: async () => ({}) },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-A' }) },
      salesOrder: { findMany: async () => [] },
      shipment: { findMany: async () => shipmentRows },
      accountingSyncLog: { count: async () => 0, findMany: async () => syncLogs },
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    mirrorAccountingSyncLogToEvent: async () => undefined,
    resetMirroredAccountingEventsToPending: async () => undefined,
    updateMirroredAccountingEventStatus: async () => undefined,
  },
})
mock.module('@/lib/connectors/xero/outbox', { namedExports: { scheduleXeroAccountingOutbox: async () => undefined } })
mock.module('@/lib/domain/accounting/cogs-subledger-movement', {
  namedExports: {
    recordCogsSubledgerMovement: async (_client: unknown, args: { sourceRef: string; baseDelta: unknown }) => {
      cogsMovements.push({ sourceRef: args.sourceRef, baseDelta: args.baseDelta })
    },
  },
})

const SETTINGS = {
  xero_sales_account: '200',
  xero_unearned_revenue_account: '830',
  xero_inventory_account: '630',
  xero_allocated_inventory_account: '631',
  xero_cogs_account: '310',
} as never
const STAMP = new Date('2026-07-20T09:00:00.000Z')
const REF = 'B-2026-07-20-1a2b3c4d'

function reset(rows: unknown[]) {
  shipmentRows = rows
  created.length = 0
  cogsMovements.length = 0
}

async function sweep() {
  const { recreateMissingDailyBatchLogs, NegativeCostBasisRefusal } = await import('@/lib/connectors/xero/daily-sync')
  const collected: InstanceType<typeof NegativeCostBasisRefusal>[] = []
  const refusals = await recreateMissingDailyBatchLogs(SETTINGS, 'GBP', collected)
  return { refusals, collected }
}

test('o3d-sidy M2: a lost Group B batch whose shipment was revalued NEGATIVE is refused by name, not rebuilt revenue-only', async () => {
  // The review's observation: one journaled shipment, revenue 10, cogsBatchAmount revalued to -6,
  // its journal missing.
  reset([{ id: 'ship-neg', shipmentJournalDate: STAMP, shipmentJournalBatchRef: REF, revenueRecognizedAmount: 10, cogsBatchAmount: -6 }])

  const { refusals, collected } = await sweep()

  assert.deepEqual(created, [], 'no journal is rebuilt — least of all a revenue-only one')
  assert.deepEqual(cogsMovements, [], 'and no negative DISPATCH row is written to the subledger')
  const named = refusals.filter((refusal) => refusal.startsWith(`Daily batch DAILY_BATCH_GROUP_B not recreated: ${REF}`))
  assert.equal(named.length, 1, `refused by batch, in the sweep's own refusal list: ${JSON.stringify(refusals)}`)
  assert.match(named[0], /ship-neg \(COGS -6\.00\)/, 'naming the shipment and its negative COGS')
  assert.equal(collected.length, 1, 'and handed to the run so it is reported with the others')
  assert.equal(collected[0].message, named[0])
  assert.equal(collected[0].detail.group, 'B_RECREATE')
})

test('o3d-sidy M2: a batch holding one negative shipment among healthy ones is refused whole, not netted', async () => {
  reset([
    { id: 'ship-ok', shipmentJournalDate: STAMP, shipmentJournalBatchRef: REF, revenueRecognizedAmount: 100, cogsBatchAmount: 40 },
    { id: 'ship-neg', shipmentJournalDate: STAMP, shipmentJournalBatchRef: REF, revenueRecognizedAmount: 10, cogsBatchAmount: -6 },
  ])

  const { refusals } = await sweep()

  assert.deepEqual(created, [], 'rebuilding it would post COGS 34.00 for a batch whose healthy half cost 40.00')
  assert.equal(refusals.filter((refusal) => refusal.includes(REF) && /negative/.test(refusal)).length, 1)
})

test('o3d-sidy M2: a healthy lost batch is still rebuilt exactly as before', async () => {
  reset([{ id: 'ship-ok', shipmentJournalDate: STAMP, shipmentJournalBatchRef: REF, revenueRecognizedAmount: 100, cogsBatchAmount: 40 }])

  const { refusals } = await sweep()

  assert.deepEqual(refusals.filter((refusal) => /negative/.test(refusal)), [])
  assert.equal(created.length, 1, 'rebuilt')
  const lines = created[0].payload.lines as Array<{ accountCode: string; debit?: number }>
  assert.equal(lines.find((line) => line.accountCode === '310')?.debit, 40, 'with its COGS pair')
  assert.deepEqual(cogsMovements, [{ sourceRef: 'ship-ok', baseDelta: 40 }])
})
