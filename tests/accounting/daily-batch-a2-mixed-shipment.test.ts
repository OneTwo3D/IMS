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

type A2OrderRow = {
  id: string
  orderNumber: string
  externalOrderNumber: string | null
  status: string
  allocations: AllocationRow[]
  shipments: ShipmentRow[]
}

/** The A2 window row this run will see; replaced per test. */
let a2Order: A2OrderRow | null = null

/**
 * o3d-0i5y r9: what a PRE-TRANSACTION, UNLOCKED read of the same order would have returned. Group
 * A2 must never see this — it selects and locks inside the transaction it writes in — so wiring it
 * to the outside-the-transaction `db` handle is what makes "the plan is made under the lock"
 * observable as a journal amount rather than as a source-text assertion.
 */
let staleA2Order: A2OrderRow | null = null

/**
 * o3d-0i5y r10: the `costLayerSnapshot` each allocation row holds AT THE MOMENT A2 TAKES ITS WRITE
 * LOCK, keyed by allocation id.
 *
 * `null` (the default) means "nothing moved" and the lock read is served from `a2Order` itself, so
 * every existing fixture behaves exactly as before. A test sets it to model the one writer that can
 * change these rows without the sales-order lock A2 holds — `updateSnapshotsForCostLayerChange`,
 * the late-landed-cost correction, which rewrites `unitCostBase` in place. A pass that writes back
 * the array it PLANNED from instead of the array it LOCKED silently discards that correction, and
 * this is the only way to see it: the two arrays differ in pounds, not in shape.
 */
let lockedA2Records: Record<string, unknown> | null = null

/** Ordered log of the calls A2 makes on the TRANSACTION client, for the lock-ordering assertion. */
const txCalls: string[] = []

/** Cost layers on the shelf, per `productId|warehouseId`. */
let shelfLayers: Array<{ id: string; remainingQty: number; unitCostBase: number }> = []

const created: Array<{ type: string; referenceId: string; payload: Record<string, unknown> }> = []
const allocationUpdates: Array<{ id: string; costLayerSnapshot: unknown }> = []
const orderUpdates: Array<{ id: string; data: Record<string, unknown> }> = []

