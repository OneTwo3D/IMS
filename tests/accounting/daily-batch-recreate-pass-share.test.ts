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
  /**
   * o3d-i0o6 r6: the rows `resolveScheduledDailyBatchSweep` reads — the SAME two the cron route
   * reads — so "whose sweep does the cron actually run?" is answered here by the real resolver
   * rather than by a boolean the test hands the sweep.
   */
  settings: {} as Record<string, string>,
  enabledPlugins: [] as Array<'xero' | 'quickbooks'>,
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
  logSeq = 0
  state.orders = []
  state.allocations = []
  state.syncLogs = []
  state.unitCostByProduct = {}
  state.connector = connector
  state.settings = {}
  state.enabledPlugins = []
}

/** The Group A2 window: deferred, not yet stamped. */
function inA2Window(where: { inventoryAllocatedDate?: unknown; revenueDeferredDate?: unknown } | undefined): boolean {
  return !!where && where.inventoryAllocatedDate === null && where.revenueDeferredDate != null
}

/**
 * o3d-i0o6 r5 (Codex round 4, HIGH 2) — IDS ARE NEVER REUSED, which is not a detail.
 *
 * This counter used to be `state.syncLogs.length + 1`. A test that takes a log AWAY and then makes
 * the sweep rebuild it therefore got the SAME id back — so the order's pass history, still naming
 * the id of the log that vanished, resolved to the replacement by accident, and a rebuild that
 * re-pointed nothing at all looked exactly like one that did. The defect under test could not
 * appear. Monotonic per scenario, so a replacement is always a different row.
 */
let logSeq = 0

