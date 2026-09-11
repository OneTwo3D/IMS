import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-i0o6 r3 (Codex round 2, HIGH 3) — A CUMULATIVE DEBIT IS NOT PROVED BY ITS LATEST INSTALMENT.
 *
 * `SalesOrder.allocationBatchAmount` ACCUMULATES across Group A2 passes: the declared allocation
 * rewrite (`resetAllocationAccountingIfStaged`) hands a stamped order back with its debit standing,
 * and A2 returns to post the INCREMENT alone. The three attribution columns written by the SAME
 * statement — the journal id, its connector, its account code — are REPLACED by that pass. So the
 * amount described every pass and the attribution described the last one, and
 * `proveAllocationDebitPosting` compared them:
 *
 *   pass 1 debits £50 under J1, which FAILS. The order is re-allocated, the stamp comes off, and
 *   pass 2 debits the £5 increment into J2 — a SYNCED batch carrying a whole day's other orders,
 *   so its own DR to Allocated Inventory is £905. The order records £55 attributed to J2. The
 *   share-versus-batch check passes (£55 fits inside £905), the status check passes (J2 is SYNCED)
 *   and the proof answers `posted` FOR £55 — of which £50 never reached any ledger. The refund's
 *   residue and the orphan reverser then credit all £55 out of a real account.
 *
 * EVERY SCENARIO HERE IS BUILT BY RUNNING THE REAL GROUP A2 WRITER, twice, with the real declared
 * un-stage between the passes. Writing the two-pass row by hand would assert against a shape this
 * file believes A2 produces; running A2 asserts against the shape it does produce.
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
  revenueDeferredDate: Date | null
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
  /** Unit cost of the single FIFO layer each product has, so a pass can be valued to order. */
  unitCostByProduct: {} as Record<string, number>,
}

function newOrder(id: string, overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id,
    orderNumber: `SO-${id}`,
    externalOrderNumber: null,
    status: 'ALLOCATED',
    revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
    inventoryAllocatedDate: null,
    inventoryAllocatedBatchRef: null,
    allocationBatchAmount: null,
    allocationBatchPasses: null,
    allocationBatchSyncLogId: null,
    allocationBatchConnector: null,
    allocationBatchAccountCode: null,
    ...overrides,
  }
}

function reset(): void {
  state.orders = []
  state.allocations = []
  state.syncLogs = []
  state.unitCostByProduct = {}
}