function resetRun(): void {
  staleA2Order = null
  lockedA2Records = null
  txCalls.length = 0
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
    // o3d-0i5y r9: A2 now selects its window INSIDE the transaction and under the orders' row
    // locks, so this mock has to answer BOTH asks — the id-only candidate probe and the full
    // re-read under the lock. Answering only one of them would make every A2 test here vacuous.
    findMany: async (args?: { select?: Record<string, unknown> }) => {
      txCalls.push(args?.select?.allocations ? 'salesOrder.findMany:full' : 'salesOrder.findMany:ids')
      if (!a2Order) return []
      if (args?.select?.allocations) return [a2Order]
      return [{ id: a2Order.id }]
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
    // Two call shapes reach here: `Prisma.sql` objects (the sales-order and cost-layer row locks)
    // and a plain tagged template. Both are flattened to their SQL text so the ORDER of the locks
    // against the reads can be asserted.
    const first = args[0]
    const text = first && typeof first === 'object' && 'sql' in (first as Record<string, unknown>)
      ? String((first as { sql: unknown }).sql)
      : Array.isArray(first)
      ? first.join(' ')
      : String(first)
    const sql = text.replace(/\s+/g, ' ').trim()
    txCalls.push(`$queryRaw:${sql}`)
    // o3d-0i5y r10: the ALLOCATION-row write lock is a row-returning query — it hands back the
    // record each row holds as of the lock, which is what A2 must append onto. Answering it with
    // `[]` (as this double did while it was only ever a lock) would make every A2 row read as
    // holding NOTHING at write time, so the assertions below would be made against a writer that
    // had just been handed an empty base.
    if (sql.includes('order_allocations') && sql.includes('FOR UPDATE')) {
      const rows = (a2Order?.allocations ?? []).map((alloc) => ({
        id: alloc.id,
        costLayerSnapshot: lockedA2Records && alloc.id in lockedA2Records
          ? lockedA2Records[alloc.id]
          : alloc.costLayerSnapshot,
      }))
      // Honours the id predicate: A2 locks only the rows it is about to write, and a double that
      // returned rows it never asked for would hide a missing entry in that list.
      const ids = Array.isArray(args[0]) ? [] : ((args[0] as { values?: unknown[] }).values ?? [])
      return ids.length === 0 ? rows : rows.filter((row) => ids.includes(row.id))
    }
    return []
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      // o3d-o97 (merged): `createPendingSyncLog` stamps WHOSE ledger the batch was composed
      // against, and `activeAccountingIdProvenance()` reads it from here. A double without this
      // delegate throws INSIDE the batch transaction, and the run reports a group error for a
      // reason that has nothing to do with what is being posted. null is the honest answer: this
      // fixture models no connected ledger.
      accountingToken: { findUnique: async () => null },
      salesOrder: {
        // A1's window, A2's window and the orphan sweeps all land here. Only A2 asks for the
        // allocation rows, which is what makes this dispatch exact rather than positional.
        // o3d-0i5y r9: this is the handle OUTSIDE any transaction. Group A2 no longer reads through
        // it at all, so it answers with the STALE row — a read that happened before the lock was
        // taken. Any pass that still plans or stamps from here posts the stale figure, and the
        // lock test below is exactly that difference in pounds.
        findMany: async (args: { select?: Record<string, unknown> }) => (
          args?.select?.allocations ? (staleA2Order ? [staleA2Order] : []) : []
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
  // o3d-0i5y r9: and each entry THIS pass valued records the amount it was valued at, which is the
  // only thing that can price a later reversal — `unitCostBase` beside it is rewritten in place by
  // a landed-cost revaluation that never touches Allocated Inventory.
  assert.deepEqual(
    written.map((entry) => String(entry.postedUnitCostBase)),
    ['undefined', '2.000000'],
    'the entry the EARLIER pass recorded keeps its own posted amount (it had none); the one this '
    + 'pass valued is stamped with the £2 it posted, not re-stamped at anything current',
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
  ).records.get(allocationScopeKey(destination))?.write ?? null

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

// ---------------------------------------------------------------------------------------------
// o3d-0i5y r9 (Codex round 9) — THE TWO REMAINING ROUTES INTO A DOUBLE POST, BOTH ON THE AMOUNT.
//
//   the RECORD was erased by an undeclared allocation change, so A2 read an empty row and posted
//   the whole order again;
//   the PLAN was made from an unlocked pre-transaction snapshot, so what A2 stamped described a
//   state of the order that no longer held.
//
// Both are asserted on the real writer and on the journal it posts, because both are differences
// in pounds and nothing at plan level can see one.
// ---------------------------------------------------------------------------------------------

test('Xero live Group A2 posts only the INCREMENT after an undeclared allocation change (o3d-0i5y r9)', async () => {
  resetRun()
  // THE ROW IS NOT A LITERAL. It is whatever survives `resetAllocationAccountingIfStaged` when the
  // allocator declares its next set and that set holds one more unit than the record accounts for.
  //
  // o3d-0i5y r12 (rebase onto o3d-o97 / PR #635): r9 drove this through the UNDECLARED path
  // instead, because on this branch alone that path cleared the stamp and kept the record. It no
  // longer does: the merged rule KEEPS the stamp wherever the A2 debit stands, so Group A2 never
  // looks at the order again and there is no second pass for this test to be about. The behaviour
  // the test exists for — A2 comes back and posts the INCREMENT ALONE, never the whole order —
  // lives entirely on the DECLARED path now, and that is what is exercised here. What is asserted
  // below is unchanged, including the £20 figure.
  const { resetAllocationAccountingIfStaged } = await import('@/lib/domain/sales/allocation-service')
  const { toDecimal } = await import('@/lib/domain/math/decimal')
  const store: { record: unknown } = {
    record: [{ costLayerId: 'layer-1', qty: '10.000000', unitCostBase: '5.000000', postedUnitCostBase: '5.000000' }],
  }
  const resetTx = {
    salesOrder: {
      findUnique: async () => ({
        inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
        // A2 posted £50 for the ten units it recorded. The debit STANDS, which is what makes the
        // corroboration gate the thing being tested rather than bypassed.
        allocationBatchAmount: 50,
        allocationBatchSyncLogId: null,
      }),
      update: async () => ({}),
    },
    shipment: { findFirst: async () => null },
    shipmentLine: { findMany: async () => [] },
    activityLog: { create: async () => ({}) },
    accountingSyncLog: { findUnique: async () => null },
    orderAllocation: {
      findMany: async () => [{
        lineId: 'line-1',
        productId: 'prod-1',
        warehouseId: 'wh-1',
        costLayerSnapshot: store.record,
      }],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if ('costLayerSnapshot' in data) store.record = null
        return { count: 1 }
      },
    },
  }
  await resetAllocationAccountingIfStaged(
    resetTx as unknown as Parameters<typeof resetAllocationAccountingIfStaged>[0],
    'order-1',
    { nextAllocations: [{ lineId: 'line-1', productId: 'prod-1', warehouseId: 'wh-1', qty: toDecimal(11) }] },
  )

  // One more unit was allocated. A2 owes that unit and nothing else: the other ten are recorded,
  // and £50 of them is already sitting in Allocated Inventory.
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
      qty: 11,
      costLayerSnapshot: store.record,
    }],
    shipments: [],
  }
  shelfLayers = [{ id: 'layer-1', remainingQty: 11, unitCostBase: 5 }]

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [])
  const journal = a2Journal()
  assert.ok(journal, 'A2 posted a reclassification journal')
  assert.deepEqual(
    journal.payload.lines,
    [
      { accountCode: '631', description: 'Daily inventory allocation — 1 order(s)', debit: 5 },
      { accountCode: '630', description: 'Daily inventory allocation — 1 order(s)', credit: 5 },
    ],
    'A2 debits £5 — the one new unit. With the record erased it saw eleven unaccounted units and '
    + 'posted £55, £50 of it a second time for units already in Allocated Inventory',
  )
  assert.equal(orderUpdates[0]?.data.allocationBatchAmount, 5)
})