function createLog(data: { type: string; referenceType?: string; referenceId: string; payload: unknown }): { id: string } {
  logSeq += 1
  const log: SyncLog = {
    id: `a2-log-${logSeq}`,
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
  inventoryAllocatedDate?: null | { gte?: Date } | { not?: null }
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
  /**
   * o3d-i0o6 r7 — MODELLED, because the foreign-journal probe selects BY ID. `matchesLog` ignored
   * any key it did not know about, so `{ id: { in: [...] } }` matched every row and the probe was
   * answered about journals it never asked for. That is the "double that ignores a filter" shape
   * this branch has now found three times; here it happened to be harmless only because the caller
   * looked its answers back up by id, which is not a property a fixture may rely on.
   */
  id?: { in?: string[] }
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
  if (where.id?.in && !where.id.in.includes(row.id)) return false
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
      setting: { findUnique: async ({ where }: { where: { key: string } }) => (
        state.settings[where.key] != null ? { key: where.key, value: state.settings[where.key] } : null
      ) },
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
            // o3d-i0o6 r7 — THE RETENTION BOUND IS MODELLED. This double answered the recreate
            // sweep's query while ignoring its `{ gte: cutoff }`, so a scenario about the retention
            // window could not be expressed here at all: every staged order came back whatever the
            // cutoff was. Same shape as the log double that ignored `id` — a double that drops a
            // filter production depends on cannot fail when production drops it too.
            const gte = (where.inventoryAllocatedDate as { gte?: Date } | null)?.gte
            return state.orders.filter((order) => (
              order.inventoryAllocatedDate !== null
              && (!gte || order.inventoryAllocatedDate.getTime() >= gte.getTime())
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

/**
 * o3d-i0o6 r6 — TWO CHARTS OF ACCOUNTS, BECAUSE THAT IS THE POINT.
 *
 * This file runs BOTH A2 writers and BOTH recreate sweeps over the same orders, and the rule under
 * test — `passIsOfLedger` — is an equality on the pass's connector AND its account code. Giving both
 * connectors the SAME codes makes the account arm a tautology across the whole file and leaves the
 * connector arm carrying the cross-ledger tests alone, so "the QuickBooks sweep used Xero's Allocated
 * Inventory account" would be indistinguishable from "…used its own".
 *
 * That is the shape of the masking fixture found twice already on this branch (the reused sync-log id,
 * and the split test that gave two connectors one account map). `allocation-service.test.ts` already
 * keeps two charts for the same reason; so does this now.
 */
const CHART = {
  xero: { sales: '200', unearned: '830', inventory: '630', allocated: '631', moved: '632', cogs: '310' },
  quickbooks: { sales: '400', unearned: '930', inventory: '730', allocated: '731', moved: '732', cogs: '510' },
} as const

mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: 'true',
      xero_sales_account: CHART.xero.sales,
      xero_unearned_revenue_account: CHART.xero.unearned,
      xero_inventory_account: CHART.xero.inventory,
      xero_allocated_inventory_account: CHART.xero.allocated,
      xero_cogs_account: CHART.xero.cogs,
      xero_rounding_difference_account: '',
      xero_transit_account: '',
    }),
  },
})
mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: {
    getQuickBooksSettings: async () => ({
      quickbooks_sync_enabled: 'true',
      quickbooks_sales_account: CHART.quickbooks.sales,
      quickbooks_unearned_revenue_account: CHART.quickbooks.unearned,
      quickbooks_inventory_account: CHART.quickbooks.inventory,
      quickbooks_allocated_inventory_account: CHART.quickbooks.allocated,
      quickbooks_cogs_account: CHART.quickbooks.cogs,
    }),
  },
})

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: 'xero' | 'quickbooks') => state.enabledPlugins.includes(id),
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
    //
    // o3d-i0o6 r5: REMOVED BY ID, not `state.syncLogs = []`. Clearing the array reset the id
    // counter, so the rebuilt log came back as `a2-log-1` — the very id the day-one pass already
    // recorded — and the whole of HIGH 2 (a rebuild that leaves the evidence pointing at the log it
    // replaced) was invisible to this test. See `logSeq`.
    state.orders[0].inventoryAllocatedBatchRef = dayOneRef
    const lostLogId = state.syncLogs[0].id
    state.syncLogs = state.syncLogs.filter((log) => log.id !== lostLogId)

    const refusals = await runRecreate()

    assert.deepEqual(refusals, [])
    assert.equal(state.syncLogs.length, 1, 'the genuinely missing batch is rebuilt')
    assert.equal(state.syncLogs[0].referenceId, dayOneRef)
    assert.notEqual(state.syncLogs[0].id, lostLogId, 'and the rebuild is a NEW row, not the one that vanished')
    const debit = (state.syncLogs[0].payload as { lines: Array<{ accountCode?: string; debit?: number }> })
      .lines.find((line) => line.accountCode === CHART[connector].allocated && line.debit != null)
    assert.equal(debit?.debit, 50, 'for the £50 THAT batch carried, which here is all of the figure')

    // o3d-i0o6 r5: the DAY-ONE pass is re-pointed at the rebuilt journal, and the three latest-pass
    // columns are NOT — they describe the day-TWO pass, which this rebuild did not replace. An
    // earlier pass moving says nothing about the latest one, and rewriting the columns anyway would
    // make the rebuild a second writer of a fact it did not establish.
    const passes = state.orders[0].allocationBatchPasses as Array<{ syncLogId: string | null; batchRef: string }>
    assert.equal(passes[0].syncLogId, state.syncLogs[0].id, 'the day-one pass names the rebuilt journal')
    assert.equal(passes[1].syncLogId, null, 'the day-two pass still names none — it raised none')
    assert.equal(
      state.orders[0].allocationBatchSyncLogId,
      null,
      'and the latest-pass column is untouched: it is about day two, which was not rebuilt',
    )
  })

  test(`${connector}: the same batch on the same ledger against ANOTHER account is refused, not rebuilt`, async () => {
    // The one arm of the ledger filter that is an ambiguity rather than somebody else's pounds: the
    // pass names this connector and an Allocated Inventory account that is NOT the one configured
    // today. The rebuild would debit today's account for pounds recorded against another, and
    // neither figure describes the other. Evidence produced by the REAL writer; only the account the
    // rebuild would post to is varied, which is the thing under test.
    await postedThenRoundedAwayUnderANewBatch(connector)
    const { allocationDebitShareOfBatch } = await import('@/lib/domain/accounting/allocation-debit-passes')
    const dayOneRef = (state.orders[0].allocationBatchPasses as Array<{ batchRef: string }>)[0].batchRef
    const order = {
      id: state.orders[0].id,
      orderNumber: state.orders[0].orderNumber,
      allocationBatchAmount: state.orders[0].allocationBatchAmount,
      allocationBatchPasses: state.orders[0].allocationBatchPasses,
      inventoryAllocatedBatchRef: dayOneRef,
    }

    const sameAccount = allocationDebitShareOfBatch(order, { connector, accountCode: CHART[connector].allocated }, dayOneRef)
    // o3d-i0o6 r6: `foreign` is part of the verdict now — the passes of this batch that debited
    // ANOTHER ledger, carried out so the caller can report the ones nobody will rebuild. Empty here,
    // which is the assertion that matters: a same-ledger control must produce no foreign share at all.
    assert.deepEqual(sameAccount, { kind: 'known', amount: 50, foreign: [] }, 'the control: today\'s account still answers £50')

    const movedAccount = allocationDebitShareOfBatch(order, { connector, accountCode: CHART[connector].moved }, dayOneRef)
    assert.equal(movedAccount.kind, 'unattributed', 'a re-mapped account is not a share of zero')
    assert.match(
      movedAccount.kind === 'unattributed' ? movedAccount.reason : '',
      new RegExp(`recorded its A2 debit for this batch against account ${CHART[connector].allocated} on ${connector}, but Allocated Inventory is configured as ${CHART[connector].moved} today`),
    )
  })
}

// ---------------------------------------------------------------------------
// o3d-i0o6 r5 (Codex round 4, HIGH 1 and HIGH 2)
// ---------------------------------------------------------------------------

/** Switch the writer/ledger under test WITHOUT discarding what the previous connector wrote. */
function switchConnector(connector: 'xero' | 'quickbooks'): void {
  state.connector = connector
}

/**
 * o3d-i0o6 r6: arrange the rows that decide WHOSE daily-batch sweep the cron runs, and let the real
 * `resolveScheduledDailyBatchSweep` read them — the same function the cron route itself now calls.
 * `null` is "no accounting plugin enabled", i.e. no sweep runs at all.
 */
