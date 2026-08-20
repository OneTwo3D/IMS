import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-0i5y r7 (Codex adversarial review) — THE LIVE GROUP A2 WRITER.
//
// r6 valued Group A2's shipment term as the WHOLE of every unjournaled shipment, and excluded
// journaled ones entirely, on the reading that a journal date proves A2 already posted that
// shipment's cost. Both halves break on a MIXED shipment — one an earlier pass had part-pinned:
//
//   unjournaled + mixed   the already-pinned part of the shipment was posted a SECOND time, on this
//                         pass and on every later one, because the whole shipment was valued.
//   journaled + mixed     the part the earlier pass could NOT pin was never posted at all, although
//                         Group B credited Allocated Inventory for the whole shipment's value when
//                         it journaled it.
//
// The first half is asserted here, on the real runDailyBatchSync and on the JOURNAL AMOUNT, because
// the defect is what A2 posts — no plan-level assertion can see it. The second half cannot be
// expressed as a fixture at all any more: A2 no longer selects or reads a shipment's journal date, so
// a journaled and an unjournaled shipment are the same input. That absence is pinned structurally in
// tests/xero-daily-batch.test.ts instead of by a fixture that would differ in a field nothing reads.

type AllocationRow = {
  id: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
  costLayerSnapshot: unknown
}

type ShipmentRow = {
  id: string
  status: string
  warehouseId: string
  lines: Array<{ id: string; lineId: string; productId: string; qty: number; costLayerSnapshot: unknown }>
}

/** The A2 window row this run will see; replaced per test. */
let a2Order: {
  id: string
  orderNumber: string
  externalOrderNumber: string | null
  status: string
  allocations: AllocationRow[]
  shipments: ShipmentRow[]
} | null = null

/** Cost layers on the shelf, per `productId|warehouseId`. */
let shelfLayers: Array<{ id: string; remainingQty: number; unitCostBase: number }> = []

const created: Array<{ type: string; referenceId: string; payload: Record<string, unknown> }> = []
const allocationUpdates: Array<{ id: string; costLayerSnapshot: unknown }> = []
const orderUpdates: Array<{ id: string; data: Record<string, unknown> }> = []

function resetRun(): void {
  created.length = 0
  allocationUpdates.length = 0
  orderUpdates.length = 0
}

