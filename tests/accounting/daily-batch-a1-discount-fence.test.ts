import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-y14 r2 finding 1 — the DAILY BATCH is a producer of a discount-derived accounting snapshot,
 * and the invoice fence never reached it.
 *
 * Group A1 reads `SalesOrder.discountAmount` for every eligible order with NO transaction and NO
 * lock, derives `subtotal + shipping − discount`, and then — in a transaction opened afterwards —
 * persists that figure TWICE: into a PENDING `DAILY_BATCH_REVENUE_DEFERRAL` payload a worker posts
 * as a GL journal, and into `SalesOrder.unearnedRevenueAmount`, which revenue recognition and the
 * refund service later treat as authoritative. The o3d-y14 backfill can commit its correction in
 * between, having truthfully counted zero live invoice jobs AND zero live batch rows, because A1
 * has not inserted one yet.
 *
 * This file drives the REAL `runDailyBatchSync` for BOTH connectors. `db.salesOrder.findMany` (the
 * unlocked A1 window) returns the PRE-correction row; the fence's re-read inside the transaction
 * returns the POST-correction row. That is the interleaving, expressed exactly where it happens.
 *
 * It is deliberately a WIRING test as well as a behaviour one: the fence living in
 * daily-batch-discount-fence.ts proves nothing unless both connectors call it, and a unit test of
 * the helper alone would have passed throughout the whole period this defect existed.
 */

// ---------------------------------------------------------------------------
// The world. `discountAmount` is what the BACKFILL rewrites; `staged` is what the batch wrote.
// ---------------------------------------------------------------------------

const ORDER_ID = 'order-1'

const world = {
  /** What the unlocked A1 window reads. */
  snapshotDiscount: 10,
  /** What the row says once the fence re-reads it under the lock. */
  liveDiscount: 10,
  created: [] as Array<{ type: string; referenceId: string; payload: Record<string, unknown> }>,
  orderUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  activity: [] as Array<{ action: string; level?: string; metadata?: Record<string, unknown> }>,
  lockedIds: [] as string[],
  /** The raw statements the transaction issued, so "it locked" is checked rather than assumed. */
  rawStatements: [] as string[],
  fenceRead: 0,
}

function reset(over: { snapshotDiscount?: number; liveDiscount?: number } = {}) {
  world.snapshotDiscount = over.snapshotDiscount ?? 10
  world.liveDiscount = over.liveDiscount ?? world.snapshotDiscount
  world.created = []
  world.orderUpdates = []
  world.activity = []
  world.lockedIds = []
  world.rawStatements = []
  world.fenceRead = 0
}

/** The A1 select shape, with whichever discount the caller is entitled to see. */
function orderRow(discount: number) {
  return {
    id: ORDER_ID,
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    fxRateToBase: 1,
    subtotalBase: 100,
    shippingBase: 0,
    discountAmount: discount,
    pricesIncludeVat: false,
    taxRatePercent: 0,
    shoppingLinks: [{ connector: 'woocommerce' }],
    lines: [{ totalBase: 100, taxRate: { rate: 0 } }],
  }
}

/** Is this the Group A1 window? A1 asks for orders NOT yet deferred; everything else is not A1. */
function isA1Window(where: Record<string, unknown> | undefined): boolean {
  return !!where && where.revenueDeferredDate === null && !!where.paidAt
}

const tx = {
  $queryRaw: async (...args: unknown[]) => {
    // The fence's bulk `SELECT … FOR UPDATE`. The STATEMENT is recorded, not merely the fact that
    // some raw query happened: re-reading without locking leaves the backfill free to commit its
    // correction after the comparison, which is the whole interleaving this fence exists to close,
    // and a double that just counted calls would report that as locked.
    const statement = (args[0] as { strings?: string[]; sql?: string; text?: string } | undefined) ?? {}
    world.rawStatements.push(statement.sql ?? statement.text ?? (statement.strings ?? []).join('?'))
    world.lockedIds.push(ORDER_ID)
    return []
  },
  salesOrder: {
    // The fence's re-read: the LIVE row, i.e. after any correction that committed in the gap.
    //
    // It MUST discriminate on the where. When this double was written, Group A2 selected its
    // candidates through `db`, so an unconditional answer here could only ever be the A1 fence's
    // re-read. o3d-o97 / o3d-0i5y moved A2's candidate read and its locked re-read INSIDE the
    // transaction, and an unconditional answer then handed A2 an A1-shaped row with no `shipments`
    // and no `allocations` — reported as "Group A2 error: order.shipments is not iterable", which
    // looks like a Group B problem and is really this double.
    //
    // The fence re-reads by ID ALONE (`{ id: { in: batch } }` — see assertRevenueDeferralsUnchanged);
    // every other in-transaction reader carries eligibility clauses as well. So an `id`-only where is
    // the fence and nothing else is, which keeps this file's promise that ONLY the A1 window is
    // populated now that more than one group reads through `tx`.
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const clauses = Object.keys(where ?? {})
      if (clauses.length !== 1 || clauses[0] !== 'id') return []
      world.fenceRead += 1
      return [orderRow(world.liveDiscount)]
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      world.orderUpdates.push({ id: where.id, data })
      return { id: where.id }
    },
  },
  accountingSyncLog: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: { type: string; referenceId: string; payload: Record<string, unknown> } }) => {
      world.created.push({ type: data.type, referenceId: data.referenceId, payload: data.payload })
      return { id: `log-${world.created.length}` }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
  shipment: { findMany: async () => [], update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  orderAllocation: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefund: { findMany: async () => [] },
  salesOrderRefundLine: { findMany: async () => [] },
  costLayer: { update: async () => ({}) },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      salesOrder: {
        findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
          // ONLY the A1 window is populated: A2, Group B and the recreate sweep are other groups,
          // and giving them rows would make a failure ambiguous about which group produced it.
          isA1Window(where) ? [orderRow(world.snapshotDiscount)] : [],
      },
      shipment: { findMany: async () => [] },
      accountingSyncLog: { count: async () => 0, findMany: async () => [] },
      // o3d-s36z (#632): the enqueue now stamps the connection the payload was composed against,
      // read through activeAccountingIdProvenance -> db.accountingToken.findUnique. CONNECTED, not
      // null: a null models a DISCONNECTED instance, and this file's control case is a normal batch
      // run on a live connection.
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
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (data: { action: string; level?: string; metadata?: Record<string, unknown> }) => {
      world.activity.push(data)
    },
  },
})
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