function scheduleDailyBatchOn(connector: 'xero' | 'quickbooks' | null): void {
  state.enabledPlugins = connector ? [connector] : []
  state.settings = connector
    ? { [`${connector}_daily_batch_enabled`]: 'true', [`${connector}_sync_enabled`]: 'true' }
    : {}
}

/**
 * o3d-i0o6 r5 (HIGH 1) — A REAL LEDGER SWITCH, BUILT BY RUNNING BOTH WRITERS.
 *
 * Day one: the XERO A2 pass values the order at £50, posts it, and settles.
 * The declared rewrite adds quantity; the stamp comes off and the £50 stays.
 * Day two: the books are switched, and the QUICKBOOKS A2 pass posts the increment under ITS OWN
 * batch reference, into QuickBooks.
 *
 * The order now carries two passes on two ledgers and is stamped with the QuickBooks batch. No row
 * here is written by hand: the cross-ledger state is what the two real writers leave behind.
 */
async function xeroThenQuickBooksUnderTwoBatches(): Promise<{ dayOneRef: string; dayTwoRef: string }> {
  reset('xero')
  mock.timers.enable({ apis: ['Date'], now: DAY_ONE })
  let dayOneRef: string
  let dayTwoRef: string
  try {
    state.unitCostByProduct = { 'prod-1': 12.5 }
    state.orders = [newOrder('order-1')]
    state.allocations = [
      { id: 'alloc-1', orderId: 'order-1', lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4, costLayerSnapshot: null, allocationBatchAmount: null },
    ]
    await runA2(1)
    dayOneRef = state.orders[0].inventoryAllocatedBatchRef as string
    assert.equal(state.syncLogs.length, 1, 'day one really did raise an Xero journal')
    assert.equal(state.syncLogs[0].connector, 'xero')
    state.syncLogs[0].status = 'SYNCED'

    // The declared rewrite adds two units, so day two has REAL pounds to post rather than a
    // rounding tail — the cross-ledger amount has to be big enough to see in a journal.
    await declaredRewrite('order-1', 6)
    assert.equal(state.orders[0].inventoryAllocatedDate, null, 'the stamp came off')

    mock.timers.setTime(DAY_TWO.getTime())
    switchConnector('quickbooks')
    await runA2(1)
    dayTwoRef = state.orders[0].inventoryAllocatedBatchRef as string
  } finally {
    mock.timers.reset()
  }

  assert.notEqual(dayTwoRef, dayOneRef, 'day two is a different batch')
  const dayTwoLogs = state.syncLogs.filter((log) => log.referenceId === dayTwoRef)
  assert.equal(dayTwoLogs.length, 1, 'and QuickBooks really did raise a journal for it')
  assert.equal(dayTwoLogs[0].connector, 'quickbooks', 'ON QUICKBOOKS — this is the switch, not a relabel')
  dayTwoLogs[0].status = 'SYNCED'

  const passes = state.orders[0].allocationBatchPasses as Array<{ connector: string; batchRef: string; amount: string }>
  assert.equal(passes.length, 2, 'two real passes')
  assert.deepEqual(passes.map((pass) => pass.connector), ['xero', 'quickbooks'], 'one per ledger')
  assert.equal(passes[1].batchRef, dayTwoRef)
  assert.ok(Number(passes[1].amount) > 0.005, `the QuickBooks pass carries real pounds: ${passes[1].amount}`)
  return { dayOneRef, dayTwoRef }
}

test('o3d-i0o6 r5: XERO\'s sweep does NOT rebuild a QuickBooks-attributed batch into Xero accounts', async () => {
  const { dayTwoRef } = await xeroThenQuickBooksUnderTwoBatches()
  const before = state.syncLogs.length

  // Xero's live-log probe filters by `connector`, so the QuickBooks journal for this batch is
  // invisible to it and the batch reads as MISSING. Before r5 the share it rebuilt was every pass
  // that named the reference on ANY ledger, so it posted the QuickBooks pounds into Xero: a
  // duplicate debit in books that never carried it, and one no refund could ever reverse, because
  // the pass history still proves only the QuickBooks journal.
  switchConnector('xero')
  // o3d-i0o6 r6: and the cron runs XERO's sweep, so the "somebody else's sweep will do it" arm is
  // NOT what keeps this quiet — QuickBooks' sweep is not scheduled. What keeps it quiet is that the
  // QuickBooks journal is still standing, asserted below. Without this line the test would pass
  // whichever of the two reasons held.
  scheduleDailyBatchOn('xero')
  // NOT VACUOUS: the premise is that Xero's own probe sees no live log under this reference, so the
  // sweep really does reach the rebuild decision. If a live Xero log existed the assertions below
  // would pass for the wrong reason.
  assert.deepEqual(
    state.syncLogs.filter((log) => log.connector === 'xero' && log.referenceId === dayTwoRef),
    [],
    'the batch really is invisible to Xero — which is what makes it look missing',
  )
  assert.deepEqual(
    state.syncLogs.filter((log) => log.referenceId === dayTwoRef && log.status === 'SYNCED').map((log) => log.connector),
    ['quickbooks'],
    'and the QuickBooks journal carrying those pounds IS still standing — the reason nothing is owed',
  )
  const refusals = await runRecreate()

  assert.equal(state.syncLogs.length, before, 'Xero raised NOTHING for a batch whose pounds are in QuickBooks')
  assert.deepEqual(
    state.syncLogs.filter((log) => log.referenceId === dayTwoRef && log.connector === 'xero'),
    [],
    'and specifically no Xero journal under the QuickBooks batch reference',
  )
  assert.deepEqual(refusals, [], 'nor is it reported — the batch is not missing, it is somebody else\'s AND IT IS THERE')
})

