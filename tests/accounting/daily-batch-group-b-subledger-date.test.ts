import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-0qoo r1 (Codex adversarial review) — the LIVE Group B writer.
//
// runDailyBatchSync captures the batch date ONCE at run start (`today`) and posts the
// Group B GL journal under it. The per-shipment stage stamp is written much later, with
// its own `new Date()`, so a run that crosses UTC midnight stamps rows on day D+1 while
// its journal sits on day D.
//
// recordCogsSubledgerMovement used to be handed that stamp. The COGS subledger row for a
// dispatch then landed a day AFTER the GL journal whose value it records — and because the
// movement is a first-write-wins upsert keyed `dispatch:<shipmentId>`, no later run can
// ever correct it, while the COGS reconciliation windows on journalDate and reads the gap
// as a real one.
//
// This test drives the real runDailyBatchSync with a clock that crosses midnight between
// run start and the stamping loop, and asserts the subledger row is dated on the BATCH's
// date. The stamp assertion is there so the test cannot pass vacuously: it proves the two
// dates genuinely differ in this run.

const BATCH_DAY = '2026-07-20'
const STAMP_DAY = '2026-07-21'

const RealDate = Date
let nowMs = RealDate.parse(`${BATCH_DAY}T23:59:30.000Z`)

class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else super(...(args as [any]))
  }
  static now(): number {
    return nowMs
  }
}
// The clock is global for this file; every test in it wants the same crossing.
globalThis.Date = FakeDate as DateConstructor

/** Everything the run wrote, in the order it wrote it. */
const created: Array<{ type: string; referenceId: string; payload: Record<string, unknown> }> = []
const cogsMovements: Array<{ sourceRef: string; journalDate: unknown; baseDelta: unknown }> = []
const shipmentUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
/** Flipped by the Group B shipment query — the point past which the run is "after midnight". */
let crossedMidnight = false

const SHIPMENT = {
  id: 'ship-1',
  orderId: 'order-1',
  warehouseId: 'wh-1',
  createdAt: new RealDate(`${BATCH_DAY}T08:00:00.000Z`),
  cogsBatchAmount: 40,
  lines: [
    {
      id: 'sl-1',
      lineId: 'line-1',
      productId: 'prod-1',
      qty: 2,
      // Pre-computed FIFO snapshot → COGS 2 x 20.00 = 40.00, no cost-layer consumption.
      costLayerSnapshot: [{ costLayerId: 'cl-1', qty: '2.000000', unitCostBase: '20.000000' }],
      line: { id: 'line-1', productId: 'prod-1', qty: 2, totalBase: 100 },
    },
  ],
  order: {
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'PICKING',
    refundStatus: 'NONE',
    totalBase: 100,
    unearnedRevenueAmount: 100,
    lines: [{ id: 'line-1', productId: 'prod-1', qty: 2, totalBase: 100 }],
    shipments: [{ id: 'ship-1', status: 'SHIPPED', shipmentJournalDate: null, revenueRecognizedAmount: null }],
  },
}

const tx = {
  shipment: {
    findMany: async () => {
      // The run has already captured `today`; from here on it is the next UTC day. This is
      // the midnight crossing, expressed where the real one happens: between run start and
      // the per-row stamps.
      nowMs = RealDate.parse(`${STAMP_DAY}T00:00:20.000Z`)
      crossedMidnight = true
      return [SHIPMENT]
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      shipmentUpdates.push({ id: where.id, data })
      return { id: where.id }
    },
  },
  orderAllocation: { findMany: async () => [], update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefundLine: { findMany: async () => [] },
  salesOrderRefund: { findMany: async () => [] },
  salesOrder: { findMany: async () => [], update: async () => ({}) },
  costLayer: { update: async () => ({}) },
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
      // Group A1 / A2 windows and the recreate sweep all come back empty: this run is
      // about Group B only.
      salesOrder: { findMany: async () => [] },
      shipment: { findMany: async () => [] },
      accountingSyncLog: { count: async () => 0 },
      // o3d-19gy: each queued payload records the connection it was composed against, so the double
      // needs one — see daily-sync.ts createPendingSyncLog.
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-A' }) },
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

// The product graph needs a database; the requirement expansion is the identity here
// (one unit of prod-1 per unit of line-1), which is what makes the shipment fully cover
// its order line.
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => new Map([[productId, 1]]),
  },
})