test('Xero live Group A2 plans and stamps from the LOCKED row, not a pre-transaction snapshot (o3d-0i5y r9)', async () => {
  resetRun()
  // The same order, read twice. Outside the transaction it still looks like ten unaccounted units
  // on a blank row — £50 to post. Inside the transaction, under its row lock, it is fourteen units
  // of which ten are already recorded and posted — £20 to post. A re-allocation landing in that gap
  // is not exotic: it is the 15-minute sweep, a stock movement, or an operator pressing Re-Allocate.
  staleA2Order = {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'ALLOCATED',
    allocations: [{
      id: 'alloc-1',
      lineId: 'line-1',
      productId: 'prod-1',
      warehouseId: 'wh-1',
      qty: 10,
      costLayerSnapshot: null,
    }],
    shipments: [],
  }
  a2Order = {
    ...staleA2Order,
    allocations: [{
      id: 'alloc-1',
      lineId: 'line-1',
      productId: 'prod-1',
      warehouseId: 'wh-1',
      qty: 14,
      costLayerSnapshot: [{
        costLayerId: 'layer-1',
        qty: '10.000000',
        unitCostBase: '5.000000',
        postedUnitCostBase: '5.000000',
      }],
    }],
  }
  shelfLayers = [{ id: 'layer-1', remainingQty: 14, unitCostBase: 5 }]

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [])
  const journal = a2Journal()
  assert.ok(journal, 'A2 posted a reclassification journal')
  assert.deepEqual(
    journal.payload.lines,
    [
      { accountCode: '631', description: 'Daily inventory allocation — 1 order(s)', debit: 20 },
      { accountCode: '630', description: 'Daily inventory allocation — 1 order(s)', credit: 20 },
    ],
    'A2 debits £20 — the four units the LOCKED row leaves unaccounted. Planning from the '
    + 'pre-transaction read posts £50 and overwrites the record that proves the first £50 posted',
  )

  // And the lock is taken BEFORE anything is read off the rows it protects — a plan made after the
  // lock is only worth what the ordering makes it worth.
  const lockIndex = txCalls.findIndex((call) => (
    call.startsWith('$queryRaw:') && call.includes('sales_orders') && call.includes('FOR UPDATE')
  ))
  const readIndex = txCalls.indexOf('salesOrder.findMany:full')
  assert.ok(lockIndex >= 0, 'A2 row-locks the orders it is about to post')
  assert.ok(readIndex >= 0, 'and reads them through the transaction client')
  assert.ok(lockIndex < readIndex, 'the lock comes first, so the read cannot describe a state that has already moved')
})

// ---------------------------------------------------------------------------------------------
// o3d-0i5y r10 (Codex round 10, finding 4) — THE WRITE, NOT THE PLAN.
//
// r9 moved A2's window read inside the transaction and under the orders' row locks. That closed the
// gap on everything the SALES-ORDER lock covers. It does not cover `order_allocations`, and there is
// exactly one writer that touches them without it: `updateSnapshotsForCostLayerChange`, the late-
// landed-cost correction, which selects rows by `costLayerSnapshot @> [{costLayerId}] FOR UPDATE`
// across every table that carries a snapshot and takes no order lock at all, because it does not
// know which orders it is about to touch.
//
// A2 rewrites the WHOLE snapshot array, and the front of that array is the base it read at the top
// of the transaction. So a correction committing in between is written straight back out.
// ---------------------------------------------------------------------------------------------