test('o3d-i0o6 r5: and the CONTROL — QuickBooks still rebuilds its OWN share of that batch', async () => {
  // The narrowing must not become a blanket refusal: the very same order, the very same batch, swept
  // by the connector whose passes actually carried the pounds, still gets its missing log rebuilt —
  // for the QuickBooks share alone, never the cumulative £75.
  const { dayTwoRef } = await xeroThenQuickBooksUnderTwoBatches()
  const cumulative = state.orders[0].allocationBatchAmount as number
  const qboShare = Number((state.orders[0].allocationBatchPasses as Array<{ amount: string }>)[1].amount)
  assert.ok(cumulative > qboShare + 0.005, `the cumulative figure is bigger than the share: ${cumulative} vs ${qboShare}`)

  state.syncLogs = state.syncLogs.filter((log) => log.referenceId !== dayTwoRef)
  switchConnector('quickbooks')
  const refusals = await runRecreate()

  assert.deepEqual(refusals, [])
  const rebuilt = state.syncLogs.filter((log) => log.referenceId === dayTwoRef)
  assert.equal(rebuilt.length, 1, 'the genuinely missing QuickBooks batch is rebuilt')
  assert.equal(rebuilt[0].connector, 'quickbooks')
  const debit = (rebuilt[0].payload as { lines: Array<{ accountCode?: string; debit?: number }> })
    // QUICKBOOKS' OWN Allocated Inventory account, which is not Xero's: the rebuild must use the
    // chart of the ledger it is posting into, and with one shared chart that could not be said.
    .lines.find((line) => line.accountCode === CHART.quickbooks.allocated && line.debit != null)
  assert.equal(debit?.debit, Math.round(qboShare * 100) / 100, 'for ITS OWN share, not the cumulative debit')
})

/**
 * o3d-i0o6 r5 (HIGH 2) — THE REBUILT JOURNAL IS THE ONE THE EVIDENCE NAMES AFTERWARDS.
 *
 * A rebuild mints a NEW sync log. The orders it rebuilt FROM still recorded the id of the log that
 * went missing, and that id is precisely what `proveAllocationDebitPosting` resolves before it will
 * authorise a credit. So the recreated debit used to be permanently irreversible: the pounds are in
 * Allocated Inventory, and every refund and orphan reversal for the rest of the order's life
 * resolves a dead id, refuses, and withholds the credit.
 */
for (const connector of ['xero', 'quickbooks'] as const) {
  test(`${connector}: a rebuilt A2 batch re-points the evidence at the journal it minted (o3d-i0o6 r5)`, async () => {
    reset(connector)
    mock.timers.enable({ apis: ['Date'], now: DAY_ONE })
    try {
      state.unitCostByProduct = { 'prod-1': 12.5 }
      state.orders = [newOrder('order-1')]
      state.allocations = [
        { id: 'alloc-1', orderId: 'order-1', lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4, costLayerSnapshot: null, allocationBatchAmount: null },
      ]
      await runA2(1)
    } finally {
      mock.timers.reset()
    }
    assert.equal(state.orders[0].allocationBatchAmount, 50)
    const batchRef = state.orders[0].inventoryAllocatedBatchRef as string
    const lostLogId = state.syncLogs[0].id
    assert.equal(
      (state.orders[0].allocationBatchPasses as Array<{ syncLogId: string }>)[0].syncLogId,
      lostLogId,
      'the pass names the journal A2 raised',
    )

    // The log goes missing before it ever posted — the state this sweep exists for.
    state.syncLogs = state.syncLogs.filter((log) => log.id !== lostLogId)

    const refusals = await runRecreate()

    assert.deepEqual(refusals, [])
    assert.equal(state.syncLogs.length, 1, 'the batch is rebuilt')
    const rebuiltId = state.syncLogs[0].id
    assert.notEqual(rebuiltId, lostLogId, 'under a NEW id — which is the whole difficulty')

    const passes = state.orders[0].allocationBatchPasses as Array<{ syncLogId: string; connector: string }>
    assert.equal(passes[0].syncLogId, rebuiltId, 'and the pass now names the journal that actually carries its pounds')
    assert.equal(state.orders[0].allocationBatchSyncLogId, rebuiltId, 'as does the latest-pass column beside it')
    assert.equal(state.orders[0].allocationBatchConnector, connector)
    assert.equal(state.orders[0].allocationBatchAccountCode, CHART[connector].allocated)
    assert.equal(passes[0].connector, connector, 'and the ledger it was rebuilt into')

    // THE POINT, IN MONEY. The rebuilt journal settles, and a reversal can now be raised against it.
    // Before this fix the proof resolved the dead id, answered `refused`, and the £50 debit stood in
    // Allocated Inventory with no way out for ever.
    state.syncLogs[0].status = 'SYNCED'
    const { proveAllocationDebitPosting } = await import('@/lib/domain/accounting/allocation-debit-posting-proof')
    const proof = await proveAllocationDebitPosting(
      tx as unknown as Parameters<typeof proveAllocationDebitPosting>[0],
      {
        inventoryAllocatedDate: state.orders[0].inventoryAllocatedDate,
        allocationBatchAmount: state.orders[0].allocationBatchAmount,
        allocationBatchPasses: state.orders[0].allocationBatchPasses,
        allocationBatchSyncLogId: state.orders[0].allocationBatchSyncLogId,
        allocationBatchConnector: state.orders[0].allocationBatchConnector,
        allocationBatchAccountCode: state.orders[0].allocationBatchAccountCode,
      },
      { activeConnector: connector, allocatedInventoryAccount: CHART[connector].allocated },
    )
    assert.equal(proof.kind, 'posted', `the recreated debit is reversible: ${JSON.stringify(proof)}`)
    assert.equal(proof.kind === 'posted' ? proof.recordedDebit : null, 50)
    assert.deepEqual(proof.kind === 'posted' ? proof.journalIds : null, [rebuiltId], 'against the rebuilt journal')
    assert.equal(batchRef, state.orders[0].inventoryAllocatedBatchRef, 'and the stamp was left alone')
  })
}

