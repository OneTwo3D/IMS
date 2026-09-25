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
  connector: 'xero' as const,
  /**
   * o3d-i0o6 r6: the rows `resolveScheduledDailyBatchSweep` reads — the SAME two the cron route
   * reads — so "whose sweep does the cron actually run?" is answered here by the real resolver
   * rather than by a boolean the test hands the sweep.
   */
  settings: {} as Record<string, string>,
  enabledPlugins: [] as Array<'xero'>,
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

function reset(connector: 'xero'): void {
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
// o3d-remove-parked-connectors: a `mock.module` for an archived QuickBooks module was here.

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: 'xero') => state.enabledPlugins.includes(id),
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
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()
  assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
  assert.equal(result.groupA2, expectedOrders, 'the A2 window must really have processed the order(s)')
}

/** Run the REAL recreate sweep of the connector under test, returning its refusals. */
async function runRecreate(): Promise<string[]> {
  const [{ recreateMissingDailyBatchLogs }, { getXeroSettings }] = await Promise.all([
    import('@/lib/connectors/xero/daily-sync'),
    import('@/lib/connectors/xero/settings'),
  ])
  return recreateMissingDailyBatchLogs(await getXeroSettings(), 'GBP')
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
async function postedThenRoundedAwayUnderANewBatch(connector: 'xero'): Promise<void> {
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

// ONE WRITER TODAY (o3d-remove-parked-connectors): the QuickBooks daily-sync writer is archived.
// The loop shape is kept so a second writer inherits every case; what is lost is the cross-port
// evidence that the rule holds in an independently-written second writer.
for (const connector of ['xero'] as const) {
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
function switchConnector(connector: 'xero'): void {
  state.connector = connector
}

/**
 * o3d-i0o6 r6: arrange the rows that decide WHOSE daily-batch sweep the cron runs, and let the real
 * `resolveScheduledDailyBatchSweep` read them — the same function the cron route itself now calls.
 * `null` is "no accounting plugin enabled", i.e. no sweep runs at all.
 */
function scheduleDailyBatchOn(connector: 'xero' | null): void {
  state.enabledPlugins = connector ? [connector] : []
  state.settings = connector
    ? { [`${connector}_daily_batch_enabled`]: 'true', [`${connector}_sync_enabled`]: 'true' }
    : {}
}

// ---------------------------------------------------------------------------------------------
// THE CROSS-LEDGER SECTION WAS HERE, AND IS DELETED WITH ITS SUBJECT
// (o3d-remove-parked-connectors).
// ---------------------------------------------------------------------------------------------
//
// Nine cases and one fixture (`xeroThenQuickBooksUnderTwoBatches`) built a state that two REAL
// writers had left behind — a Xero A2 pass on day one, a books switch, a QuickBooks A2 pass on day
// two — and asserted the recreate sweep's cross-ledger rules on it:
//
//   * o3d-i0o6 r5: Xero's sweep does NOT rebuild a QuickBooks-attributed batch into Xero accounts
//     (the duplicate-debit rule), and the control that QuickBooks still rebuilds its OWN share;
//   * o3d-i0o6 r6: a batch whose pounds are in a ledger NO scheduled sweep will rebuild is REPORTED
//     rather than silently zeroed, and it stays QUIET when that ledger's own sweep IS the scheduled
//     one (the two halves of "its own sweep will rebuild it" being a claim about the cron);
//   * o3d-i0o6 r7: an EARLIER batch whose journal went missing is rebuilt by its own ledger's sweep,
//     and the OTHER ledger's sweep REPORTS it instead of ignoring it; plus the FAILED/CANCELLED
//     foreign-journal ambiguity cases and their genuinely-gone control.
//
// EVERY ONE of those needs two REGISTERED accounting connectors: one to write the foreign pass, and
// one whose sweep runs. QuickBooks is archived, so there is no second writer to build the state and
// no second sweep to run it. They cannot be re-pointed at an unregistered id either — the fixture
// does not fabricate rows, it RUNS both writers, which is exactly why it was trustworthy.
//
// THE RULES THEMSELVES ARE STILL IN THE CODE. `recreateMissingDailyBatchLogs` still filters live logs
// by `connector`, still computes a per-ledger share from the pass history, and still reports a
// foreign share nobody is scheduled to rebuild — and with rows stamped `quickbooks` surviving in
// development databases, that reporting path is what an operator will actually meet. It is now
// UNTESTED. This is the single largest coverage loss in the QuickBooks removal and it is recorded as
// such in docs/archive/quickbooks-connector-removal.md; the revival note says to restore this section
// from `git show archive/quickbooks-connector:tests/accounting/daily-batch-recreate-pass-share.test.ts`
// alongside the connector.
//
// What is KEPT below and above: every case that needs one ledger only — the rounded-to-zero rule, the
// rebuild-re-points-the-evidence rule, and the retention-window bucket rules.

/**
 * o3d-i0o6 r5 (HIGH 2) — THE REBUILT JOURNAL IS THE ONE THE EVIDENCE NAMES AFTERWARDS.
 *
 * A rebuild mints a NEW sync log. The orders it rebuilt FROM still recorded the id of the log that
 * went missing, and that id is precisely what `proveAllocationDebitPosting` resolves before it will
 * authorise a credit. So the recreated debit used to be permanently irreversible: the pounds are in
 * Allocated Inventory, and every refund and orphan reversal for the rest of the order's life
 * resolves a dead id, refuses, and withholds the credit.
 */
// ONE WRITER TODAY (o3d-remove-parked-connectors): the QuickBooks daily-sync writer is archived.
// The loop shape is kept so a second writer inherits every case; what is lost is the cross-port
// evidence that the rule holds in an independently-written second writer.
for (const connector of ['xero'] as const) {
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