test('Xero live Group A2 keeps a landed-cost correction that lands between its plan and its write (o3d-0i5y r10)', async () => {
  resetRun()
  // 14 units allocated. 10 of them were pinned and posted by an earlier pass at £4 (£40 into
  // Allocated Inventory, recorded as `postedUnitCostBase`). While this batch is running, a landed
  // cost arrives for that layer and the correction reprices the row's ten recorded units £4 -> £5,
  // posting the £10 difference to COGS/Inventory — it never touches Allocated Inventory, which is
  // why `postedUnitCostBase` stays at £4.
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
      // What A2 reads when it plans.
      costLayerSnapshot: [{
        costLayerId: 'layer-1',
        qty: '10.000000',
        unitCostBase: '4.000000',
        postedUnitCostBase: '4.000000',
      }],
    }],
    shipments: [],
  }
  // What the row actually holds by the time A2 takes its write lock.
  lockedA2Records = {
    'alloc-1': [{
      costLayerId: 'layer-1',
      qty: '10.000000',
      unitCostBase: '5.000000',
      postedUnitCostBase: '4.000000',
    }],
  }
  shelfLayers = [{ id: 'layer-shelf', remainingQty: 4, unitCostBase: 5 }]

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [], 'the run must complete, not be asserted on after failing')
  assert.equal(result.groupA2, 1)

  // What this pass OWES is unchanged: four unaccounted units at the shelf's £5.
  assert.deepEqual(
    a2Journal()?.payload.lines,
    [
      { accountCode: '631', description: 'Daily inventory allocation — 1 order(s)', debit: 20 },
      { accountCode: '630', description: 'Daily inventory allocation — 1 order(s)', credit: 20 },
    ],
    'A2 still debits Allocated Inventory £20 — the correction is not this pass\'s to post',
  )

  assert.equal(allocationUpdates.length, 1)
  const written = allocationUpdates[0].costLayerSnapshot as Array<Record<string, string>>
  assert.equal(
    String(written[0].unitCostBase),
    '5.000000',
    'the corrected £5 survives A2\'s write. Writing back the planned array puts the row at £4 while '
    + 'the ledger says £5: Group B then relieves those ten units at £40, £10 of real cost never '
    + 'reaches COGS, and the refund reversal reverses the same £10 short',
  )
  assert.equal(
    String(written[0].postedUnitCostBase),
    '4.000000',
    'and the amount A2 actually POSTED is untouched by the revaluation — it is what prices a reversal',
  )
  assert.equal(written.length, 2, 'this pass appends its own entry; it does not re-author the base')
  assert.equal(String(written[1].costLayerId), 'layer-shelf')

  // And the write lock is taken on the ALLOCATION rows before they are written, after the cost-layer
  // lock — the ordering that keeps this deadlock-free against the correction itself, which runs
  // cost_layers -> order_allocations.
  const costLayerLock = txCalls.findIndex((call) => call.startsWith('$queryRaw:') && call.includes('cost_layers'))
  const allocationLock = txCalls.findIndex((call) => (
    call.startsWith('$queryRaw:') && call.includes('order_allocations') && call.includes('FOR UPDATE')
  ))
  assert.ok(allocationLock >= 0, 'A2 row-locks the allocation rows it is about to write')
  assert.ok(costLayerLock >= 0 && costLayerLock < allocationLock, 'and does so AFTER the cost-layer lock')
})

test('Xero live Group A2 REFUSES to write when the record it planned from changed QUANTITY (o3d-0i5y r10)', async () => {
  resetRun()
  // The revaluation maps every entry to itself, so it cannot change how many units a record
  // accounts for. A base that grew or shrank means a writer this pass cannot account for, and the
  // plan built on it — `outstanding` above all — describes a row that no longer exists.
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
      costLayerSnapshot: [{
        costLayerId: 'layer-1',
        qty: '10.000000',
        unitCostBase: '4.000000',
        postedUnitCostBase: '4.000000',
      }],
    }],
    shipments: [],
  }
  lockedA2Records = {
    'alloc-1': [{
      costLayerId: 'layer-1',
      qty: '6.000000',
      unitCostBase: '4.000000',
      postedUnitCostBase: '4.000000',
    }],
  }
  shelfLayers = [{ id: 'layer-shelf', remainingQty: 4, unitCostBase: 5 }]

  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.equal(result.groupA2, 0, 'nothing is stamped')
  // No row is written and no order is stamped. The journal `createPendingSyncLog` raised earlier in
  // the same transaction is rolled back with it in Postgres; this double is not transactional, so
  // the honest assertion here is on the writes that never happened rather than on `created`.
  assert.deepEqual(allocationUpdates, [], 'no allocation row is rewritten')
  assert.deepEqual(orderUpdates, [], 'and no order carries an A2 stamp out of this run')
  assert.match(
    result.errors.join('\n'),
    /Group A2 error:.*Allocation alloc-1 on order order-1 recorded 10 unit\(s\) when this pass planned from it and 6 unit\(s\) under the write lock/,
    'the refusal names the allocation, the order and both quantities',
  )
})