// ---------------------------------------------------------------------------
// o3d-i0o6 r6 (Codex round 5, HIGH 1) — "ITS OWN SWEEP WILL REBUILD IT" IS A CLAIM ABOUT THE CRON.
//
// r5 stopped one sweep rebuilding another ledger's share of a shared batch reference — correct — and
// then reported the share it had declined as a positive £0.00 on the argument that the other
// connector's own sweep can see its own log and will rebuild it. `app/api/cron/accounting-daily-batch`
// runs ONE sweep, the first ENABLED plugin's, and RETURNS; the second plugin's sweep never runs. So
// after a QuickBooks → Xero switch a missing QuickBooks A2 journal was converted to £0.00 with no
// refusal, no reader and no sweep coming for it — the debit abandoned in silence, for ever, while
// the order's pass history goes on naming a journal that does not exist. Silent abandonment of
// money is worse than a refusal repeated daily.
//
// Three states, and the tests below are one each: the journal is live (quiet), its own sweep is the
// scheduled one (quiet), neither (REPORTED).
// ---------------------------------------------------------------------------

test('o3d-i0o6 r6: a batch whose pounds are in a ledger NO scheduled sweep will rebuild is REPORTED, not zeroed', async () => {
  const { dayTwoRef } = await xeroThenQuickBooksUnderTwoBatches()
  const qboShare = Number((state.orders[0].allocationBatchPasses as Array<{ amount: string }>)[1].amount)
  const qboJournalId = (state.orders[0].allocationBatchPasses as Array<{ syncLogId: string }>)[1].syncLogId

  // The QuickBooks journal for this batch is GONE — it never reached the ledger, or retention took
  // the row. These pounds are recorded against an order and stand in no journal anywhere.
  state.syncLogs = state.syncLogs.filter((log) => log.referenceId !== dayTwoRef)
  assert.deepEqual(state.syncLogs.filter((log) => log.id === qboJournalId), [], 'precondition: the journal the pass names is really gone')

  // And the books are on Xero: the cron runs Xero's sweep and returns, so QuickBooks' sweep — r5's
  // entire reason for staying silent — never runs at all.
  scheduleDailyBatchOn('xero')
  switchConnector('xero')
  const before = state.syncLogs.length
  const refusals = await runRecreate()

  // NOT VACUOUS, AND THE ORDERING IS THE POINT. Xero's own share of this batch is £0.00 — no Xero
  // pass names it — and nothing about it is unattributed, so the sweep's very first `continue`
  // applies to it. A report emitted anywhere after that `continue` would be invisible in exactly the
  // state this finding is about, which is why it is pushed before every skip in the loop.
  assert.deepEqual(
    (state.orders[0].allocationBatchPasses as Array<{ connector: string; batchRef: string }>)
      .filter((pass) => pass.batchRef === dayTwoRef).map((pass) => pass.connector),
    ['quickbooks'],
    'the only pass naming this batch is the QuickBooks one, so Xero\'s own share of it is £0.00',
  )
  assert.equal(state.syncLogs.length, before, 'Xero still raises NOTHING: another ledger\'s pounds are not its to post')
  assert.equal(refusals.length, 1, `but it says so: ${JSON.stringify(refusals)}`)
  assert.match(refusals[0], /debited to Allocated Inventory on quickbooks/, 'naming the ledger the pounds are in')
  assert.ok(refusals[0].includes(`£${qboShare.toFixed(2)}`), `and the pounds: ${refusals[0]}`)
  assert.ok(refusals[0].includes(dayTwoRef), 'and the batch')
  assert.match(refusals[0], /the daily batch runs xero's sweep, not quickbooks's/, 'and why nobody is coming for it')
})