/** The Group A2 window: deferred, not yet stamped, not fully refunded. */
function inA2Window(where: { inventoryAllocatedDate?: unknown; revenueDeferredDate?: unknown } | undefined): boolean {
  return !!where && where.inventoryAllocatedDate === null && where.revenueDeferredDate != null
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
    // Deliberately blind, exactly as the sibling A2 fixtures are: this file drives Group A2, and a
    // recreate/reset sweep that could see these rows would rewrite the very statuses under test.
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
    create: async ({ data }: { data: { type: string; referenceType?: string; referenceId: string; payload: unknown } }) => {
      const log: SyncLog = {
        id: `a2-log-${state.syncLogs.length + 1}`,
        type: data.type,
        referenceType: data.referenceType ?? 'DailyBatch',
        referenceId: data.referenceId,
        status: 'PENDING',
        connector: 'xero',
        payload: data.payload,
      }
      state.syncLogs.push(log)
      return { id: log.id }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
  // `lockAllocationRecords` re-reads the rows it is about to write UNDER THE LOCK, and A2 refuses
  // when the quantity it planned from moved. Answering `[]` would make that refusal fire on the
  // SECOND pass of every scenario here, so the double returns what the rows actually hold.
  $queryRaw: async () => state.allocations.map((row) => ({ id: row.id, costLayerSnapshot: row.costLayerSnapshot })),
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      accountingToken: { findUnique: async () => null },
      salesOrder: { findMany: async () => [] },
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

/** Run the REAL Group A2 pass over whatever is currently in the window. */
async function runA2(expectedOrders: number): Promise<void> {
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()
  assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
  assert.equal(result.groupA2, expectedOrders, 'the A2 window must really have processed the order(s)')
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

async function prove(orderId: string, activeConnector: 'xero' | 'quickbooks' = 'xero') {
  const { proveAllocationDebitPosting } = await import('@/lib/domain/accounting/allocation-debit-posting-proof')
  const order = state.orders.find((row) => row.id === orderId)!
  return proveAllocationDebitPosting(tx as never, order, {
    activeConnector,
    allocatedInventoryAccount: '631',
  })
}

/** Two REAL A2 passes over one order: £50, then a £5 increment inside a £905 batch. */
async function twoPassIncrement(): Promise<void> {
  reset()
  state.unitCostByProduct = { 'prod-1': 12.5, 'prod-filler': 100 }
  state.orders = [newOrder('order-1'), newOrder('order-filler', { inventoryAllocatedDate: new Date('2025-12-01T00:00:00.000Z') })]
  state.allocations = [
    { id: 'alloc-1', orderId: 'order-1', lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4, costLayerSnapshot: null, allocationBatchAmount: null },
    { id: 'alloc-filler', orderId: 'order-filler', lineId: 'line-filler', productId: 'prod-filler', warehouseId: 'wh-1', qty: 9, costLayerSnapshot: null, allocationBatchAmount: null },
  ]

  // PASS 1 — order-1 alone in the window: 4 units at £12.50 = £50, journal a2-log-1.
  await runA2(1)
  assert.equal(state.orders[0].allocationBatchAmount, 50)
  assert.equal(state.orders[0].allocationBatchSyncLogId, 'a2-log-1')

  // The declared rewrite: the order gains 0.4 of a unit, the stamp comes off, the £50 stays.
  await declaredRewrite('order-1', 4.4)
  assert.equal(state.orders[0].inventoryAllocatedDate, null, 'the stamp really did come off')
  assert.equal(state.orders[0].allocationBatchAmount, 50, 'and the recorded debit really did survive it')

  // PASS 2 — order-1's £5 increment lands in the same batch as the filler's £900.
  state.orders[1].inventoryAllocatedDate = null
  await runA2(2)
}

test('o3d-i0o6 r3: the A2 writers leave a CUMULATIVE amount attributed to the LATEST pass alone', async () => {
  await twoPassIncrement()

  const order = state.orders[0]
  assert.equal(order.allocationBatchAmount, 55, 'the amount is the sum of both passes')
  assert.equal(order.allocationBatchSyncLogId, 'a2-log-2', 'while the journal id is the second pass alone')
  const secondJournal = state.syncLogs.find((log) => log.id === 'a2-log-2')!
  const debit = (secondJournal.payload as { lines: Array<{ accountCode?: string; debit?: number }> }).lines
    .find((line) => line.accountCode === '631' && line.debit != null)
  assert.equal(debit?.debit, 905, 'and that journal carries a whole window, far more than the £55')
})

test('o3d-i0o6 r3: a FAILED first pass is not proved by the SYNCED batch the increment landed in', async () => {
  await twoPassIncrement()
  // The first pass's remote call failed — a DIFFERENT transaction, days later.
  state.syncLogs.find((log) => log.id === 'a2-log-1')!.status = 'FAILED'
  state.syncLogs.find((log) => log.id === 'a2-log-2')!.status = 'SYNCED'

  const proof = await prove('order-1')

  assert.notEqual(proof.kind, 'posted', 'NOTHING may be credited: £50 of the £55 reached no ledger')
  assert.equal(proof.kind, 'refused')
  assert.match(proof.reason, /is FAILED, not SYNCED/)
})

test('o3d-i0o6 r3: a first pass raised on ANOTHER LEDGER is not proved by the increment either', async () => {
  await twoPassIncrement()
  state.syncLogs.find((log) => log.id === 'a2-log-1')!.status = 'SYNCED'
  state.syncLogs.find((log) => log.id === 'a2-log-1')!.connector = 'quickbooks'
  state.syncLogs.find((log) => log.id === 'a2-log-2')!.status = 'SYNCED'

  const proof = await prove('order-1')

  assert.notEqual(proof.kind, 'posted', 'the £50 stands in another set of books, and a credit here would not touch it')
  assert.equal(proof.kind, 'refused')
  assert.match(proof.reason, /was raised on quickbooks/)
})

test('o3d-i0o6 r3: THE CONTROL — both passes SYNCED proves the whole £55, naming BOTH journals', async () => {
  await twoPassIncrement()
  for (const log of state.syncLogs) log.status = 'SYNCED'

  const proof = await prove('order-1')

  assert.equal(proof.kind, 'posted', 'every pass making up the amount is proved, on one ledger')
  assert.equal(proof.kind === 'posted' && proof.recordedDebit, 55)
  assert.deepEqual(
    proof.kind === 'posted' && [...proof.journalIds],
    ['a2-log-1', 'a2-log-2'],
    'and the verdict names every journal the figure came out of, not just the last',
  )
})

test('o3d-i0o6 r3: a pass whose batch ROUNDS TO ZERO clears the attribution and keeps the amount', async () => {
  // Codex round 2, HIGH 2 — THE REACHABLE PATH, reproduced through the real writers rather than
  // asserted about. A2 creates the batch log only when the window's ROUNDED total is positive, and
  // writes the per-order amount regardless: a second pass valued at £0.004 therefore preserves the
  // cumulative £50 AND nulls the journal id, the connector and the account code beside it.
  reset()
  state.unitCostByProduct = { 'prod-1': 12.5 }
  state.orders = [newOrder('order-1')]
  state.allocations = [
    { id: 'alloc-1', orderId: 'order-1', lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4, costLayerSnapshot: null, allocationBatchAmount: null },
  ]
  await runA2(1)
  assert.equal(state.orders[0].allocationBatchAmount, 50)

  await declaredRewrite('order-1', 4.0004)
  state.unitCostByProduct = { 'prod-1': 0.001 }
  await runA2(1)

  assert.equal(state.orders[0].allocationBatchAmount, 50, 'the cumulative debit survives the zero pass')
  assert.equal(state.orders[0].allocationBatchSyncLogId, null, 'and the journal id is GONE — this is the state HIGH 2 names')
  assert.equal(state.orders[0].allocationBatchConnector, null)
  assert.equal(state.orders[0].allocationBatchAccountCode, null)

  // And the pass history is what still answers for those £50, so the money is neither stranded nor
  // credited on nothing: the first pass is on record, SYNCED, and the zero pass contributed nothing.
  state.syncLogs.find((log) => log.id === 'a2-log-1')!.status = 'SYNCED'
  const proof = await prove('order-1')
  assert.equal(proof.kind, 'posted', 'the £50 first pass is still proved by its OWN journal')
  assert.equal(proof.kind === 'posted' && proof.recordedDebit, 50)
})

test('o3d-i0o6 r3: a pass that raised NO journal makes the whole cumulative debit unprovable', async () => {
  // The same shape with pounds in the second pass instead of a rounding tail: A2 valued the order
  // and raised nothing (its window rounded to zero around a real per-order figure). Those pounds
  // are in the cumulative amount and reached no ledger, so nothing may be credited for ANY of it.
  reset()
  state.unitCostByProduct = { 'prod-1': 12.5 }
  state.orders = [newOrder('order-1')]
  state.allocations = [
    { id: 'alloc-1', orderId: 'order-1', lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: 4, costLayerSnapshot: null, allocationBatchAmount: null },
  ]
  await runA2(1)
  state.syncLogs.find((log) => log.id === 'a2-log-1')!.status = 'SYNCED'

  // A second pass that values real pounds. Its journal is then DELETED by retention before the
  // reversal asks — the "a pass whose journal cannot be resolved" case, one pass deep.
  await declaredRewrite('order-1', 5)
  await runA2(1)
  assert.equal(state.orders[0].allocationBatchAmount, 62.5)
  state.syncLogs = state.syncLogs.filter((log) => log.id !== 'a2-log-2')

  const proof = await prove('order-1')
  assert.equal(proof.kind, 'refused')
  assert.match(proof.reason, /no longer on record \(retention\)/)
})
