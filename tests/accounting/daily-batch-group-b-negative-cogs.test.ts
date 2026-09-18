import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-sidy (P1) — A NEGATIVE COST BASIS REACHED GROUP B AND ITS COGS LINE WAS DROPPED IN SILENCE.
//
// Proved end to end on a scratch database before this test was written (o3d-sidy bd notes): a
// landed-cost recalc applying a CREDIT freight cost line drove a cost layer to -6.00;
// updateSnapshotsForCostLayerChange rewrote the ALREADY-SHIPPED line's snapshot to -6.00 in place,
// and refreshShipmentCogsForCostLayerChange handed the whole delta to the daily batch. The real
// runDailyBatchSync then wrote a DAILY_BATCH_GROUP_B journal carrying ONLY the revenue pair — its
// own narration said "COGS £-6.00" — because the COGS pair is gated on `totalCogsNumber > 0`.
// The shipment was stamped journaled, no sync row failed, result.errors said nothing, and the
// COGS subledger recorded a -6.00 dispatch the ledger never received.
//
// The daily batch does not post a negative cost basis (o3d-gd2f is the deferred decision; #683 refuses a
// negative implied unit cost rather than flip its sign). So Group B now REFUSES the order the way it
// already refuses a shipment with incomplete or mismatched snapshots: the order's shipments are left
// UN-journaled, so a corrected basis flows through the next batch, and the refusal is a named entry
// in result.errors, which turns the cron run FAILED with that reason (lib/ops/cron-run.ts).
//
// These drive the real runDailyBatchSync against doubles in the same shape as
// daily-batch-group-b-subledger-date.test.ts. Each scenario swaps the shipment set.

type Shipment = Record<string, unknown> & { id: string }

let shipments: Shipment[] = []
let allocations: Array<Record<string, unknown>> = []
const created: Array<{ type: string; payload: Record<string, unknown> }> = []
const cogsMovements: Array<{ sourceRef: string; baseDelta: unknown }> = []
const shipmentUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
const activity: Array<Record<string, unknown>> = []

function reset(next: Shipment[], nextAllocations: Array<Record<string, unknown>> = []) {
  shipments = next
  allocations = nextAllocations
  created.length = 0
  cogsMovements.length = 0
  shipmentUpdates.length = 0
  activity.length = 0
}

/** One order with one shipment of `qty` units whose line snapshot is `snapshot`. */
function shipment(id: string, snapshot: unknown, opts: { qty?: number; cogsBatchAmount?: number | null; revenue?: number } = {}): Shipment {
  const qty = opts.qty ?? 1
  const revenue = opts.revenue ?? 10
  const orderId = `order-${id}`
  const lineId = `line-${id}`
  return {
    id,
    orderId,
    warehouseId: 'wh-1',
    createdAt: new Date('2026-09-18T08:00:00.000Z'),
    cogsBatchAmount: opts.cogsBatchAmount === undefined ? null : opts.cogsBatchAmount,
    lines: [{
      id: `sl-${id}`,
      lineId,
      productId: 'prod-1',
      qty,
      costLayerSnapshot: snapshot,
      line: { id: lineId, productId: 'prod-1', qty, totalBase: revenue },
    }],
    order: {
      orderNumber: `SO-${id}`,
      externalOrderNumber: null,
      status: 'PICKING',
      refundStatus: 'NONE',
      totalBase: revenue,
      unearnedRevenueAmount: revenue,
      lines: [{ id: lineId, productId: 'prod-1', qty, totalBase: revenue }],
      shipments: [{ id, status: 'SHIPPED', shipmentJournalDate: null, revenueRecognizedAmount: null }],
    },
  }
}

const tx = {
  shipment: {
    findMany: async () => shipments,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      shipmentUpdates.push({ id: where.id, data })
      return { id: where.id }
    },
  },
  orderAllocation: { findMany: async () => allocations, update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefundLine: { findMany: async () => [] },
  salesOrderRefund: { findMany: async () => [] },
  salesOrder: { findMany: async () => [], update: async () => ({}) },
  costLayer: { update: async () => ({}) },
  accountingSyncLog: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
      created.push({ type: data.type, payload: data.payload })
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
  namedExports: {
    recordCogsSubledgerMovement: async (_client: unknown, args: { sourceRef: string; baseDelta: unknown }) => {
      cogsMovements.push({ sourceRef: args.sourceRef, baseDelta: args.baseDelta })
    },
  },
})

