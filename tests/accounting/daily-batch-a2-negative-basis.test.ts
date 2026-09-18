import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-sidy review H1 (HIGH) — GROUP A2 TOOK A NEGATIVE BASIS IN, SILENTLY, IN THE SAME RUN.
//
// The independent review EXECUTED it on a scratch database: an order allocated and dispatched the
// same day, before the batch (the ordinary e-commerce case), its shipment snapshot at £4; a credit
// freight line drove the layer to -6; a healthy allocated order at £20 beside it. A2 took the
// dispatched units from the rewritten snapshot at -6 with no error, posted DR Allocated / CR
// Inventory £14 where £24 was owed, stamped the order `allocationBatchAmount -6` and pinned
// `postedUnitCostBase -6`. Group B then refused the shipment correctly — and after the operator
// followed the documented correction, the second batch posted COGS £4 / CR Allocated £4 against an
// A2 that had debited Allocated -6: Allocated Inventory £10 short and Inventory £10 over, for good.
//
// These drive the real runDailyBatchSync against doubles in the shape of
// daily-batch-a2-mixed-shipment.test.ts, extended to SEVERAL orders in one window and a layer shelf
// keyed by product, because what is under test is that one order's refusal leaves the others'
// journal exactly as it would have been without it.

type Allocation = { id: string; lineId: string; productId: string; warehouseId: string; qty: number; costLayerSnapshot: unknown }
type ShipmentLine = { id: string; lineId: string; productId: string; qty: number; costLayerSnapshot: unknown }
type Order = {
  id: string
  orderNumber: string
  externalOrderNumber: string | null
  status: string
  allocationBatchAmount: null
  allocationBatchPasses: null
  allocations: Allocation[]
  shipments: Array<{ id: string; status: string; warehouseId: string; lines: ShipmentLine[] }>
}
type Layer = { id: string; productId: string; warehouseId: string; remainingQty: number; unitCostBase: number; receivedAt: number }

let orders: Order[] = []
let shelf: Layer[] = []
const created: Array<{ type: string; referenceId: string; payload: Record<string, unknown> }> = []
const allocationUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
const orderUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
const activity: Array<Record<string, unknown>> = []

function reset(nextOrders: Order[], nextShelf: Layer[]) {
  orders = nextOrders
  shelf = nextShelf
  created.length = 0
  allocationUpdates.length = 0
  orderUpdates.length = 0
  activity.length = 0
}

