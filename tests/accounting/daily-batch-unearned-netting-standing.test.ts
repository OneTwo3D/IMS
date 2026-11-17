import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createSyncLogStore, matchesWhere, syncLogRow, type SyncLogRow } from '@/tests/fixtures/accounting-sync-log-store'

// o3d-3la07 (M5, D3) - THE DEFERRED-REVENUE NETTING IN THE LIVE GROUP B WRITER IS REPORT-ONLY.
//
// `runDailyBatchSync` nets the debit of an order's PENDING / PROCESSING / SYNCED UNEARNED_REV_REVERSAL
// rows out of the deferral Group B recognises. Two of the rows that decision rests on are not ledger
// facts (an operator-asserted SYNCED row is COUNTED on its queued figure; a CANCELLED row that may have
// posted is NOT counted). Batch 1 changes NO ARITHMETIC (the hold-out design is P2-7): this file pins
// BOTH halves, separately, so neither can be traded for the other.
//
//   * GOLDEN ARITHMETIC: the revenue the journal recognises, per standing of the reversal row, is what
//     it was before this change (counted rows reduce it; uncounted rows do not).
//   * THE REPORT: one WARNING per order naming the rows the netting rests on that are not ledger facts,
//     and NONE for a confirmed / live / proven-not-posted row.
//
// The double honours `where` (tests/fixtures/accounting-sync-log-store.ts `matchesWhere`, which THROWS
// on an operator it does not implement): a double that ignored the query would return every row whatever
// the clause said and make the golden assertions about nothing.

const BATCH_DAY = '2026-07-20'

/** Every `shipment.update` the run made: the journaled stamp (o3d-oyur retry test). */
const shipmentUpdates: string[] = []
const created: Array<{ type: string; referenceId: string; payload: Record<string, unknown> }> = []
const activity: Array<Record<string, unknown>> = []
let store = createSyncLogStore([])
/** Every `where` the netting read was issued with, so a test can prove the read happened. */
const nettingWheres: Array<Record<string, unknown>> = []

const SHIPMENT = {
  id: 'ship-1',
  orderId: 'order-1',
  warehouseId: 'wh-1',
  createdAt: new Date(`${BATCH_DAY}T08:00:00.000Z`),
  cogsBatchAmount: 40,
  lines: [
    {
      id: 'sl-1',
      lineId: 'line-1',
      productId: 'prod-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'cl-1', qty: '2.000000', unitCostBase: '20.000000' }],
      line: { id: 'line-1', productId: 'prod-1', qty: 2, totalBase: 100 },
    },
  ],
  order: {
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'PICKING',
    refundStatus: 'NONE',
    totalBase: 100,
    unearnedRevenueAmount: 100,
    lines: [{ id: 'line-1', productId: 'prod-1', qty: 2, totalBase: 100 }],
    shipments: [{ id: 'ship-1', status: 'SHIPPED', shipmentJournalDate: null, revenueRecognizedAmount: null }],
  },
}

const tx = {
  shipment: { findMany: async () => [SHIPMENT], update: async ({ where }: { where: { id: string } }) => { shipmentUpdates.push(where.id); return { id: where.id } } },
  orderAllocation: { findMany: async () => [], update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefundLine: { findMany: async () => [] },
  salesOrderRefund: { findMany: async () => [] },
  salesOrder: { findMany: async () => [], update: async () => ({}) },
  costLayer: { update: async () => ({}) },
  accountingSyncLog: {
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      // Only the netting read is served from the store; every other read in the run is empty (this file
      // is about Group B's netting alone).
      if (!JSON.stringify(where ?? {}).includes('UNEARNED_REV_REVERSAL')) return []
      nettingWheres.push(where as Record<string, unknown>)
      return store.rows.filter((row) => matchesWhere(row, where))
    },
    updateMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: { type: string; referenceId: string; payload: Record<string, unknown> } }) => {
      created.push({ type: data.type, referenceId: data.referenceId, payload: data.payload })
      return { id: `log-${created.length}` }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
  $queryRaw: async () => [],
}