async function runDailyBatchSync() {
  const { runDailyBatchSync: run } = await import('@/lib/connectors/xero/daily-sync')
  return run()
}

type JournalLine = { accountCode: string; debit?: number; credit?: number }
const groupB = () => created.filter((c) => c.type === 'DAILY_BATCH_GROUP_B')
const linesOf = (entry: { payload: Record<string, unknown> }) => (entry.payload.lines ?? []) as JournalLine[]
const stamped = (id: string) => shipmentUpdates.some((u) => u.id === id && u.data.shipmentJournalDate !== undefined)
const refusalFor = (errors: string[], orderNumber: string) =>
  errors.filter((e) => e.startsWith(`Group B order ${orderNumber}:`) && /negative/i.test(e))

test('o3d-sidy: a shipment whose snapshot carries a NEGATIVE unit cost is refused by name, not journaled without its COGS', async () => {
  // The exact state the scratch-database run produced: one unit, snapshot rewritten to -6.00.
  reset([shipment('neg', [{ costLayerId: 'cl-neg', qty: '1.000000', unitCostBase: '-6.000000' }], { cogsBatchAmount: -6 })])

  const result = await runDailyBatchSync()

  const refusals = refusalFor(result.errors, 'SO-neg')
  assert.equal(refusals.length, 1, `the order is refused, and the refusal says why: ${JSON.stringify(result.errors)}`)
  assert.match(refusals[0], /neg/, 'naming the shipment')
  assert.match(refusals[0], /cl-neg/, 'and the cost layer whose basis is negative')
  assert.match(refusals[0], /-6\.00/, 'and the COGS it would have posted')
  assert.equal(stamped('neg'), false, 'the shipment is NOT stamped journaled, so a corrected basis flows through the next batch')
  assert.deepEqual(cogsMovements, [], 'and no COGS subledger dispatch is recorded for a posting that did not happen')
  assert.equal(result.groupB, 0, 'nothing was journaled')
  assert.deepEqual(groupB(), [], 'and no Group B journal was written for it — least of all a revenue-only one')
})

test('o3d-sidy: a refused order does not hold up the rest of the batch, and the COGS posted is the healthy orders\' exactly', async () => {
  reset([
    shipment('ok', [{ costLayerId: 'cl-ok', qty: '2.000000', unitCostBase: '20.000000' }], { qty: 2, cogsBatchAmount: 40, revenue: 100 }),
    // Posted beside the healthy one, this -6.00 would have been NETTED into the batch total (34.00)
    // rather than dropped — silently understating COGS instead of silently omitting it.
    shipment('neg', [{ costLayerId: 'cl-neg', qty: '1.000000', unitCostBase: '-6.000000' }], { cogsBatchAmount: -6 }),
  ])

  const result = await runDailyBatchSync()

  assert.equal(refusalFor(result.errors, 'SO-neg').length, 1, 'the negative-basis order is refused')
  assert.equal(stamped('ok'), true, 'the healthy order is journaled')
  assert.equal(stamped('neg'), false, 'the refused one is not')
  const [journal] = groupB()
  assert.ok(journal, 'the batch journal was written for the healthy order')
  const cogsDebit = linesOf(journal).find((l) => l.accountCode === '310')
  assert.equal(cogsDebit?.debit, 40, 'COGS is the healthy order\'s 40.00 — not 34.00 netted, not dropped')
  assert.equal(linesOf(journal).find((l) => l.accountCode === '631')?.credit, 40)
})

test('o3d-sidy: a negative entry is refused even when the shipment\'s total is still positive', async () => {
  // One layer at +10.00 and one at -6.00: the shipment totals +4.00, which the old code would have
  // posted without comment. A negative basis is the thing IMS does not represent (o3d-gd2f); #683
  // refuses it per unit cost, not per total, and so does this.
  reset([shipment('mixed', [
    { costLayerId: 'cl-pos', qty: '1.000000', unitCostBase: '10.000000' },
    { costLayerId: 'cl-neg', qty: '1.000000', unitCostBase: '-6.000000' },
  ], { qty: 2, cogsBatchAmount: 4 })])

  const result = await runDailyBatchSync()

  const refusals = refusalFor(result.errors, 'SO-mixed')
  assert.equal(refusals.length, 1, `refused: ${JSON.stringify(result.errors)}`)
  assert.match(refusals[0], /cl-neg/, 'naming the negative layer')
  assert.doesNotMatch(refusals[0], /cl-pos/, 'and only the negative one')
  assert.equal(stamped('mixed'), false)
})

