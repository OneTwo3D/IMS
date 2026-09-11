import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-i0o6 r4 (Codex round 3, HIGH 1) — A MISSING BATCH LOG REBUILT FROM THE CUMULATIVE AMOUNT
 * POSTS THE SAME DEBIT TWICE.
 *
 * `SalesOrder.allocationBatchAmount` is the running total of every Group A2 pass an order has been
 * through. `recreateMissingDailyBatchLogs` rebuilds ONE batch, and it summed that running total into
 * it. The two meet on the ordinary rounds-to-zero path:
 *
 *   Day 1 — A2 values the order at £50 and posts it under batch A2-<d1>, which settles.
 *   An allocation edit un-stages the order (the declared rewrite keeps the debit standing).
 *   Day 2 — A2 comes back under a NEW batch reference A2-<d2>, values the increment at nothing, and
 *           therefore creates NO batch log at all. The order keeps its cumulative £50 and is
 *           re-stamped with A2-<d2>.
 *   The sweep then finds no log for A2-<d2>, rebuilds it FROM THE £50, and the ledger carries the
 *   same £50 twice. The pass history still proves only the original £50, so a later refund reverses
 *   £50 and the duplicate stands for ever.
 *
 * This is the mirror of the rounds-to-zero scenario `daily-batch-a2-incremental-pass-proof.test.ts`
 * proves on the READING side: the proof handles it, the recreate path did not.
 *
 * EVERY SCENARIO HERE IS BUILT BY RUNNING THE REAL GROUP A2 WRITER, twice, with the real declared
 * un-stage between the passes and the real clock moved between them — and then by running the REAL
 * recreate sweep over what those writers left behind. No row in this file is written by hand.
 */

type SyncLog = {
  id: string
  type: string
  referenceType: string
  referenceId: string
  status: string
  connector: string
  payload: unknown
}

type AllocRow = {
  id: string
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
  costLayerSnapshot: unknown
  allocationBatchAmount: number | null
}

type OrderRow = {
  id: string
  orderNumber: string
  externalOrderNumber: string | null
  status: string
  refundStatus: string
  revenueDeferredDate: Date | null
  revenueDeferredBatchRef: string | null
  unearnedRevenueAmount: number | null
  inventoryAllocatedDate: Date | null
  inventoryAllocatedBatchRef: string | null
  allocationBatchAmount: number | null
  allocationBatchPasses: unknown
  allocationBatchSyncLogId: string | null
  allocationBatchConnector: string | null
  allocationBatchAccountCode: string | null
}

const state = {
  orders: [] as OrderRow[],
  allocations: [] as AllocRow[],
  syncLogs: [] as SyncLog[],
  unitCostByProduct: {} as Record<string, number>,
  /** The connector whose writer is under test, so the created logs carry the right stamp. */
  connector: 'xero' as 'xero' | 'quickbooks',
}

function newOrder(id: string): OrderRow {
  return {
    id,
    orderNumber: `SO-${id}`,
    externalOrderNumber: null,
    status: 'ALLOCATED',
    refundStatus: 'NONE',
    revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
    revenueDeferredBatchRef: null,
    unearnedRevenueAmount: null,
    inventoryAllocatedDate: null,
    inventoryAllocatedBatchRef: null,
    allocationBatchAmount: null,
    allocationBatchPasses: null,
    allocationBatchSyncLogId: null,
    allocationBatchConnector: null,
    allocationBatchAccountCode: null,
  }
}

function reset(connector: 'xero' | 'quickbooks'): void {
  state.orders = []
  state.allocations = []
  state.syncLogs = []
  state.unitCostByProduct = {}
  state.connector = connector
}

/** The Group A2 window: deferred, not yet stamped. */
function inA2Window(where: { inventoryAllocatedDate?: unknown; revenueDeferredDate?: unknown } | undefined): boolean {
  return !!where && where.inventoryAllocatedDate === null && where.revenueDeferredDate != null
}