test('o3d-i0o6 r6: and it stays QUIET when that ledger\'s own sweep is the one the cron runs', async () => {
  // The same abandoned journal, and the same Xero sweep — run by hand from the Xero daily-batch
  // action while the CRON is scheduled on QuickBooks. QuickBooks' own sweep will rebuild it on its
  // next tick, so reporting it here would be noise about a batch that is genuinely somebody else's.
  const { dayTwoRef } = await xeroThenQuickBooksUnderTwoBatches()
  state.syncLogs = state.syncLogs.filter((log) => log.referenceId !== dayTwoRef)
  scheduleDailyBatchOn('quickbooks')
  switchConnector('xero')
  const before = state.syncLogs.length
  const refusals = await runRecreate()

  assert.equal(state.syncLogs.length, before, 'still nothing rebuilt into Xero')
  assert.deepEqual(refusals, [], 'and nothing reported: QuickBooks\' own scheduled sweep is coming for it')
})

// ---------------------------------------------------------------------------
// o3d-i0o6 r7 (Codex round 6, HIGH 2) — A RECREATE RUN THAT CAN ONLY SEE THE LATEST PASS.
//
// The recreate sweeps bucketed each staged order by `inventoryAllocatedBatchRef` — the column EVERY
// A2 pass overwrites. So an order with a cumulative debit across two batches appeared in exactly one
// bucket, the newest, and the EARLIER batch existed nowhere in the run: not in the rebuild total,
// because no bucket was built for it, and not in `summary.foreign` either, because
// `allocationDebitShareOfBatch` filtered the passes to that same latest reference.
//
// Round 6 added "report on every run" for pounds nobody will rebuild. It was blind in precisely the
// cumulative cross-ledger history this whole branch exists to handle — the fourth round in which a
// latest-pass column was found standing in for the history.
//
// The state below is the r5/r6 cross-ledger one, built by running BOTH real writers: Xero batch R1
// carrying £50 under journal J1, then a switch, then QuickBooks batch R2 carrying £25 under J2. The
// order's stamp is R2. J1 is then the one that goes missing.
// ---------------------------------------------------------------------------

test('o3d-i0o6 r7: an EARLIER batch whose journal went missing is rebuilt by its own ledger\'s sweep', async () => {
  const { dayOneRef, dayTwoRef } = await xeroThenQuickBooksUnderTwoBatches()
  const xeroShare = Number((state.orders[0].allocationBatchPasses as Array<{ amount: string }>)[0].amount)
  const lostJournalId = (state.orders[0].allocationBatchPasses as Array<{ syncLogId: string }>)[0].syncLogId

  // J1 goes missing before it posted — the state this sweep exists for, on the EARLIER batch.
  state.syncLogs = state.syncLogs.filter((log) => log.id !== lostJournalId)

  // NOT VACUOUS. The order is stamped with the day-TWO batch, so nothing about its current columns
  // names R1 at all; the only record that R1 ever carried pounds is the pass history.
  assert.equal(state.orders[0].inventoryAllocatedBatchRef, dayTwoRef, 'the stamp is the LATER batch')
  assert.notEqual(dayOneRef, dayTwoRef)
  assert.deepEqual(
    state.syncLogs.filter((log) => log.referenceId === dayOneRef),
    [],
    'and R1 really has no journal left anywhere',
  )
  assert.ok(state.syncLogs.some((log) => log.referenceId === dayTwoRef), 'while R2\'s is still standing')

  scheduleDailyBatchOn('xero')
  switchConnector('xero')
  const refusals = await runRecreate()

  // Before this fix: nothing. No R1 bucket was built, so the batch was neither rebuilt nor reported,
  // and the £50 Xero debit the order still records sat in no journal in any ledger, for ever.
  const rebuilt = state.syncLogs.filter((log) => log.referenceId === dayOneRef)
  assert.equal(rebuilt.length, 1, `the earlier batch IS rebuilt: ${JSON.stringify(refusals)}`)
  assert.equal(rebuilt[0].connector, 'xero', 'in the ledger whose pass carried those pounds')
  assert.notEqual(rebuilt[0].id, lostJournalId, 'under a new id')
  const debit = (rebuilt[0].payload as { lines: Array<{ accountCode?: string; debit?: number }> })
    .lines.find((line) => line.accountCode === CHART.xero.allocated && line.debit != null)
  assert.equal(debit?.debit, Math.round(xeroShare * 100) / 100, 'for ITS OWN share, never the cumulative figure')
  assert.deepEqual(refusals, [], 'and nothing is refused — the history answered every question')

  // AND THE EVIDENCE MOVES WITH IT (r5), which only has anything to move because the bucket exists.
  const passes = state.orders[0].allocationBatchPasses as Array<{ syncLogId: string | null; batchRef: string }>
  assert.equal(passes[0].syncLogId, rebuilt[0].id, 'the day-one pass names the journal that now carries its pounds')
  assert.equal(passes[0].batchRef, dayOneRef)
  assert.notEqual(passes[1].syncLogId, rebuilt[0].id, 'and the day-two pass is untouched — a different batch')
  assert.equal(
    state.orders[0].inventoryAllocatedBatchRef,
    dayTwoRef,
    'and the stamp is left alone: this rebuild was not about the batch the order is stamped with',
  )
})