// The post-batch rounding sweeps read GL/subledger snapshots out of the database and are
// not what this test is about; give them nothing to sweep.
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
  namedExports: {
    recordCogsSubledgerMovement: async (
      _client: unknown,
      args: { sourceRef: string; journalDate: unknown; baseDelta: unknown },
    ) => {
      cogsMovements.push({ sourceRef: args.sourceRef, journalDate: args.journalDate, baseDelta: args.baseDelta })
    },
  },
})

test('Xero live Group B dates the DISPATCH subledger row on the BATCH date, not the midnight-crossed stamp (o3d-0qoo r1)', async () => {
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [], 'the run must actually complete, not be asserted on after failing')
  assert.equal(result.groupB, 1, 'one shipment journaled')
  assert.ok(crossedMidnight, 'the Group B query must have run — otherwise nothing below is exercised')

  // The GL journal is posted under the batch's own date.
  const journal = created.find((log) => log.type === 'DAILY_BATCH_GROUP_B')
  assert.ok(journal, 'Group B journal was posted')
  assert.equal(journal.payload.date, BATCH_DAY)
  assert.equal(journal.referenceId.slice(0, `B-${BATCH_DAY}`.length), `B-${BATCH_DAY}`)

  // The stage stamp genuinely landed on the NEXT day — this is what makes the assertion
  // below meaningful rather than a restatement of a fixture.
  assert.equal(shipmentUpdates.length, 1)
  const stamp = shipmentUpdates[0].data.shipmentJournalDate as Date
  assert.equal(
    new RealDate(stamp.getTime()).toISOString().slice(0, 10),
    STAMP_DAY,
    'the run must really have crossed UTC midnight before stamping',
  )
  assert.notEqual(stamp.toISOString().slice(0, 10), journal.payload.date)

  // The subledger row belongs to the journal, so it carries the journal's date.
  assert.deepEqual(cogsMovements, [{ sourceRef: 'ship-1', journalDate: BATCH_DAY, baseDelta: 40 }])
})

test('o3d-o97 r3: Group B records the CR Allocated Inventory it raised, in the SAME update as the stamp', async () => {
  // The refund path's residue arithmetic needs to know how much of an order's A2 allocated-
  // inventory debit Group B has already credited back. It used to re-derive that from the
  // CogsEntry dispatch rows — which `retention_stock_movements_months` HARD-DELETES — so the
  // relief silently became "whatever the layers are worth today", or zero.
  //
  // Group B knows the figure at the moment it posts: its CR Allocated Inventory line is exactly
  // this shipment's dispatch COGS. Recording it beside the journal stamp is what makes it
  // durable — retention deletes stock movements and sync logs, not shipments — and it must be
  // the SAME UPDATE, so a crash can never leave a journaled shipment with no recorded relief.
  //
  // Deliberately NOT `cogsBatchAmount`, which is in the same update but is REWRITTEN IN PLACE by
  // every later landed-cost correction (refreshShipmentCogsForCostLayerChange) while a
  // revaluation posts to COGS/Inventory and never to Allocated Inventory.
  assert.equal(shipmentUpdates.length, 1, 'the run above is what wrote this; no second run')
  const data = shipmentUpdates[0].data
  assert.equal(data.allocatedReliefAmount, 40, 'the £40 of dispatch COGS the journal credited Allocated Inventory')
  assert.equal(data.cogsBatchAmount, 40, 'equal TODAY — which is exactly why one of them has to be the immutable one')
  assert.ok('shipmentJournalDate' in data, 'written in the same UPDATE as the journal stamp')
  const journal = created.find((log) => log.type === 'DAILY_BATCH_GROUP_B')
  const allocatedCredit = (journal?.payload.lines as Array<{ accountCode?: string; credit?: number }>)
    .find((line) => line.accountCode === '631' && line.credit != null)
  assert.equal(allocatedCredit?.credit, 40, 'and it is the figure the journal actually credited')
})