// ACC-H11: the batch imports the Xero books lock date at the start of a run; offline, and not what this file tests.
mock.module('@/lib/connectors/xero/books-lock-date', {
  namedExports: { refreshXeroBooksLockDate: async () => ({ lockDate: null, refreshed: false }) },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      salesOrder: { findMany: async () => [] },
      shipment: { findMany: async () => [] },
      accountingSyncLog: { count: async () => 0 },
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-A' }) },
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    },
  },
})
mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    acquirePinnedAdvisoryLockOrNull: async () => ({ assertHeld: () => undefined, release: async () => undefined }),
  },
})
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: 'true',
      xero_sales_account: '200',
      xero_unearned_revenue_account: '830',
      xero_inventory_account: '630',
      xero_allocated_inventory_account: '631',
      xero_cogs_account: '310',
      xero_rounding_difference_account: '',
      xero_transit_account: '',
    }),
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (params: Record<string, unknown>) => { activity.push(params) } },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    mirrorAccountingSyncLogToEvent: async () => undefined,
    resetMirroredAccountingEventsToPending: async () => undefined,
    updateMirroredAccountingEventStatus: async () => undefined,
  },
})
mock.module('@/lib/connectors/xero/outbox', { namedExports: { scheduleXeroAccountingOutbox: async () => undefined } })
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => new Map([[productId, 1]]),
  },
})
for (const [path, load, build] of [
  ['@/lib/domain/accounting/inventory-gl-reconciliation', 'loadInventoryGlReconciliation', 'buildInventoryReconciliationSweepJournal'],
  ['@/lib/domain/accounting/cogs-gl-reconciliation', 'loadCogsGlReconciliation', 'buildCogsReconciliationSweepJournal'],
  ['@/lib/domain/accounting/transit-gl-reconciliation', 'loadTransitGlReconciliation', 'buildTransitReconciliationSweepJournal'],
] as const) {
  mock.module(path, { namedExports: { [load]: async () => null, [build]: () => null } })
}
mock.module('@/lib/domain/accounting/cogs-subledger-movement', {
  namedExports: { recordCogsSubledgerMovement: async () => undefined },
})

type RowOverrides = Partial<SyncLogRow> & { abandonedBeforeRemoteCall?: boolean | null }

function reversalRow(id: string, over: RowOverrides): SyncLogRow {
  return syncLogRow({
    id,
    type: 'UNEARNED_REV_REVERSAL',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { lines: [{ accountCode: '830', debit: 30, credit: 0 }] },
    ...over,
  })
}