function createLog(data: { type: string; referenceType?: string; referenceId: string; payload: unknown }): { id: string } {
  const log: SyncLog = {
    id: `a2-log-${state.syncLogs.length + 1}`,
    type: data.type,
    referenceType: data.referenceType ?? 'DailyBatch',
    referenceId: data.referenceId,
    status: 'PENDING',
    connector: state.connector,
    payload: data.payload,
  }
  state.syncLogs.push(log)
  return { id: log.id }
}

const tx = {
  costLayer: {
    findMany: async ({ where }: { where?: { productId?: string; id?: { in?: string[] } } } = {}) => {
      const productId = where?.productId
        ?? state.allocations.find((row) => where?.id?.in?.includes(`layer-${row.productId}`))?.productId
      if (!productId) return []
      return [{
        id: `layer-${productId}`,
        remainingQty: 1000,
        unitCostBase: state.unitCostByProduct[productId] ?? 0,
      }]
    },
    update: async () => ({}),
  },
  orderAllocation: {
    findMany: async () => state.allocations.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      lineId: row.lineId,
      productId: row.productId,
      warehouseId: row.warehouseId,
      qty: row.qty,
      costLayerSnapshot: row.costLayerSnapshot,
    })),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = state.allocations.find((entry) => entry.id === where.id)
      if (!row) throw new Error(`no allocation ${where.id}`)
      if ('costLayerSnapshot' in data) row.costLayerSnapshot = data.costLayerSnapshot
      if ('allocationBatchAmount' in data && data.allocationBatchAmount !== undefined) {
        row.allocationBatchAmount = data.allocationBatchAmount as number | null
      }
      return row
    },
    updateMany: async () => ({ count: 0 }),
  },
  salesOrder: {
    findMany: async (args?: { where?: { inventoryAllocatedDate?: unknown; revenueDeferredDate?: unknown; id?: { in?: string[] } }; select?: Record<string, unknown> }) => {
      const where = args?.where
      const eligible = state.orders.filter((order) => (
        order.inventoryAllocatedDate === null
        && (where?.id?.in == null || where.id.in.includes(order.id))
      ))
      if (!inA2Window(where)) return []
      if (!args?.select?.allocations) return eligible.map((order) => ({ id: order.id }))
      return eligible.map((order) => ({
        ...order,
        allocations: state.allocations
          .filter((row) => row.orderId === order.id)
          .map((row) => ({
            id: row.id,
            lineId: row.lineId,
            productId: row.productId,
            warehouseId: row.warehouseId,
            qty: row.qty,
            costLayerSnapshot: row.costLayerSnapshot,
          })),
        shipments: [],
      }))
    },
    findUnique: async ({ where }: { where: { id: string } }) => (
      state.orders.find((order) => order.id === where.id) ?? null
    ),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const order = state.orders.find((row) => row.id === where.id)
      if (!order) throw new Error(`no order ${where.id}`)
      Object.assign(order, data)
      return order
    },
  },
  shipment: { findMany: async () => [], findFirst: async () => null, update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefund: { findMany: async () => [] },
  salesOrderRefundLine: { findMany: async () => [] },
  accountingSyncLog: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const log = state.syncLogs.find((row) => row.id === where.id)
      if (!log) return null
      const projected: Record<string, unknown> = {}
      for (const key of Object.keys(select ?? { status: true })) {
        projected[key] = (log as unknown as Record<string, unknown>)[key]
      }
      return projected
    },
    create: async ({ data }: { data: { type: string; referenceType?: string; referenceId: string; payload: unknown } }) => createLog(data),
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
  $queryRaw: async () => state.allocations.map((row) => ({ id: row.id, costLayerSnapshot: row.costLayerSnapshot })),
}

