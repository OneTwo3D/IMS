import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-o97 r3 — WHAT GROUP A2 RECORDS ABOUT THE JOURNAL IT RAISED.
//
// A2 writes `allocationBatchAmount` on every order it stamps, and a refund used to read that
// amount as proof a DR Allocated Inventory reached the ledger for that order. It is not proof of
// anything except that the pass ran and valued the order:
//
//   * the batch journal is created only when the window's ROUNDED total is positive, while the
//     per-order amount is written unconditionally;
//   * the journal is created PENDING, and the remote call that posts it is a LATER transaction
//     which can end FAILED or CANCELLED;
//   * the amount names no ledger and no account, so a reversal raised after a connector switch or
//     an account re-mapping credits somewhere the debit never was.
//
// So A2 now records, in the SAME UPDATE as the stamp and the amount: the sync log row's own
// DB-minted id (a value that cannot exist unless the row does), the connector, and the Allocated
// Inventory account code it debited — plus, on each allocation row, the pounds that row
// contributed, which is the basis a partial refund reverses at once revaluation has rewritten the
// row's pinned layers.

const created: Array<{ id: string; type: string; referenceId: string; payload: Record<string, unknown> }> = []
const orderUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
const allocationUpdates: Array<{ id: string; data: Record<string, unknown> }> = []

/** Flipped per test: how many units of cost the order's single allocation is worth. */
let layerUnitCost = 10

const ORDER = {
  id: 'order-1',
  orderNumber: 'SO-1',
  externalOrderNumber: null,
  status: 'ALLOCATED',
  allocations: [{ id: 'alloc-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4 }],
  shipments: [],
}

const tx = {
  costLayer: {
    findMany: async () => [{ id: 'cl-1', remainingQty: 100, unitCostBase: layerUnitCost }],
    update: async () => ({}),
  },
  orderAllocation: {
    findMany: async () => [],
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      allocationUpdates.push({ id: where.id, data })
      return { id: where.id }
    },
  },
  salesOrder: {
    findMany: async () => [],
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      orderUpdates.push({ id: where.id, data })
      return { id: where.id }
    },
  },
  shipment: { findMany: async () => [], update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefund: { findMany: async () => [] },
  salesOrderRefundLine: { findMany: async () => [] },
  accountingSyncLog: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: { type: string; referenceId: string; payload: Record<string, unknown> } }) => {
      const id = `a2-log-${created.length + 1}`
      created.push({ id, type: data.type, referenceId: data.referenceId, payload: data.payload })
      return { id }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
  $queryRaw: async () => [],
}

/**
 * Several passes read sales orders off the same client (the recreate sweep, Group A1, Group A2),
 * so the order is matched on the A2 window's own predicate — `revenueDeferredDate` set and
 * `inventoryAllocatedDate` still null — rather than on call order, which would silently hand the
 * fixture to whichever pass happened to ask first.
 */
type OrderWhere = { revenueDeferredDate?: unknown; inventoryAllocatedDate?: unknown }
function isGroupA2Window(where: OrderWhere | undefined): boolean {
  return !!where && where.inventoryAllocatedDate === null && where.revenueDeferredDate != null
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      salesOrder: {
        findMany: async ({ where }: { where?: OrderWhere } = {}) => (isGroupA2Window(where) ? [ORDER] : []),
      },
      shipment: { findMany: async () => [] },
      accountingSyncLog: { count: async () => 0 },
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    },
  },
})

mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    acquirePinnedAdvisoryLockOrNull: async () => ({
      assertHeld: () => undefined,
      release: async () => undefined,
    }),
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
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    mirrorAccountingSyncLogToEvent: async () => undefined,
    resetMirroredAccountingEventsToPending: async () => undefined,
    updateMirroredAccountingEventStatus: async () => undefined,
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: { scheduleXeroAccountingOutbox: async () => undefined },
})
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => new Map([[productId, 1]]),
  },
})
for (const path of [
  '@/lib/domain/accounting/inventory-gl-reconciliation',
  '@/lib/domain/accounting/cogs-gl-reconciliation',
  '@/lib/domain/accounting/transit-gl-reconciliation',
]) {
  const build = path.includes('inventory')
    ? 'buildInventoryReconciliationSweepJournal'
    : path.includes('cogs')
      ? 'buildCogsReconciliationSweepJournal'
      : 'buildTransitReconciliationSweepJournal'
  const load = path.includes('inventory')
    ? 'loadInventoryGlReconciliation'
    : path.includes('cogs')
      ? 'loadCogsGlReconciliation'
      : 'loadTransitGlReconciliation'
  mock.module(path, { namedExports: { [load]: async () => null, [build]: () => null } })
}
mock.module('@/lib/domain/accounting/cogs-subledger-movement', {
  namedExports: { recordCogsSubledgerMovement: async () => undefined },
})

async function runA2(unitCost: number) {
  created.length = 0
  orderUpdates.length = 0
  allocationUpdates.length = 0
  layerUnitCost = unitCost
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()
  assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
  assert.equal(result.groupA2, 1, 'the A2 window must really have processed the order')
  return result
}

test('o3d-o97 r3: A2 stamps the journal it raised — its DB-minted id, its ledger and its account', async () => {
  await runA2(10)

  const journal = created.find((log) => log.type === 'DAILY_BATCH_INVENTORY_ALLOC')
  assert.ok(journal, 'a journal was raised')
  const debit = (journal.payload.lines as Array<{ accountCode?: string; debit?: number }>)
    .find((line) => line.accountCode === '631' && line.debit != null)
  assert.equal(debit?.debit, 40, '4 units at £10 debited to Allocated Inventory')

  assert.equal(orderUpdates.length, 1)
  const data = orderUpdates[0].data
  assert.equal(data.allocationBatchAmount, 40)
  assert.equal(
    data.allocationBatchSyncLogId,
    journal.id,
    'the row id the database minted for THIS journal — an amount alone could not say a journal exists',
  )
  assert.equal(data.allocationBatchConnector, 'xero', 'which ledger the debit was raised in')
  assert.equal(data.allocationBatchAccountCode, '631', 'and which account it landed on')
  assert.ok('inventoryAllocatedDate' in data, 'all of it in the SAME UPDATE as the stamp')

  assert.equal(allocationUpdates.length, 1)
  assert.equal(
    allocationUpdates[0].data.allocationBatchAmount,
    40,
    "the row's own share of the debit — the basis a partial refund reverses at once revaluation has rewritten its pinned layers",
  )
})

test('o3d-o97 r3: A2 stamps NO journal attribution when the rounded window total raised no journal', async () => {
  // 4 units at £0.001 is £0.004, which rounds to £0.00 — so `totalAllocatedValueNumber > 0` is
  // false and NO journal is created at all. The per-order amount is still written, which is
  // precisely why "an amount implies a posting" was never a safe inference: here it would have a
  // refund credit £0.004 to an account with nothing in it.
  await runA2(0.001)

  assert.equal(
    created.find((log) => log.type === 'DAILY_BATCH_INVENTORY_ALLOC'),
    undefined,
    'no journal was raised',
  )
  const data = orderUpdates[0].data
  assert.equal(data.allocationBatchSyncLogId, null, 'so there is no journal id to record')
  assert.equal(data.allocationBatchConnector, null)
  assert.equal(data.allocationBatchAccountCode, null)
  assert.equal(allocationUpdates[0].data.allocationBatchAmount, null, 'and no per-row posted basis either')
})