/** Every standing the truth table can give this row, with the figure (30) it would net if counted. */
const CASES: Array<{
  name: string
  standing: string
  row: SyncLogRow
  /** What the netting COUNTS today (golden): PENDING / PROCESSING / SYNCED only. */
  counted: boolean
  /** Does the netting rest on a row it cannot vouch for? */
  reported: boolean
}> = [
  { name: 'CONFIRMED_POSTED', standing: 'CONFIRMED_POSTED', counted: true, reported: false,
    row: reversalRow('rev-confirmed', { status: 'SYNCED', externalTransactionId: 'JNL-1', settlementBasis: null }) },
  { name: 'ASSERTED_POSTED', standing: 'ASSERTED_POSTED', counted: true, reported: true,
    row: reversalRow('rev-asserted-posted', { status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' }) },
  { name: 'ASSERTED_NOT_POSTED', standing: 'ASSERTED_NOT_POSTED', counted: false, reported: true,
    row: reversalRow('rev-asserted-not-posted', { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION' }) },
  { name: 'PROVEN_NOT_POSTED', standing: 'PROVEN_NOT_POSTED', counted: false, reported: false,
    row: reversalRow('rev-proven-not-posted', { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'VERIFIED_REVERSAL' }) },
  { name: 'UNKNOWN (cancelled, claimed attempt, no proof)', standing: 'UNKNOWN', counted: false, reported: true,
    row: reversalRow('rev-unknown', { status: 'CANCELLED', externalTransactionId: null, settlementBasis: null }) },
  { name: 'LIVE_WORK', standing: 'LIVE_WORK', counted: true, reported: false,
    row: reversalRow('rev-live', { status: 'PENDING', externalTransactionId: null, settlementBasis: null }) },
]

function recognisedRevenue(): number {
  const journal = created.find((log) => log.type === 'DAILY_BATCH_GROUP_B')
  assert.ok(journal, 'the Group B journal was created (the run reached its subject)')
  const lines = journal.payload.lines as Array<{ accountCode?: string; credit?: number; debit?: number }>
  // The unearned revenue account (830) is debited by exactly what Group B recognises.
  return lines.filter((line) => line.accountCode === '830').reduce((sum, line) => sum + Number(line.debit ?? 0), 0)
}

async function runWith(rows: SyncLogRow[]): Promise<void> {
  created.length = 0
  activity.length = 0
  nettingWheres.length = 0
  store = createSyncLogStore(rows)
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()
  assert.deepEqual(result.errors, [], 'the run must actually complete')
  assert.equal(result.groupB, 1, 'one shipment journaled')
  assert.ok(nettingWheres.length >= 1, 'PRECONDITION: the UNEARNED_REV_REVERSAL netting read was issued')
}

function netReports(): Array<Record<string, unknown>> {
  return activity.filter((entry) => entry.action === 'daily_batch_unearned_reversal_netting_unproven')
}

test('PRECONDITION: with no reversal row at all the batch recognises the whole £100 and reports nothing', async () => {
  await runWith([])
  assert.equal(recognisedRevenue(), 100)
  assert.equal(netReports().length, 0)
  console.log('precondition cases: 1 (no reversal rows) -> revenue 100, 0 reports')
})

for (const testCase of CASES) {
  test(`[golden arithmetic] ${testCase.name}: the netting ${testCase.counted ? 'COUNTS' : 'does NOT count'} the £30 reversal, exactly as before`, async () => {
    await runWith([testCase.row])
    // Counted rows reduce the deferral that is left to recognise (100 - 30); uncounted rows do not.
    assert.equal(recognisedRevenue(), testCase.counted ? 70 : 100, `standing ${testCase.standing}`)
    console.log(`case ${testCase.name}: counted=${testCase.counted} revenue=${recognisedRevenue()}`)
  })

  test(`[report] ${testCase.name}: ${testCase.reported ? 'ONE warning names the row' : 'NO warning'}`, async () => {
    await runWith([testCase.row])
    const reports = netReports()
    if (!testCase.reported) {
      assert.equal(reports.length, 0, `standing ${testCase.standing} is a ledger fact / live work / proven absent: nothing to report`)
    } else {
      assert.equal(reports.length, 1, 'exactly one warning for the one order')
      const [report] = reports
      assert.equal(report.level, 'WARNING')
      assert.equal(report.entityId, 'order-1')
      assert.match(String(report.description), new RegExp(testCase.row.id))
      assert.match(String(report.description), /arithmetic is unchanged \(report only\)/)
    }
    console.log(`case ${testCase.name}: reports=${reports.length} (expected ${testCase.reported ? 1 : 0})`)
  })
}

test('[report names the right set] asserted-counted and may-have-posted-uncounted rows are named separately, together', async () => {
  await runWith([
    CASES[1].row, // asserted POSTED: counted
    CASES[2].row, // asserted NOT_POSTED: not counted
    CASES[0].row, // confirmed: never named
  ])
  const [report] = netReports()
  assert.ok(report, 'one warning')
  const text = String(report.description)
  assert.match(text, /rev-asserted-posted[^;]*COUNTED/)
  assert.match(text, /rev-asserted-not-posted[^;]*NOT counted/)
  assert.doesNotMatch(text, /rev-confirmed/)
  assert.equal(recognisedRevenue(), 40, 'golden: both £30 counted rows (confirmed + asserted) net out of £100 -> 100 - 60')
  console.log('mixed case: 1 report naming 2 rows (confirmed not named); revenue 40')
})

// o3d-oyur (Codex r2 HIGH) - A COMPACTED REVERSAL IS READ FROM ITS PRESERVED NET, AND AN UNREADABLE ONE IS UNKNOWN, NEVER ZERO.
// Retention compaction empties `payload` on a settled reversal. Before this the batch read only `payload`, so a compacted
// £30 reversal counted as £0 and the final shipment recognised the whole £100 again.
function unreadableReports(): Array<Record<string, unknown>> {
  return activity.filter((entry) => entry.action === 'daily_batch_trueup_withheld_unreadable_unearned_reversal')
}

test('[o3d-oyur] a SYNCED reversal compacted to its summary still nets: £100 - £30 = £70, and nothing is withheld', async () => {
  await runWith([reversalRow('rev-compacted', {
    status: 'SYNCED',
    externalTransactionId: 'JNL-9',
    payload: {},
    payloadAccountNets: { version: 1, accounts: { '830': { credit: 0, debit: 30 } } },
  })])
  assert.equal(recognisedRevenue(), 70, 'NOT 100: the compacted reversal still took £30 out of the deferral')
  assert.equal(unreadableReports().length, 0)
})

test('[o3d-oyur] a legacy compacted reversal withholds the order: nothing journaled or stamped on run 1; once readable, run 2 recognises it exactly once', async () => {
  const legacy = reversalRow('rev-legacy', { status: 'SYNCED', externalTransactionId: 'JNL-8', payload: {}, payloadAccountNets: null })
  created.length = 0
  activity.length = 0
  shipmentUpdates.length = 0
  store = createSyncLogStore([legacy])
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const run1 = await runDailyBatchSync()
  assert.deepEqual(run1.errors, [])
  assert.equal(run1.groupB, 0, 'run 1: the shipment is not processed')
  assert.equal(created.filter((log) => log.type === 'DAILY_BATCH_GROUP_B').length, 0, 'run 1: no Group B journal (no revenue, no COGS)')
  assert.equal(shipmentUpdates.length, 0, 'run 1: the shipment is NOT stamped journaled, so it stays retryable')
  const [report] = unreadableReports()
  assert.ok(report, 'run 1: one warning')
  assert.equal(report.entityId, 'order-1')
  assert.equal(report.level, 'WARNING')

  // The reversal becomes readable (a summary is recorded for it); the same shipment is picked up again.
  store = createSyncLogStore([{ ...legacy, payloadAccountNets: { version: 1, accounts: { '830': { credit: 0, debit: 30 } } } }])
  created.length = 0
  activity.length = 0
  const run2 = await runDailyBatchSync()
  assert.deepEqual(run2.errors, [])
  assert.equal(run2.groupB, 1, 'run 2: the shipment is journaled')
  assert.equal(created.filter((log) => log.type === 'DAILY_BATCH_GROUP_B').length, 1, 'exactly one Group B journal')
  assert.equal(recognisedRevenue(), 70, 'run 2: £100 less the £30 the now-readable reversal took, recognised once')
  assert.equal(shipmentUpdates.length, 1, 'and the shipment is stamped exactly once')
  assert.equal(unreadableReports().length, 0)
})