const tx = {
  costLayer: {
    findMany: async () => shelfLayers.map((layer) => ({ ...layer })),
    update: async () => ({}),
  },
  orderAllocation: {
    findMany: async () => [],
    update: async ({ where, data }: { where: { id: string }; data: { costLayerSnapshot: unknown } }) => {
      allocationUpdates.push({ id: where.id, costLayerSnapshot: data.costLayerSnapshot })
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
  $queryRaw: async () => [],
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      salesOrder: {
        // A1's window, A2's window and the orphan sweeps all land here. Only A2 asks for the
        // allocation rows, which is what makes this dispatch exact rather than positional.
        findMany: async (args: { select?: Record<string, unknown> }) => (
          args?.select?.allocations && a2Order ? [a2Order] : []
        ),
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

/** The pinned entry an earlier pass wrote: 4 units off the shelf at £5. */
const ALREADY_PINNED = [{ costLayerId: 'layer-shelf-1', qty: '4.000000', unitCostBase: '5.000000' }]

/** One dispatched line: 6 units, at the £3 layers the dispatch actually consumed. */
function dispatchedLine(): ShipmentRow['lines'][number] {
  return {
    id: 'ship-line-1',
    lineId: 'line-1',
    productId: 'prod-1',
    qty: 6,
    costLayerSnapshot: [{
      costLayerId: 'layer-dispatched',
      qty: '6.000000',
      unitCostBase: '3.000000',
      shipmentLineId: 'ship-line-1',
      source: 'shipment',
    }],
  }
}

function mixedOrder(): NonNullable<typeof a2Order> {
  return {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'SHIPPED',
    allocations: [{
      id: 'alloc-1',
      lineId: 'line-1',
      productId: 'prod-1',
      warehouseId: 'wh-1',
      qty: 10,
      costLayerSnapshot: ALREADY_PINNED,
    }],
    shipments: [{ id: 'ship-1', status: 'SHIPPED', warehouseId: 'wh-1', lines: [dispatchedLine()] }],
  }
}

/** The A2 journal this run posted, or undefined if it posted none. */
function a2Journal(): { type: string; referenceId: string; payload: Record<string, unknown> } | undefined {
  return created.find((log) => log.type === 'DAILY_BATCH_INVENTORY_ALLOC')
}

test('Xero live Group A2 posts a MIXED shipment only for the part no pin already accounts for (o3d-0i5y r7)', async () => {
  resetRun()
  // 10 allocated. An earlier pass pinned 4 of them off the shelf at £5 and POSTED that £20.
  // 6 have since dispatched at £3, so 2 of the dispatched units are beyond the pin and 4 are not.
  // 4 remain on the shelf, unaccounted, to be pinned by this pass at £5.
  a2Order = mixedOrder()
  shelfLayers = [{ id: 'layer-shelf-2', remainingQty: 4, unitCostBase: 5 }]

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
  assert.equal(result.groupA2, 1, 'the mixed order was processed by A2')

  const journal = a2Journal()
  assert.ok(journal, 'A2 posted a reclassification journal')
  // 2 dispatched units beyond the pin at £3 = £6, plus 4 freshly pinned shelf units at £5 = £20.
  // r6 posted £38: the whole £18 shipment — including the £12 of it the earlier pass had already
  // pinned and posted — plus the same £20.
  assert.deepEqual(
    journal.payload.lines,
    [
      { accountCode: '631', description: 'Daily inventory allocation — 1 order(s)', debit: 26 },
      { accountCode: '630', description: 'Daily inventory allocation — 1 order(s)', credit: 26 },
    ],
    'A2 debits Allocated Inventory £26: £6 of dispatched units beyond the pin, £20 of fresh pin',
  )
  assert.equal(orderUpdates[0]?.data.allocationBatchAmount, 26, 'and the order records the same £26')

  // The row is the complete record: 4 already pinned + 2 recorded from the shipment + 4 freshly
  // pinned = all 10 allocated units, so the next pass owes nothing.
  assert.equal(allocationUpdates.length, 1)
  const written = allocationUpdates[0].costLayerSnapshot as Array<Record<string, string>>
  assert.deepEqual(
    written.map((entry) => [entry.costLayerId, String(entry.qty), entry.source ?? 'allocation']),
    [
      ['layer-shelf-1', '4.000000', 'allocation'],
      ['layer-dispatched', '2.000000', 'shipment'],
      ['layer-shelf-2', '4', 'allocation'],
    ],
    'exactly the 2 dispatched units it valued are recorded — never the 4 the pin already covered',
  )
})

test('Xero live Group A2 REFUSES the batch when a dispatched line it must account for carries no snapshot (o3d-0i5y r7)', async () => {
  resetRun()
  // r5 threw here (its whole-shipment valuation demanded a snapshot on every shipped line); r6's
  // record-and-do-not-value path would have silently under-accounted the row instead. The refusal
  // now names the row and the quantity rather than the batch.
  a2Order = mixedOrder()
  a2Order.shipments[0].lines[0].costLayerSnapshot = null
  shelfLayers = [{ id: 'layer-shelf-2', remainingQty: 4, unitCostBase: 5 }]

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.equal(result.groupA2, 0, 'nothing is stamped')
  assert.equal(created.length, 0, 'and nothing is posted')
  assert.match(
    result.errors.join('\n'),
    /Group A2 error:.*Missing FIFO snapshot on shipped line\(s\) for allocation alloc-1 on order order-1: 2 dispatched unit\(s\) to account for, only 0 recoverable/,
    'the refusal names the allocation, the order and the quantity it could not account for',
  )
})

// ---------------------------------------------------------------------------------------------
// o3d-0i5y r8 (Codex round 8) — TWO ROUTES TO THE SAME DOUBLE POST, BOTH ON THE JOURNAL AMOUNT.
//
// r7 fixed the QUANTITY: `accountedAllocationQty` says how many dispatched units no entry on the
// row accounts for, and the pass posts only those. It then chose the ENTRIES for that quantity by
// re-deriving them from every dispatched line at the scope, as though none had ever been taken —
// so a later pass was handed the FIRST shipment's already-posted entries again. And the record it
// all rests on was destroyed outright whenever a rewrite moved the row to another warehouse.
//
// Both are the same defect: a posted amount treated as a quantity to re-derive rather than a fact
// already recorded. The two tests below are the two routes, each asserted on what A2 posts.
// ---------------------------------------------------------------------------------------------

/** What an earlier pass recorded: all 6 units of the first dispatch, at the £10 layer it consumed. */
const RECORDED_FIRST_DISPATCH = [{
  costLayerId: 'layer-dispatch-1',
  qty: '6.000000',
  unitCostBase: '10.000000',
  shipmentLineId: 'ship-line-1',
  source: 'shipment',
}]

function shipmentOf(id: string, lineId: string, qty: number, layerId: string, unitCostBase: string): ShipmentRow {
  return {
    id,
    status: 'SHIPPED',
    warehouseId: 'wh-1',
    lines: [{
      id: lineId,
      lineId: 'line-1',
      productId: 'prod-1',
      qty,
      costLayerSnapshot: [{ costLayerId: layerId, qty: `${qty}.000000`, unitCostBase, shipmentLineId: lineId, source: 'shipment' }],
    }],
  }
}

test('Xero live Group A2 values a SECOND dispatch at its own layers, never at the first one it already posted (o3d-0i5y r8)', async () => {
  resetRun()
  // 10 allocated. 6 dispatched at £10 and RECORDED by an earlier pass, which posted that £60.
  // A residual of 4 has since dispatched at £2. Nothing is left on the shelf: 4 units are
  // unrecorded, and the entries for them are S2's — S1's are spent.
  a2Order = {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'SHIPPED',
    allocations: [{
      id: 'alloc-1',
      lineId: 'line-1',
      productId: 'prod-1',
      warehouseId: 'wh-1',
      qty: 10,
      costLayerSnapshot: RECORDED_FIRST_DISPATCH,
    }],
    shipments: [
      shipmentOf('ship-1', 'ship-line-1', 6, 'layer-dispatch-1', '10.000000'),
      shipmentOf('ship-2', 'ship-line-2', 4, 'layer-dispatch-2', '2.000000'),
    ],
  }
  shelfLayers = []

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
  assert.equal(result.groupA2, 1)

  const journal = a2Journal()
  assert.ok(journal, 'A2 posted a reclassification journal')
  // 4 units at S2's own £2 = £8. Together with the £60 the first pass posted, Allocated Inventory
  // holds £68 — exactly what the two dispatches cost. r7 took the 4 units off the FRONT of the
  // pool, which is still S1 at £10, and posted £40: £40 of S1's cost entered the ledger twice and
  // S2's £8 never entered it at all.
  assert.deepEqual(
    journal.payload.lines,
    [
      { accountCode: '631', description: 'Daily inventory allocation — 1 order(s)', debit: 8 },
      { accountCode: '630', description: 'Daily inventory allocation — 1 order(s)', credit: 8 },
    ],
    'A2 debits Allocated Inventory £8 — the second dispatch at its own cost',
  )
  assert.equal(orderUpdates[0]?.data.allocationBatchAmount, 8, 'and the order records the same £8')

  const written = allocationUpdates[0].costLayerSnapshot as Array<Record<string, string>>
  assert.deepEqual(
    written.map((entry) => [entry.costLayerId, String(entry.qty), String(entry.shipmentLineId)]),
    [
      ['layer-dispatch-1', '6.000000', 'ship-line-1'],
      ['layer-dispatch-2', '4.000000', 'ship-line-2'],
    ],
    'and the row records each dispatch once, against the line that dispatched it',
  )
})

test('Xero live Group A2 owes only the residual on a row whose record MOVED warehouse with it (o3d-0i5y r8)', async () => {
  resetRun()
  // THE ROW IS NOT A LITERAL — it is whatever the allocation rewrite decides this scope will hold.
  // 10 units A2 already posted at £5 sat at wh-2; the rewrite moves the whole claim to wh-1 and
  // raises it to 14. Building the fixture through the planner is what makes this test see the
  // allocator's decision: strip the carry-over and the row arrives blank, exactly as it did before.
  const { planAccountedRecordCarryOver } = await import('@/lib/domain/sales/allocation-service')
  const { allocationScopeKey } = await import('@/lib/domain/inventory/reservation-residual')
  const { Prisma } = await import('@/app/generated/prisma/client')
  const destination = { lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1' }
  const carriedRecord = planAccountedRecordCarryOver(
    [{
      lineId: 'line-1',
      productId: 'prod-1',
      warehouseId: 'wh-2',
      costLayerSnapshot: [{ costLayerId: 'layer-w2', qty: '10.000000', unitCostBase: '5.000000' }],
    }],
    [{ ...destination, qty: new Prisma.Decimal(14) }],
  ).get(allocationScopeKey(destination))?.write ?? null

  a2Order = {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'ALLOCATED',
    allocations: [{
      id: 'alloc-1',
      lineId: 'line-1',
      productId: 'prod-1',
      warehouseId: 'wh-1',
      qty: 14,
      costLayerSnapshot: carriedRecord,
    }],
    shipments: [],
  }
  shelfLayers = [{ id: 'layer-w1', remainingQty: 14, unitCostBase: 5 }]

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [])
  const journal = a2Journal()
  assert.ok(journal, 'A2 posted a reclassification journal')
  // 4 unaccounted units at £5. Before the carry-over the rewrite deleted the record with the row,
  // so this pass saw all 14 units unaccounted and posted £70 — £50 of it for units already sitting
  // in Allocated Inventory from the first posting, which nothing reverses.
  assert.deepEqual(
    journal.payload.lines,
    [
      { accountCode: '631', description: 'Daily inventory allocation — 1 order(s)', debit: 20 },
      { accountCode: '630', description: 'Daily inventory allocation — 1 order(s)', credit: 20 },
    ],
    'A2 debits Allocated Inventory £20 — the 4 new units only',
  )
  assert.equal(orderUpdates[0]?.data.allocationBatchAmount, 20)
})