test('o3d-i0o6 r7: and the OTHER ledger\'s sweep REPORTS that earlier batch instead of ignoring it', async () => {
  // The same missing J1, swept by the connector that is actually scheduled. QuickBooks may not
  // rebuild Xero's pounds into its own accounts — that is r5's duplicate-debit rule — but round 6
  // established that it must SAY SO when nothing else is coming for them. It could not: the R1
  // bucket did not exist here either, so the pass was in no `foreign` list and the report round 6
  // added was silent in exactly the history it was written for.
  const { dayOneRef } = await xeroThenQuickBooksUnderTwoBatches()
  const xeroShare = Number((state.orders[0].allocationBatchPasses as Array<{ amount: string }>)[0].amount)
  const lostJournalId = (state.orders[0].allocationBatchPasses as Array<{ syncLogId: string }>)[0].syncLogId
  state.syncLogs = state.syncLogs.filter((log) => log.id !== lostJournalId)

  // The books are on QuickBooks: the cron runs QuickBooks' sweep and returns, so Xero's — the one
  // that WOULD rebuild R1, as the test above proves — never runs at all.
  scheduleDailyBatchOn('quickbooks')
  switchConnector('quickbooks')
  const before = state.syncLogs.length
  const refusals = await runRecreate()

  assert.equal(state.syncLogs.length, before, 'QuickBooks raises NOTHING for a batch whose pounds are Xero\'s')
  const report = refusals.filter((line) => line.includes(dayOneRef))
  assert.equal(report.length, 1, `but it reports it: ${JSON.stringify(refusals)}`)
  assert.match(report[0], /debited to Allocated Inventory on xero/, 'naming the ledger the pounds are in')
  assert.ok(report[0].includes(`£${xeroShare.toFixed(2)}`), `and the pounds: ${report[0]}`)
  assert.match(report[0], /the daily batch runs quickbooks's sweep, not xero's/, 'and why nobody is coming for it')
})

// ---------------------------------------------------------------------------
// o3d-i0o6 r7 (Codex round 6, MEDIUM) — A FAILED OR CANCELLED FOREIGN JOURNAL IS NOT A MISSING ONE.
//
// The foreign-journal probe selected only PENDING/PROCESSING/SYNCED, so a row in any other status
// came back indistinguishable from a deleted one and the report said the journal was "NOT on record"
// and told an operator to post it by hand. Neither FAILED nor CANCELLED establishes that nothing
// reached the remote ledger — a failed attempt can post and then fail, and a cancellation is a local
// decision about the ROW — so following that advice can duplicate a real posting.
// ---------------------------------------------------------------------------

for (const status of ['FAILED', 'CANCELLED'] as const) {
  test(`o3d-i0o6 r7: a foreign journal that is ${status} is reported as AMBIGUOUS, not as absent`, async () => {
    const { dayTwoRef } = await xeroThenQuickBooksUnderTwoBatches()
    const qboJournalId = (state.orders[0].allocationBatchPasses as Array<{ syncLogId: string }>)[1].syncLogId
    const qboShare = Number((state.orders[0].allocationBatchPasses as Array<{ amount: string }>)[1].amount)

    // The row is STILL THERE. It simply never reached SYNCED — which is a different fact from the
    // r6 scenario, where the row was gone.
    const row = state.syncLogs.find((log) => log.id === qboJournalId)
    assert.ok(row, 'precondition: the journal the QuickBooks pass names is on record')
    row.status = status

    scheduleDailyBatchOn('xero')
    switchConnector('xero')
    const before = state.syncLogs.length
    const refusals = await runRecreate()

    assert.equal(state.syncLogs.length, before, 'Xero still raises nothing for another ledger\'s pounds')
    const report = refusals.filter((line) => line.includes(dayTwoRef))
    assert.equal(report.length, 1, `it is still reported: ${JSON.stringify(refusals)}`)
    assert.ok(report[0].includes(`£${qboShare.toFixed(2)}`))

    // THE FINDING, IN WORDS AN OPERATOR ACTS ON. Before this fix the message was byte-identical to
    // the deleted-row one: "that journal is NOT on record … Post it in quickbooks by hand".
    assert.match(report[0], /did NOT settle in IMS/, 'the row exists — it just did not settle')
    assert.match(report[0], /whose row is on record but never reached SYNCED/)
    assert.match(report[0], /CHECK quickbooks FIRST/, 'and the remedy is safe for an ambiguous posting')
    assert.ok(
      !/that journal is NOT on record/.test(report[0]),
      'and it must NOT claim the journal is absent — that is what licensed the duplicate',
    )
  })
}

test('o3d-i0o6 r7: THE CONTROL — a foreign journal that is genuinely GONE keeps the post-by-hand remedy', async () => {
  // The narrowing must not swallow the r6 case: a row that is absent inside the retention window
  // never posted, so posting it by hand is safe and the report must still say so. Without this
  // control the ambiguity wording could be emitted unconditionally and both tests would pass.
  const { dayTwoRef } = await xeroThenQuickBooksUnderTwoBatches()
  const qboJournalId = (state.orders[0].allocationBatchPasses as Array<{ syncLogId: string }>)[1].syncLogId
  state.syncLogs = state.syncLogs.filter((log) => log.id !== qboJournalId)

  scheduleDailyBatchOn('xero')
  switchConnector('xero')
  const refusals = await runRecreate()

  const report = refusals.filter((line) => line.includes(dayTwoRef))
  assert.equal(report.length, 1, `still reported: ${JSON.stringify(refusals)}`)
  assert.match(report[0], /that journal is NOT on record/)
  assert.match(report[0], /Post it in quickbooks by hand/)
  assert.ok(!/did NOT settle in IMS/.test(report[0]), 'an absent row is not an ambiguous one')
})