const CONNECTORS = [
  { name: 'xero', load: () => import('@/lib/connectors/xero/daily-sync') },
  { name: 'quickbooks', load: () => import('@/lib/connectors/quickbooks/daily-sync') },
] as const

for (const connector of CONNECTORS) {
  test(`${connector.name} Group A1 stages the deferral when the order has NOT moved (o3d-y14 r2 F1 control)`, async () => {
    // The control. Without it, "the fence refuses" is indistinguishable from "the batch never
    // stages anything", and a fence that threw unconditionally would pass the test below.
    const { runDailyBatchSync } = await connector.load()
    reset({ snapshotDiscount: 10 })

    const result = await runDailyBatchSync()

    assert.deepEqual(result.errors, [], 'the run completes')
    assert.equal(result.groupA1, 1)
    assert.equal(world.fenceRead, 1, 'the fence re-read the row — it is wired in, not dead code')
    assert.deepEqual(world.lockedIds, [ORDER_ID], 'and it locked the member rows before re-reading')
    assert.equal(world.rawStatements.length, 1, 'exactly one lock statement — the members are taken in one shot')
    assert.match(
      world.rawStatements[0] ?? '',
      /FOR UPDATE/,
      'and it is a LOCK, not a plain re-read: without it the backfill can still commit afterwards',
    )
    assert.match(world.rawStatements[0] ?? '', /sales_orders/, 'on the rows the backfill locks')
    assert.match(
      world.rawStatements[0] ?? '',
      /ORDER BY id/,
      'ordered by id, so two connectors\' batches cannot deadlock against each other',
    )

    const journal = world.created.find((log) => log.type === 'DAILY_BATCH_REVENUE_DEFERRAL')
    assert.ok(journal, 'the deferral journal is staged')
    assert.deepEqual(journal.payload.orderDeferrals, [{ orderId: ORDER_ID, amount: 90 }], '100 − 10')
    assert.equal(world.orderUpdates[0]?.data.unearnedRevenueAmount, 90, 'and the stamp agrees with it')
  })

  test(`${connector.name} Group A1 REFUSES to stage a deferral built from a superseded discount (o3d-y14 r2 F1)`, async () => {
    // The backfill corrected 10 → 0 after the unlocked A1 read and before the batch transaction.
    // Unfenced, this run stages a journal deferring 90 and stamps unearnedRevenueAmount = 90 on an
    // order whose own discount is 0 — a figure the order contradicts, in a document a worker posts.
    const { runDailyBatchSync } = await connector.load()
    reset({ snapshotDiscount: 10, liveDiscount: 0 })

    const result = await runDailyBatchSync()

    assert.equal(world.fenceRead, 1, 'the fence ran')
    assert.equal(
      world.created.filter((log) => log.type === 'DAILY_BATCH_REVENUE_DEFERRAL').length,
      0,
      'NOTHING was staged — the whole group is refused, not silently recomputed',
    )
    assert.deepEqual(world.orderUpdates, [], 'and no order was stamped, so the next run re-derives them')
    assert.equal(result.groupA1, 0)
    assert.ok(
      result.errors.some((error) => error.includes('Group A1') && error.includes('StaleDailyBatchDeferralError')),
      `the refusal is reported on the run result, got: ${JSON.stringify(result.errors)}`,
    )

    const refusal = world.activity.find(
      (entry) => entry.action === 'accounting_daily_batch_stale_order_discount',
    )
    assert.ok(refusal, 'and logged OUTSIDE the rolled-back transaction — a refused batch otherwise looks like a quiet day')
    assert.equal(refusal?.level, 'ERROR')
    assert.equal(refusal?.metadata?.connector, connector.name)
    assert.deepEqual(refusal?.metadata?.stale, [{ orderId: ORDER_ID, batchAmount: 90, liveAmount: 100 }])
  })

  test(`${connector.name} Group A1 refuses when a member order was DELETED in the gap (o3d-y14 r2 F1)`, async () => {
    // Same producer, different disappearance: staging a deferral for an order that no longer exists
    // is the o3d-hrak defect wearing the batch's clothes.
    const { runDailyBatchSync } = await connector.load()
    reset({ snapshotDiscount: 10 })
    const originalFindMany = tx.salesOrder.findMany
    tx.salesOrder.findMany = async () => {
      world.fenceRead += 1
      return []
    }
    try {
      const result = await runDailyBatchSync()

      assert.equal(world.created.length, 0, 'nothing staged')
      assert.deepEqual(world.orderUpdates, [])
      assert.ok(result.errors.some((error) => error.includes('StaleDailyBatchDeferralError')))
    } finally {
      tx.salesOrder.findMany = originalFindMany
    }
  })
}