/**
 * The OUTER `db`, which is what the recreate sweep reads through — unlike the sibling A2 fixtures,
 * where it is deliberately blind. This file is about the sweep, so it has to see the very rows the
 * A2 writer left behind, through the sweep's own queries.
 */
type OuterOrderWhere = {
  paidAt?: unknown
  revenueDeferredDate?: unknown
  inventoryAllocatedDate?: unknown
  refundStatus?: { not?: string }
}

/**
 * The referenceId predicates the two sweeps emit. Xero ORs one alternative per candidate;
 * QuickBooks passes them as a single `in`. Modelling only one of the two is how a probe silently
 * matches EVERY row and reports "live", which reads as "nothing missing" and makes a recreate test
 * assert nothing at all — that is not a hypothetical, it is what the first draft of this file did.
 */
type RefCondition = string | { in?: string[]; startsWith?: string }

type LogWhere = {
  connector?: string
  type?: string | { in?: string[] }
  status?: { in?: string[] }
  referenceId?: RefCondition
  OR?: Array<{ referenceId?: RefCondition }>
}

function matchesRef(value: string, condition: RefCondition | undefined): boolean {
  if (typeof condition === 'string') return value === condition
  if (condition && typeof condition === 'object') {
    if (Array.isArray(condition.in)) return condition.in.includes(value)
    if (typeof condition.startsWith === 'string') return value.startsWith(condition.startsWith)
  }
  return false
}