// ---------------------------------------------------------------------------
// o3d-i0o6 r7 — AND THE HISTORICAL BUCKETS ARE BOUND BY RETENTION, LIKE THE QUERY THAT FOUND THEM.
//
// The sweep's own query is bounded to the sync-log retention window because beyond it a SYNCED
// daily-batch log has been HARD-DELETED, so "missing" cannot be told from "posted then pruned" and a
// rebuild re-posts a journal that is already in the ledger (scjz.36). That query bounds the ORDER by
// its CURRENT stage stamp. Reading earlier batches out of the pass history reaches past it: an order
// stamped inside the window can name a pass from months before it. Rebuilding that one is exactly
// the double-post the window exists to prevent, so a historical target is dropped when the BATCH'S
// OWN date falls before the cutoff.
// ---------------------------------------------------------------------------

const LONG_AGO = new Date('2026-01-15T10:00:00.000Z')

/** Two REAL Xero A2 passes MONTHS apart: £50 under a January batch, £25 under a July one. */
async function twoXeroBatchesMonthsApart(): Promise<{ oldRef: string; newRef: string; lostJournalId: string }> {
  reset('xero')
  mock.timers.enable({ apis: ['Date'], now: LONG_AGO })
  let oldRef: string
  let newRef: string
  try {
    state.unitCostByProduct = { 'prod-1': 12.5 }
    state.orders = [newOrder('order-1')]
    state.allocations = [
      { id: 'alloc-1', orderId: 'order-1', lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4, costLayerSnapshot: null, allocationBatchAmount: null },
    ]
    await runA2(1)
    oldRef = state.orders[0].inventoryAllocatedBatchRef as string
    assert.ok(oldRef.startsWith('A2-2026-01-15'), `the old batch is dated in January: ${oldRef}`)
    state.syncLogs[0].status = 'SYNCED'

    await declaredRewrite('order-1', 6)
    mock.timers.setTime(DAY_TWO.getTime())
    await runA2(1)
    newRef = state.orders[0].inventoryAllocatedBatchRef as string
  } finally {
    mock.timers.reset()
  }
  assert.ok(newRef.startsWith('A2-2026-07-21'), `the new batch is dated in July: ${newRef}`)
  const newLog = state.syncLogs.find((log) => log.referenceId === newRef)
  assert.ok(newLog, 'July really did raise a journal')
  newLog.status = 'SYNCED'

  // The JANUARY journal is the one that is gone.
  const lostJournalId = (state.orders[0].allocationBatchPasses as Array<{ syncLogId: string }>)[0].syncLogId
  state.syncLogs = state.syncLogs.filter((log) => log.id !== lostJournalId)
  return { oldRef, newRef, lostJournalId }
}

test('o3d-i0o6 r7: a historical batch OUTSIDE the retention window is not rebuilt', async () => {
  const { oldRef } = await twoXeroBatchesMonthsApart()
  scheduleDailyBatchOn('xero')
  switchConnector('xero')
  // Six months of sync-log retention. The January batch is older than that, so its absent log is
  // indistinguishable from one data-retention pruned AFTER it posted.
  state.settings.retention_sync_logs_months = '6'

  const before = state.syncLogs.length
  const refusals = await runRecreate()

  assert.equal(state.syncLogs.length, before, 'nothing is rebuilt for a batch retention may already have pruned')
  assert.deepEqual(
    state.syncLogs.filter((log) => log.referenceId === oldRef),
    [],
    'and specifically no January journal — rebuilding it would be the scjz.36 double-post',
  )
  assert.deepEqual(refusals, [], 'and it is not reported either: this is a bound, not an anomaly')
})

test('o3d-i0o6 r7: THE CONTROL — with retention disabled the same historical batch IS rebuilt', async () => {
  // Nothing is pruned when retention is off, so an absent log genuinely never posted and the batch
  // is the sweep's to rebuild. Without this control the test above would pass for a fix that simply
  // stopped reading the history at all — which is M4, and it must stay separately killable.
  const { oldRef } = await twoXeroBatchesMonthsApart()
  scheduleDailyBatchOn('xero')
  switchConnector('xero')
  state.settings.retention_sync_logs_months = '0'

  const refusals = await runRecreate()

  assert.deepEqual(refusals, [])
  const rebuilt = state.syncLogs.filter((log) => log.referenceId === oldRef)
  assert.equal(rebuilt.length, 1, 'the January batch is rebuilt when nothing could have pruned its log')
  const debit = (rebuilt[0].payload as { lines: Array<{ accountCode?: string; debit?: number }> })
    .lines.find((line) => line.accountCode === CHART.xero.allocated && line.debit != null)
  assert.equal(debit?.debit, 50, 'for the £50 THAT batch carried, not the cumulative £75')
})
