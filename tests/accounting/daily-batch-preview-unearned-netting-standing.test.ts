import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createSyncLogStore, matchesWhere, syncLogRow, type SyncLogRow } from '@/tests/fixtures/accounting-sync-log-store'

// o3d-3la07 (M6, D3) - THE DEFERRED-REVENUE NETTING IN THE DAILY-BATCH PREVIEW IS REPORT-ONLY.
//
// `computePreview` (the preview mirror of the cron's netting) nets the debit of an order's PENDING / PROCESSING / SYNCED UNEARNED_REV_REVERSAL
// rows out of the deferral Group B recognises. Two of the rows that decision rests on are not ledger
// facts (an operator-asserted SYNCED row is COUNTED on its queued figure; a CANCELLED row that may have
// posted is NOT counted). Batch 1 changes NO ARITHMETIC (the hold-out design is P2-7): this file pins
// BOTH halves, separately, so neither can be traded for the other. The cron side is pinned in
// daily-batch-unearned-netting-standing.test.ts with the same rows; the two must agree.
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

let store = createSyncLogStore([])
const nettingWheres: Array<Record<string, unknown>> = []

const SHIPMENT = {
  id: 'ship-1',
  orderId: 'order-1',
  warehouseId: 'wh-1',
  createdAt: new Date(`${BATCH_DAY}T08:00:00.000Z`),
  cogsBatchAmount: 40,
  lines: [
    {
      lineId: 'line-1',
      productId: 'prod-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'cl-1', qty: '2.000000', unitCostBase: '20.000000' }],
      line: { id: 'line-1', qty: 2, totalBase: 100 },
    },
  ],
  order: {
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'PICKING',
    refundStatus: 'NONE',
    totalBase: 100,
    unearnedRevenueAmount: 100,
    lines: [{ id: 'line-1', productId: 'prod-1', qty: 2, totalBase: 100, fulfillmentRequirements: null }],
    shipments: [{ id: 'ship-1', status: 'SHIPPED', shipmentJournalDate: null, revenueRecognizedAmount: null }],
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findMany: async () => [] },
      shipment: { findMany: async () => [SHIPMENT] },
      salesOrderRefund: { findMany: async () => [] },
      costLayer: { findMany: async () => [] },
      accountingSyncLog: {
        findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
          nettingWheres.push(where as Record<string, unknown>)
          return store.rows.filter((row) => matchesWhere(row, where))
        },
      },
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => undefined } })
mock.module('@/lib/connectors/xero/settings', {
  namedExports: { getXeroSettings: async () => ({ xero_unearned_revenue_account: '830' }) },
})
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => new Map([[productId, 1]]),
  },
})
mock.module('@/lib/products/fulfillment-requirement-snapshot', {
  namedExports: {
    lineFulfillmentRequirements: (line: { productId: string | null }) => (
      line.productId ? [{ productId: line.productId, factor: { toNumber: () => 1 } }] : []
    ),
  },
})

type RowOverrides = Partial<SyncLogRow>

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

const CASES: Array<{ name: string; standing: string; row: SyncLogRow; counted: boolean; reported: boolean }> = [
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

async function previewWith(rows: SyncLogRow[]) {
  store = createSyncLogStore(rows)
  nettingWheres.length = 0
  const { getXeroDailyBatchPreview } = await import('@/app/actions/xero-daily-batch')
  const preview = await getXeroDailyBatchPreview({ force: true })
  assert.equal(preview.groupB.shipmentCount, 1, 'PRECONDITION: the preview reached its Group B shipment')
  assert.ok(nettingWheres.length >= 1, 'PRECONDITION: the UNEARNED_REV_REVERSAL netting read was issued')
  return preview
}

test('PRECONDITION: with no reversal row the preview recognises the whole £100 and warns of nothing', async () => {
  const preview = await previewWith([])
  assert.equal(preview.groupB.totalRevenue, 100)
  assert.equal(preview.warnings, undefined)
  console.log('precondition cases: 1 (no reversal rows) -> revenue 100, no warnings')
})

for (const testCase of CASES) {
  test(`[golden arithmetic] ${testCase.name}: the preview ${testCase.counted ? 'COUNTS' : 'does NOT count'} the £30 reversal, exactly as before`, async () => {
    const preview = await previewWith([testCase.row])
    assert.equal(preview.groupB.totalRevenue, testCase.counted ? 70 : 100, `standing ${testCase.standing}`)
    console.log(`case ${testCase.name}: counted=${testCase.counted} revenue=${preview.groupB.totalRevenue}`)
  })

  test(`[report] ${testCase.name}: ${testCase.reported ? 'ONE warning names the row' : 'NO warning'}`, async () => {
    const preview = await previewWith([testCase.row])
    const warnings = preview.warnings ?? []
    if (!testCase.reported) {
      assert.equal(warnings.length, 0, `standing ${testCase.standing}: nothing to report`)
    } else {
      assert.equal(warnings.length, 1, 'exactly one warning for the one order')
      assert.match(warnings[0], new RegExp(testCase.row.id))
      assert.match(warnings[0], /arithmetic is unchanged \(report only\)/)
    }
    console.log(`case ${testCase.name}: warnings=${warnings.length} (expected ${testCase.reported ? 1 : 0})`)
  })
}

test('[the preview and the cron agree] the same read width: counted set plus the unproven cancelled rows', async () => {
  const preview = await previewWith([CASES[1].row, CASES[2].row, CASES[0].row])
  const [warning] = preview.warnings ?? []
  assert.ok(warning, 'one warning')
  assert.match(warning, /rev-asserted-posted[^;]*COUNTED/)
  assert.match(warning, /rev-asserted-not-posted[^;]*NOT counted/)
  assert.doesNotMatch(warning, /rev-confirmed/)
  assert.equal(preview.groupB.totalRevenue, 40)
  console.log('mixed case: 1 warning naming 2 rows (confirmed not named); revenue 40')
})