test('o3d-sidy: the LEGACY allocation-consumption path refuses a negative basis too', async () => {
  // No snapshot on the shipment line and no positive cogsBatchAmount, so Group B consumes the
  // ALLOCATION's snapshot — which updateSnapshotsForCostLayerChange rewrites in place as well.
  const ship = shipment('legacy', null, { cogsBatchAmount: null })
  reset([ship], [{
    id: 'alloc-legacy',
    orderId: ship.orderId,
    lineId: 'line-legacy',
    productId: 'prod-1',
    warehouseId: 'wh-1',
    costLayerSnapshot: [{ costLayerId: 'cl-legacy-neg', qty: '1.000000', unitCostBase: '-6.000000' }],
  }])

  const result = await runDailyBatchSync()

  const refusals = refusalFor(result.errors, 'SO-legacy')
  assert.equal(refusals.length, 1, `refused: ${JSON.stringify(result.errors)}`)
  assert.match(refusals[0], /cl-legacy-neg/)
  assert.equal(stamped('legacy'), false)
  assert.deepEqual(groupB(), [])
})

test('o3d-sidy: a ZERO basis is not a negative one — it is journaled, with no COGS line because there is nothing to post', async () => {
  // Guards against over-refusal: free goods have zero COGS, which is correct, and the only thing the
  // `> 0` gate ever legitimately drops.
  reset([shipment('free', [{ costLayerId: 'cl-free', qty: '1.000000', unitCostBase: '0.000000' }], { cogsBatchAmount: 0 })])

  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors.filter((e) => /negative/i.test(e)), [], 'no refusal')
  assert.equal(stamped('free'), true, 'journaled')
  const [journal] = groupB()
  assert.ok(journal, 'with its revenue pair')
  assert.equal(linesOf(journal).some((l) => l.accountCode === '310'), false, 'and no COGS pair, because the COGS is zero')
})

test('o3d-sidy L1: the refusal survives the status-reason cap — it is FIRST in the errors, and an ERROR activity entry names the order', async () => {
  // An ordinary per-order failure is raised BEFORE the refusal in this run: an order whose shipment has
  // one line with a snapshot and one without. CronRun.statusReason keeps 500 characters of the joined
  // errors, so a refusal left behind other messages could be cut off before it names anything.
  const incomplete = shipment('inc', [{ costLayerId: 'cl-inc', qty: '1.000000', unitCostBase: '5.000000' }], { cogsBatchAmount: 5 })
  ;(incomplete.lines as Array<Record<string, unknown>>).push({
    id: 'sl-inc-2', lineId: 'line-inc', productId: 'prod-1', qty: 1, costLayerSnapshot: null,
    line: { id: 'line-inc', productId: 'prod-1', qty: 1, totalBase: 10 },
  })
  reset([incomplete, shipment('neg', [{ costLayerId: 'cl-neg', qty: '1.000000', unitCostBase: '-6.000000' }], { cogsBatchAmount: -6 })])

  const result = await runDailyBatchSync()

  assert.ok(result.errors.some((e) => e.startsWith('Group B order SO-inc:') && /Incomplete precomputed FIFO snapshots/.test(e)),
    `PRECONDITION: the ordinary failure really was raised in this run: ${JSON.stringify(result.errors)}`)
  assert.equal(refusalFor(result.errors, 'SO-neg').length, 1)
  assert.equal(result.errors[0], refusalFor(result.errors, 'SO-neg')[0], 'the refusal comes first')

  const logged = activity.filter((entry) => entry.action === 'daily_batch_negative_cost_basis_refused')
  assert.equal(logged.length, 1, 'one activity entry for the one refusal — none for the ordinary failure')
  assert.equal(logged[0].level, 'ERROR')
  assert.equal(logged[0].entityType, 'SALES_ORDER')
  assert.equal(logged[0].entityId, 'order-neg')
  assert.equal(logged[0].description, result.errors[0], 'carrying the same text the run reports')
  const detail = logged[0].metadata as { group: string; shipmentId: string; negativeEntries: Array<{ costLayerId: string }> }
  assert.equal(detail.group, 'B')
  assert.equal(detail.shipmentId, 'neg')
  assert.deepEqual(detail.negativeEntries.map((entry) => entry.costLayerId), ['cl-neg'])
})