function matchesLog(row: SyncLog, where: LogWhere): boolean {
  if (where.connector && row.connector !== where.connector) return false
  if (typeof where.type === 'string' && row.type !== where.type) return false
  if (where.type && typeof where.type === 'object' && Array.isArray(where.type.in)
    && !where.type.in.includes(row.type)) return false
  if (where.status?.in && !where.status.in.includes(row.status)) return false
  if (where.referenceId !== undefined && !matchesRef(row.referenceId, where.referenceId)) return false
  if (where.OR && !where.OR.some((alt) => matchesRef(row.referenceId, alt.referenceId))) return false
  return true
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-A' }) },
      salesOrder: {
        findMany: async ({ where }: { where: OuterOrderWhere }) => {
          // Three different callers reach this one method and they must not be confused:
          //   `paidAt`                      the A1 POSTING window — answered empty, so no posting
          //                                 group can re-post the rows this file stages.
          //   `inventoryAllocatedDate: null` the QuickBooks A2 POSTING window (Xero's runs inside
          //                                 the transaction, against `tx`).
          //   `inventoryAllocatedDate: {…}`  the RECREATE sweep, which is what this file is about.
          if ('paidAt' in where) return []
          if (where.inventoryAllocatedDate === null) {
            return state.orders
              .filter((order) => order.inventoryAllocatedDate === null && order.revenueDeferredDate !== null)
              .map((order) => ({
                ...order,
                allocations: state.allocations
                  .filter((row) => row.orderId === order.id)
                  .map((row) => ({
                    id: row.id,
                    lineId: row.lineId,
                    productId: row.productId,
                    warehouseId: row.warehouseId,
                    qty: row.qty,
                    costLayerSnapshot: row.costLayerSnapshot,
                  })),
                shipments: [],
              }))
          }
          if ('inventoryAllocatedDate' in where) {
            return state.orders.filter((order) => (
              order.inventoryAllocatedDate !== null
              && (!where.refundStatus?.not || order.refundStatus !== where.refundStatus.not)
            ))
          }
          if ('revenueDeferredDate' in where) {
            return state.orders.filter((order) => order.revenueDeferredDate !== null)
          }
          return []
        },
      },
      shipment: { findMany: async () => [] },
      accountingSyncLog: {
        count: async ({ where }: { where: LogWhere }) =>
          state.syncLogs.filter((row) => matchesLog(row, where)).length,
        findMany: async ({ where }: { where: LogWhere }) => state.syncLogs
          .filter((row) => matchesLog(row, where))
          .map((row) => ({
            id: row.id,
            referenceId: row.referenceId,
            status: row.status,
            externalTransactionId: null,
            abandonedBeforeRemoteCall: null,
            settlementBasis: null,
          })),
      },
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
mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: {
    getQuickBooksSettings: async () => ({
      quickbooks_sync_enabled: 'true',
      quickbooks_sales_account: '200',
      quickbooks_unearned_revenue_account: '830',
      quickbooks_inventory_account: '630',
      quickbooks_allocated_inventory_account: '631',
      quickbooks_cogs_account: '310',
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

const DAY_ONE = new Date('2026-07-20T10:00:00.000Z')
const DAY_TWO = new Date('2026-07-21T10:00:00.000Z')

/** Run the REAL Group A2 pass of the connector under test over whatever is in the window. */
async function runA2(expectedOrders: number): Promise<void> {
  if (state.connector === 'xero') {
    const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
    const result = await runDailyBatchSync()
    assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
    assert.equal(result.groupA2, expectedOrders, 'the A2 window must really have processed the order(s)')
    return
  }
  const { runDailyBatchSync } = await import('@/lib/connectors/quickbooks/daily-sync')
  const result = await runDailyBatchSync()
  assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
  assert.equal(result.groupA2, expectedOrders, 'the A2 window must really have processed the order(s)')
}

/** Run the REAL recreate sweep of the connector under test, returning its refusals. */
async function runRecreate(): Promise<string[]> {
  if (state.connector === 'xero') {
    const [{ recreateMissingDailyBatchLogs }, { getXeroSettings }] = await Promise.all([
      import('@/lib/connectors/xero/daily-sync'),
      import('@/lib/connectors/xero/settings'),
    ])
    return recreateMissingDailyBatchLogs(await getXeroSettings(), 'GBP')
  }
  const [{ recreateMissingDailyBatchLogs }, { getQuickBooksSettings }] = await Promise.all([
    import('@/lib/connectors/quickbooks/daily-sync'),
    import('@/lib/connectors/quickbooks/settings'),
  ])
  return recreateMissingDailyBatchLogs(await getQuickBooksSettings(), 'GBP')
}

/** The REAL declared un-stage: the stamp comes off, the debit and its attribution stay. */
async function declaredRewrite(orderId: string, nextQty: number): Promise<void> {
  const { resetAllocationAccountingIfStaged } = await import('@/lib/domain/sales/allocation-service')
  const { toDecimal } = await import('@/lib/domain/math/decimal')
  const rows = state.allocations.filter((row) => row.orderId === orderId)
  await resetAllocationAccountingIfStaged(
    tx as unknown as Parameters<typeof resetAllocationAccountingIfStaged>[0],
    orderId,
    {
      nextAllocations: rows.map((row) => ({
        lineId: row.lineId,
        productId: row.productId,
        warehouseId: row.warehouseId,
        qty: toDecimal(nextQty),
      })),
    },
  )
  for (const row of rows) row.qty = nextQty
}

/**
 * Two REAL A2 passes on two REAL days: £50 posted on day one, a pass that rounds to zero — and so
 * raises no journal at all — under a NEW batch reference on day two.
 */
async function postedThenRoundedAwayUnderANewBatch(connector: 'xero' | 'quickbooks'): Promise<void> {
  reset(connector)
  mock.timers.enable({ apis: ['Date'], now: DAY_ONE })
  try {
    state.unitCostByProduct = { 'prod-1': 12.5 }
    state.orders = [newOrder('order-1')]
    state.allocations = [
      { id: 'alloc-1', orderId: 'order-1', lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4, costLayerSnapshot: null, allocationBatchAmount: null },
    ]

    // DAY ONE — 4 units at £12.50 = £50, posted under the day's own batch reference and SETTLED.
    await runA2(1)
    assert.equal(state.orders[0].allocationBatchAmount, 50)
    const dayOneRef = state.orders[0].inventoryAllocatedBatchRef
    assert.ok(dayOneRef?.startsWith('A2-2026-07-20'), `day one's batch ref is the day's own: ${dayOneRef}`)
    assert.equal(state.syncLogs.length, 1, 'and it really did raise a journal')
    state.syncLogs[0].status = 'SYNCED'

    // The declared rewrite: the order gains 0.0004 of a unit, the stamp comes off, the £50 stays.
    await declaredRewrite('order-1', 4.0004)
    assert.equal(state.orders[0].inventoryAllocatedDate, null, 'the stamp really did come off')
    assert.equal(state.orders[0].allocationBatchAmount, 50, 'and the recorded debit really did survive it')

    // DAY TWO — the increment values at a fraction of a penny, so the batch's ROUNDED total is
    // £0.00 and A2 creates no log at all. The order is still re-stamped, under the new day's ref.
    mock.timers.setTime(DAY_TWO.getTime())
    state.unitCostByProduct = { 'prod-1': 0.001 }
    await runA2(1)
  } finally {
    mock.timers.reset()
  }

  assert.equal(state.syncLogs.length, 1, 'day two raised NO journal — its rounded total was £0.00')
  assert.equal(state.orders[0].allocationBatchAmount, 50, 'the cumulative debit is still the day-one £50')
  const dayTwoRef = state.orders[0].inventoryAllocatedBatchRef
  assert.ok(dayTwoRef?.startsWith('A2-2026-07-21'), `the order now names a NEW batch: ${dayTwoRef}`)
  assert.equal(
    state.syncLogs.filter((log) => log.referenceId === dayTwoRef).length,
    0,
    'and there is no log under that new reference for the sweep to find',
  )
}

for (const connector of ['xero', 'quickbooks'] as const) {
  test(`${connector}: a batch whose pass ROUNDED TO ZERO is not rebuilt from the CUMULATIVE debit (o3d-i0o6 r4)`, async () => {
    await postedThenRoundedAwayUnderANewBatch(connector)

    const refusals = await runRecreate()

    // Before this fix the sweep summed `allocationBatchAmount` into the day-two bucket and queued a
    // SECOND £50 DR Allocated Inventory / CR Inventory — for a day whose A2 pass was worth nothing.
    assert.equal(
      state.syncLogs.length,
      1,
      'the £50 day-one journal is the ONLY one: a batch worth £0.00 may not be rebuilt for £50',
    )
    assert.deepEqual(refusals, [], 'and nothing is refused either — the history answered the question')
  })

  test(`${connector}: the day-one batch IS still rebuilt when its own log goes missing (o3d-i0o6 r4)`, async () => {
    // THE CONTROL, so the fix is a narrowing and not a blanket refusal. Same two passes; this time
    // the day-ONE log is the one that vanished before it posted, and its £50 is exactly what the
    // day-one batch owes. The day-two batch still owes nothing.
    await postedThenRoundedAwayUnderANewBatch(connector)
    const dayOneRef = (state.orders[0].allocationBatchPasses as Array<{ batchRef: string }>)[0].batchRef
    // Put the order back on the day-one batch, as an operator repairing the stamp would, and take
    // the day-one log away: the batch the sweep is now asked about is the one that owes £50.
    state.orders[0].inventoryAllocatedBatchRef = dayOneRef
    state.syncLogs = []

    const refusals = await runRecreate()

    assert.deepEqual(refusals, [])
    assert.equal(state.syncLogs.length, 1, 'the genuinely missing batch is rebuilt')
    assert.equal(state.syncLogs[0].referenceId, dayOneRef)
    const debit = (state.syncLogs[0].payload as { lines: Array<{ accountCode?: string; debit?: number }> })
      .lines.find((line) => line.accountCode === '631' && line.debit != null)
    assert.equal(debit?.debit, 50, 'for the £50 THAT batch carried, which here is all of the figure')
  })
}