const tx = {
  costLayer: {
    // buildLayerSnapshot asks twice: candidates for a (product, warehouse), then the same rows by id.
    findMany: async ({ where }: { where: { productId?: string; warehouseId?: string; id?: { in: string[] } } }) => {
      const rows = where.id?.in
        ? shelf.filter((layer) => where.id!.in.includes(layer.id))
        : shelf.filter((layer) => layer.productId === where.productId && layer.warehouseId === where.warehouseId && layer.remainingQty > 0)
      return rows.sort((a, b) => a.receivedAt - b.receivedAt)
        .map((layer) => ({ id: layer.id, remainingQty: layer.remainingQty, unitCostBase: layer.unitCostBase }))
    },
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
    // Honours the three things the A2 window asks of it: `id in` (the re-read under the lock),
    // `id notIn` (o3d-sidy r2: a later pass looking past refused orders) and `take` (the window).
    findMany: async (args?: { select?: Record<string, unknown>; where?: { id?: { in?: string[]; notIn?: string[] } }; take?: number }) => {
      let rows = orders
      const id = args?.where?.id
      if (id?.in) rows = rows.filter((order) => id.in!.includes(order.id))
      if (id?.notIn) rows = rows.filter((order) => !id.notIn!.includes(order.id))
      if (typeof args?.take === 'number') rows = rows.slice(0, args.take)
      return args?.select?.allocations ? rows : rows.map((order) => ({ id: order.id }))
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      orderUpdates.push({ id: where.id, data })
      return { id: where.id }
    },
  },
  // Group B is not what these tests are about: no shipment is eligible for it.
  shipment: { findMany: async () => [], update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefundLine: { findMany: async () => [] },
  salesOrderRefund: { findMany: async () => [] },
  accountingSyncLog: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: { type: string; referenceId: string; payload: Record<string, unknown> } }) => {
      created.push({ type: data.type, referenceId: data.referenceId, payload: data.payload })
      return { id: `log-${created.length}` }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
  $queryRaw: async (...args: unknown[]) => {
    const first = args[0]
    const text = first && typeof first === 'object' && 'sql' in (first as Record<string, unknown>)
      ? String((first as { sql: unknown }).sql)
      : Array.isArray(first) ? first.join(' ') : String(first)
    // The allocation write lock returns the record each row holds; honour its id predicate.
    if (text.includes('order_allocations') && text.includes('FOR UPDATE')) {
      const ids = Array.isArray(first) ? [] : ((first as { values?: unknown[] }).values ?? [])
      const rows = orders.flatMap((order) => order.allocations)
        .map((alloc) => ({ id: alloc.id, costLayerSnapshot: alloc.costLayerSnapshot }))
      return ids.length === 0 ? rows : rows.filter((row) => ids.includes(row.id))
    }
    return []
  },
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
for (const path of [
  '@/lib/domain/accounting/inventory-gl-reconciliation',
  '@/lib/domain/accounting/cogs-gl-reconciliation',
  '@/lib/domain/accounting/transit-gl-reconciliation',
]) {
  const build = path.includes('inventory') ? 'buildInventoryReconciliationSweepJournal'
    : path.includes('cogs') ? 'buildCogsReconciliationSweepJournal' : 'buildTransitReconciliationSweepJournal'
  const load = path.includes('inventory') ? 'loadInventoryGlReconciliation'
    : path.includes('cogs') ? 'loadCogsGlReconciliation' : 'loadTransitGlReconciliation'
  mock.module(path, { namedExports: { [load]: async () => null, [build]: () => null } })
}
mock.module('@/lib/domain/accounting/cogs-subledger-movement', {
  namedExports: { recordCogsSubledgerMovement: async () => undefined },
})

async function run() {
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  return runDailyBatchSync()
}
async function referenceFor(orderIds: string[]) {
  const { buildDailyBatchReferenceId } = await import('@/lib/connectors/xero/daily-sync')
  return buildDailyBatchReferenceId('A2', new Date().toISOString().slice(0, 10), orderIds)
}

/** An order allocated AND dispatched before the batch: its one unit is in a shipment snapshot at `unitCost`. */
function dispatchedOrder(tag: string, unitCost: string): Order {
  return {
    id: `order-${tag}`, orderNumber: `SO-${tag}`, externalOrderNumber: null, status: 'SHIPPED',
    allocationBatchAmount: null, allocationBatchPasses: null,
    allocations: [{ id: `alloc-${tag}`, lineId: `line-${tag}`, productId: `prod-${tag}`, warehouseId: 'wh-1', qty: 1, costLayerSnapshot: null }],
    shipments: [{
      id: `ship-${tag}`, status: 'SHIPPED', warehouseId: 'wh-1',
      lines: [{
        id: `sl-${tag}`, lineId: `line-${tag}`, productId: `prod-${tag}`, qty: 1,
        costLayerSnapshot: [{ costLayerId: `layer-${tag}`, qty: '1.000000', unitCostBase: unitCost, shipmentLineId: `sl-${tag}`, source: 'shipment' }],
      }],
    }],
  }
}

/** An order allocated and NOT dispatched: A2 pins `qty` units off the shelf for `productId`. */
function allocatedOrder(tag: string, productId: string, qty: number): Order {
  return {
    id: `order-${tag}`, orderNumber: `SO-${tag}`, externalOrderNumber: null, status: 'ALLOCATED',
    allocationBatchAmount: null, allocationBatchPasses: null,
    allocations: [{ id: `alloc-${tag}`, lineId: `line-${tag}`, productId, warehouseId: 'wh-1', qty, costLayerSnapshot: null }],
    shipments: [],
  }
}

const a2Journal = () => created.find((log) => log.type === 'DAILY_BATCH_INVENTORY_ALLOC')
const a2Refusals = (errors: string[], orderNumber: string) =>
  errors.filter((error) => error.startsWith(`Group A2 order ${orderNumber}:`) && /negative cost basis/.test(error))

test('o3d-sidy H1: a same-day allocate-and-ship at a NEGATIVE basis is refused, and the healthy order beside it posts exactly its own £20', async () => {
  // The review's scenario, row for row: A dispatched at -6 (rewritten by the revaluation), H
  // allocated from a £20 layer.
  reset(
    [dispatchedOrder('A', '-6.000000'), allocatedOrder('H', 'prod-H', 1)],
    [{ id: 'layer-H', productId: 'prod-H', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: 20, receivedAt: 1 }],
  )

  const result = await run()

  const refusals = a2Refusals(result.errors, 'SO-A')
  assert.equal(refusals.length, 1, `A is refused by name: ${JSON.stringify(result.errors)}`)
  assert.match(refusals[0], /layer-A \(1 @ -6\)/, 'naming the layer and the negative unit cost')
  assert.equal(result.errors[0], refusals[0], 'and the refusal is FIRST in the run\'s errors (CronRun.statusReason keeps 500 characters)')

  const journal = a2Journal()
  assert.ok(journal, 'the batch still posts for the healthy order')
  assert.deepEqual(journal.payload.lines, [
    { accountCode: '631', description: 'Daily inventory allocation — 1 order(s)', debit: 20 },
    { accountCode: '630', description: 'Daily inventory allocation — 1 order(s)', credit: 20 },
  ], 'DR Allocated / CR Inventory £20 — not £14 netted, and the count names ONE order')
  assert.equal(journal.referenceId, await referenceFor(['order-H']), 'the batch identity is derived from the orders actually in it')
  assert.equal(journal.payload.batchEntityCount, 1)

  assert.deepEqual(orderUpdates.map((u) => u.id), ['order-H'], 'only H is stamped — A keeps no inventoryAllocatedDate, no amount')
  assert.deepEqual(allocationUpdates.map((u) => u.id), ['alloc-H'], 'and only H\'s allocation record is written: A gets no postedUnitCostBase')
  assert.equal(result.groupA2, 1)

  const logged = activity.filter((entry) => entry.action === 'daily_batch_negative_cost_basis_refused')
  assert.equal(logged.length, 1, 'one activity entry per refusal')
  assert.equal(logged[0].level, 'ERROR')
  assert.equal(logged[0].entityType, 'SALES_ORDER')
  assert.equal(logged[0].entityId, 'order-A', 'against the order an operator would open')
  assert.equal((logged[0].metadata as { group?: string }).group, 'A2')
})

test('o3d-sidy H1: a negative basis reached through a LIVE LAYER (consumed, not recorded) is refused too', async () => {
  // Allocated, not shipped: A2 pins the unit off the shelf, and the shelf layer's unit cost is what
  // the revaluation drove negative.
  reset(
    [allocatedOrder('C', 'prod-C', 1)],
    [{ id: 'layer-C', productId: 'prod-C', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: -6, receivedAt: 1 }],
  )

  const result = await run()

  assert.equal(a2Refusals(result.errors, 'SO-C').length, 1, `refused: ${JSON.stringify(result.errors)}`)
  assert.equal(a2Journal(), undefined, 'no journal at all — the only order in the window was refused')
  assert.deepEqual(orderUpdates, [], 'and nothing is stamped')
  assert.deepEqual(allocationUpdates, [])
})

test('o3d-sidy H1: a refused order hands back the layers it took, so the next order values as if it had never been there', async () => {
  // D wants 2 units off a shelf of [£10, then -6]; E, valued after it, wants 1. Refusing D must give
  // BOTH layers back, or E finds the shelf empty and pins nothing at all.
  reset(
    [allocatedOrder('D', 'prod-P', 2), allocatedOrder('E', 'prod-P', 1)],
    [
      { id: 'layer-P1', productId: 'prod-P', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: 10, receivedAt: 1 },
      { id: 'layer-P2', productId: 'prod-P', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: -6, receivedAt: 2 },
    ],
  )

  const result = await run()

  assert.equal(a2Refusals(result.errors, 'SO-D').length, 1, 'D is refused for the -6 layer it would take')
  const journal = a2Journal()
  assert.ok(journal, 'E is reclassified')
  assert.equal((journal.payload.lines as Array<{ debit?: number }>)[0].debit, 10,
    'at £10 — the FIFO-oldest layer, which D had taken and handed back')
  const eRecord = allocationUpdates.find((u) => u.id === 'alloc-E')?.data.costLayerSnapshot as Array<{ costLayerId: string }>
  assert.deepEqual(eRecord?.map((entry) => entry.costLayerId), ['layer-P1'], 'and E\'s pin names that layer')
})

test('o3d-sidy H1: a ZERO basis is not refused', async () => {
  reset(
    [dispatchedOrder('Z', '0.000000'), allocatedOrder('H', 'prod-H', 1)],
    [{ id: 'layer-H', productId: 'prod-H', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: 20, receivedAt: 1 }],
  )

  const result = await run()

  assert.deepEqual(result.errors.filter((error) => /negative/i.test(error)), [], 'no refusal')
  assert.deepEqual(orderUpdates.map((u) => u.id).sort(), ['order-H', 'order-Z'], 'both orders reclassified')
  assert.equal((a2Journal()?.payload.lines as Array<{ debit?: number }>)[0].debit, 20)
})

test('o3d-sidy r2 (LOW 3): EVERY refused order hands its layers back, not only the first', async () => {
  // D1 and D2 each want 2 units off [£10, -6, then £20]; E wants 1. Both D orders reach the -6 layer
  // and are refused. If only the FIRST refusal handed back, D2 would keep the £10 and -6 layers and E
  // would pin the £20 layer instead.
  reset(
    [allocatedOrder('D1', 'prod-P', 2), allocatedOrder('D2', 'prod-P', 2), allocatedOrder('E', 'prod-P', 1)],
    [
      { id: 'layer-P1', productId: 'prod-P', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: 10, receivedAt: 1 },
      { id: 'layer-P2', productId: 'prod-P', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: -6, receivedAt: 2 },
      { id: 'layer-P3', productId: 'prod-P', warehouseId: 'wh-1', remainingQty: 5, unitCostBase: 20, receivedAt: 3 },
    ],
  )

  const result = await run()

  assert.equal(a2Refusals(result.errors, 'SO-D1').length, 1)
  assert.equal(a2Refusals(result.errors, 'SO-D2').length, 1)
  assert.equal((a2Journal()?.payload.lines as Array<{ debit?: number }>)[0].debit, 10,
    'E pins the FIFO-oldest £10 layer both refused orders handed back')
  const eRecord = allocationUpdates.find((u) => u.id === 'alloc-E')?.data.costLayerSnapshot as Array<{ costLayerId: string }>
  assert.deepEqual(eRecord?.map((entry) => entry.costLayerId), ['layer-P1'])
})

test('o3d-sidy r2 (MEDIUM): refused orders filling the window do not starve the healthy order behind them', async () => {
  // The window holds two orders. Both refused orders sit at its front; the healthy one is third.
  const previous = process.env.XERO_DAILY_BATCH_LIMIT
  process.env.XERO_DAILY_BATCH_LIMIT = '2'
  try {
    reset(
      [allocatedOrder('R1', 'prod-N', 1), allocatedOrder('R2', 'prod-N', 1), allocatedOrder('H', 'prod-H', 1)],
      [
        { id: 'layer-N', productId: 'prod-N', warehouseId: 'wh-1', remainingQty: 2, unitCostBase: -6, receivedAt: 1 },
        { id: 'layer-H', productId: 'prod-H', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: 20, receivedAt: 1 },
      ],
    )

    const result = await run()

    assert.equal(result.batchLimit, 2, 'PRECONDITION: the window really is two orders wide')
    assert.equal(a2Refusals(result.errors, 'SO-R1').length, 1, 'R1 refused once — not again by a later pass')
    assert.equal(a2Refusals(result.errors, 'SO-R2').length, 1, 'R2 refused once')
    assert.deepEqual(orderUpdates.map((u) => u.id), ['order-H'], 'H is reclassified in the SAME run')
    const journals = created.filter((log) => log.type === 'DAILY_BATCH_INVENTORY_ALLOC')
    assert.equal(journals.length, 1, 'by one journal, for H alone')
    assert.equal((journals[0].payload.lines as Array<{ debit?: number }>)[0].debit, 20)
    assert.equal(result.groupA2, 1)
    assert.equal(activity.filter((entry) => entry.action === 'daily_batch_negative_cost_basis_refused').length, 2,
      'one activity entry per refused order, however many passes the run took')
  } finally {
    if (previous === undefined) delete process.env.XERO_DAILY_BATCH_LIMIT
    else process.env.XERO_DAILY_BATCH_LIMIT = previous
  }
})

test('o3d-sidy r2 (LOW 2): a pass that ABORTS reports its abort, not the refusals it made before aborting', async () => {
  // R is refused first; X then throws the whole A2 transaction ("Missing FIFO snapshot": dispatched,
  // with no snapshot on the shipped line). Nothing in that pass committed, so R's refusal must not be
  // published as though the rest of the pass had gone through.
  const x = dispatchedOrder('X', '5.000000')
  x.shipments[0].lines[0].costLayerSnapshot = null
  reset(
    [allocatedOrder('R', 'prod-N', 1), x],
    [{ id: 'layer-N', productId: 'prod-N', warehouseId: 'wh-1', remainingQty: 1, unitCostBase: -6, receivedAt: 1 }],
  )

  const result = await run()

  assert.ok(result.errors.some((error) => error.startsWith('Group A2 error:') && /Missing FIFO snapshot/.test(error)),
    `PRECONDITION: the pass really aborted: ${JSON.stringify(result.errors)}`)
  assert.deepEqual(a2Refusals(result.errors, 'SO-R'), [], 'the refusal from the aborted pass is not reported')
  assert.deepEqual(activity.filter((entry) => entry.action === 'daily_batch_negative_cost_basis_refused'), [])
  assert.deepEqual(orderUpdates, [], 'and nothing was stamped')
})
