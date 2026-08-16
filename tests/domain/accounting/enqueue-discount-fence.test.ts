import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-y14, Codex round 1 finding 1. THE ORDER LOCK SERIALISES QUEUE INSERTION, NOT PAYLOAD
 * CONSTRUCTION.
 *
 * The coupon backfill's safety argument was: take the sales-order row lock — the same one every
 * accounting enqueue takes — count the live SALES_INVOICE rows under it, and if there are none then
 * no worker can still post a payload built from the pre-correction amount. The count is true. The
 * conclusion is not, because `queueSalesInvoiceForOrder` READS `SalesOrder.discountAmount` and
 * builds the ENTIRE payload before calling the queue helper, and only the helper takes the lock:
 *
 *      producer                          backfill
 *      --------                          --------
 *      read discountAmount = 10
 *      build payload { discount: 10 }
 *                                        LOCK order
 *                                        count live invoice rows -> 0   (true! none exists yet)
 *                                        write discountAmount = 0, stamp as corrected
 *                                        COMMIT / release
 *      LOCK order  (was blocked here)
 *      insert payload { discount: 10 }
 *      -> a worker posts 10 against an order that says 0 and is marked fixed.
 *
 * THE PREVIOUS TEST COULD NOT SEE THIS. Its lock double recorded call order and returned; it had no
 * waiting, so it could not host a producer that snapshots first and blocks second. The doubles here
 * are built for exactly that: `lockSalesOrder` is a REAL FIFO mutex whose second acquirer does not
 * proceed until the first transaction ends, and the interleaving is asserted as an event sequence so
 * a mutex that stopped blocking would fail the test rather than quietly linearise it.
 *
 * The fix under test: inside the SAME locked transaction, the enqueue re-reads the order and refuses
 * a payload whose order-level discount disagrees with it. Nothing is queued and the refusal is
 * logged at ERROR — a missing invoice is recoverable by re-queueing; a posted one that contradicts
 * its order is not.
 */

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

type SyncLogRow = { id: string; type: string; referenceType: string; referenceId: string; payload: Record<string, unknown> }

const world = {
  orders: [{ id: 'order-1', discountAmount: 10, discountModel: null as string | null, lines: [{ discountAmount: 10 }] }],
  syncLogs: [] as SyncLogRow[],
  activity: [] as Array<{ action: string; level?: string; metadata?: Record<string, unknown> }>,
  events: [] as string[],
}

function resetWorld() {
  world.orders = [{ id: 'order-1', discountAmount: 10, discountModel: null, lines: [{ discountAmount: 10 }] }]
  world.syncLogs = []
  world.activity = []
  world.events = []
}

/** Let queued microtasks run, so a blocked acquirer really is parked on the mutex. */
async function settle(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// A REAL FIFO mutex, per order id — the part the old double did not have
// ---------------------------------------------------------------------------

const holders = new Map<string, unknown>()
const waiters = new Map<string, Array<() => void>>()
const txLocks = new WeakMap<object, Set<string>>()

async function acquire(tx: object, orderId: string) {
  if (holders.has(orderId) && holders.get(orderId) !== tx) {
    await new Promise<void>((resolve) => {
      waiters.set(orderId, [...(waiters.get(orderId) ?? []), resolve])
    })
  }
  holders.set(orderId, tx)
  const owned = txLocks.get(tx) ?? new Set<string>()
  owned.add(orderId)
  txLocks.set(tx, owned)
}

function releaseAll(tx: object) {
  for (const orderId of txLocks.get(tx) ?? []) {
    holders.delete(orderId)
    const queue = waiters.get(orderId) ?? []
    const next = queue.shift()
    waiters.set(orderId, queue)
    next?.()
  }
  txLocks.delete(tx)
}

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async (tx: object, orderId: string) => {
      await acquire(tx, orderId)
    },
    hasLockedSalesOrder: () => true,
  },
})

// ---------------------------------------------------------------------------
// A transaction that honours its predicates
// ---------------------------------------------------------------------------

function makeTx(hooks: { onCount?: () => Promise<void> | void } = {}) {
  const tx: Record<string, unknown> = {}
  Object.assign(tx, {
    salesOrder: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const found = world.orders.find((order) => order.id === where.id)
        if (!found) return null
        return {
          id: found.id,
          discountAmount: found.discountAmount,
          discountModel: found.discountModel,
          ...(select?.lines ? { lines: found.lines.map((line) => ({ ...line })) } : {}),
          ...(select?.shoppingLinks ? { shoppingLinks: [{ createdAt: new Date('2026-05-01T00:00:00.000Z') }] } : {}),
        }
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, number | string> }) => {
        const target = world.orders.find(
          (order) =>
            order.id === where.id &&
            (!('discountAmount' in where) || order.discountAmount === where.discountAmount) &&
            (!('discountModel' in where) || order.discountModel === where.discountModel),
        )
        if (!target) return { count: 0 }
        if (typeof data.discountAmount === 'number') target.discountAmount = data.discountAmount
        if (typeof data.discountModel === 'string') target.discountModel = data.discountModel
        world.events.push('backfill:write')
        return { count: 1 }
      },
    },
    accountingSyncLog: {
      count: async ({ where }: { where: { referenceId: string; status: { in: string[] }; type: { in: string[] } } }) => {
        await hooks.onCount?.()
        return world.syncLogs.filter(
          (log) => log.referenceId === where.referenceId && where.type.in.includes(log.type),
        ).length
      },
      create: async ({ data }: { data: SyncLogRow }) => {
        world.events.push('producer:inserted')
        const row = { ...data, id: `log-${world.syncLogs.length + 1}` }
        world.syncLogs.push(row)
        return row
      },
    },
    activityLog: {
      create: async ({ data }: { data: { action: string } }) => {
        world.activity.push(data)
        return data
      },
    },
    shipment: { findUnique: async () => null },
  })
  return tx
}

async function runTx<T>(fn: (tx: never) => Promise<T>, hooks?: { onCount?: () => Promise<void> | void }): Promise<T> {
  const tx = makeTx(hooks)
  try {
    return await fn(tx as never)
  } finally {
    releaseAll(tx)
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: never) => Promise<unknown>) => runTx(fn),
      accountingSyncLog: { findFirst: async () => null },
    },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (data: { action: string; level?: string; metadata?: Record<string, unknown> }) => {
      world.activity.push(data)
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { mirrorAccountingSyncLogToEvent: async () => {} },
})
mock.module('@/lib/connectors/xero/outbox', { namedExports: { scheduleXeroAccountingOutbox: async () => {} } })
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: 'true',
      xero_sync_sales_invoice: 'submitted',
      xero_sync_cogs_journal: 'submitted',
    }),
  },
})
mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: {
    getQuickBooksSettings: async () => ({
      quickbooks_sync_enabled: 'true',
      quickbooks_sync_sales_invoice: 'submitted',
    }),
  },
})

const ENTRY = {
  orderId: 'order-1',
  orderNumber: 'WC-1001',
  externalOrderNumber: '1001',
  currency: 'GBP',
  storedOrderDiscount: 10,
  lineDiscountTotal: 10,
  importedAt: '2026-05-01T00:00:00.000Z',
  keptOrderLevel: 0,
  clearedBy: 10,
  partial: false,
  accountingInvoiceId: null,
  nearCutoff: false,
}

// ---------------------------------------------------------------------------

test('a producer that SNAPSHOTTED before blocking on the lock cannot queue the stale figure (Codex r1 F1)', async () => {
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  const { applyWcCouponCorrection } = await import('@/lib/connectors/woocommerce/sync/coupon-discount-backfill')
  const { STALE_ORDER_DISCOUNT_ENQUEUE_ACTION } = await import('@/lib/domain/accounting/enqueue-order-guard')
  resetWorld()

  // The producer reads the order and builds its payload BEFORE anything takes the lock — the shape
  // of queueSalesInvoiceForOrder, which selects discountAmount and constructs the whole payload
  // before calling the queue helper.
  const snapshot = world.orders[0].discountAmount
  assert.equal(snapshot, 10)
  let producer: Promise<void> | null = null

  const result = await runTx(
    (tx) => applyWcCouponCorrection(tx, ENTRY),
    {
      // Called under the backfill's lock, before its write. The producer starts here and blocks.
      onCount: async () => {
        world.events.push('backfill:lock')
        producer = (async () => {
          world.events.push('producer:start')
          await queueXeroSync({
            type: 'SALES_INVOICE',
            referenceType: 'SalesOrder',
            referenceId: 'order-1',
            payload: { invoiceNumber: 'INV-1', discountAmount: snapshot },
          })
          world.events.push('producer:done')
        })()
        await settle()
        assert.ok(
          !world.events.includes('producer:inserted'),
          'the producer must be PARKED on the lock here — if it inserted, the mutex is not a mutex ' +
            'and this test proves nothing',
        )
      },
    },
  )

  assert.deepEqual(result, { outcome: 'CORRECTED' })
  await producer!

  assert.equal(world.orders[0].discountAmount, 0, 'the backfill corrected the order')
  assert.equal(world.syncLogs.length, 0, 'and NO invoice job carrying the superseded 10 was queued')
  assert.deepEqual(
    world.events,
    ['backfill:lock', 'producer:start', 'backfill:write', 'producer:done'],
    'the producer really did run second, after the lock was released — the interleaving under test',
  )

  const refusal = world.activity.find((entry) => entry.action === STALE_ORDER_DISCOUNT_ENQUEUE_ACTION)
  assert.ok(refusal, 'the refusal is LOUD: nothing was queued, so an operator has to re-trigger it')
  assert.equal(refusal?.level, 'ERROR')
  assert.equal(refusal?.metadata?.payloadDiscount, 10)
  assert.equal(refusal?.metadata?.liveDiscount, 0)
})

test('the same producer, with nothing correcting the order, queues normally (Codex r1 F1)', async () => {
  // The control. Without it, a fence that refused EVERY sales invoice would pass the test above.
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  resetWorld()

  await queueXeroSync({
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { invoiceNumber: 'INV-1', discountAmount: 10 },
  })

  assert.equal(world.syncLogs.length, 1, 'a payload that agrees with the order is queued')
  assert.equal(world.activity.length, 0, 'and nothing is reported')
})

test('an order with NO discount and a payload that omits the field is queued (Codex r1 F1)', async () => {
  // `discountAmount` is omitted rather than sent as 0 when there is no discount, so absent must mean
  // zero — otherwise the fence would block every ordinary invoice.
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  resetWorld()
  world.orders[0].discountAmount = 0

  await queueXeroSync({
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { invoiceNumber: 'INV-1' },
  })

  assert.equal(world.syncLogs.length, 1)
})

test('a payload that omits the discount for an order that HAS one is refused (Codex r1 F1)', async () => {
  // The mirror image, and the one that matters after a correction runs the other way: absent means
  // zero, so an absent field against a live 6 is a disagreement, not a "no opinion".
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  resetWorld()
  world.orders[0].discountAmount = 6

  await queueXeroSync({
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { invoiceNumber: 'INV-1' },
  })

  assert.equal(world.syncLogs.length, 0)
  assert.equal(world.activity[0]?.metadata?.payloadDiscount, 0)
  assert.equal(world.activity[0]?.metadata?.liveDiscount, 6)
})

test('SALES_INVOICE_UPDATE is fenced too — it carries the same field (Codex r1 F1)', async () => {
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  resetWorld()

  await queueXeroSync({
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { invoiceNumber: 'INV-1', accountingInvoiceId: 'XERO-1', discountAmount: 4 },
  })

  assert.equal(world.syncLogs.length, 0, 'an update rewrites the posted document — same hazard')
})

test('an unrelated document type is NOT fenced by the order discount (Codex r1 F1)', async () => {
  // A COGS journal's `discountAmount` — if it had one — would mean something else entirely.
  // Fencing on a field this check does not understand would block legitimate documents.
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  resetWorld()

  await queueXeroSync({
    type: 'COGS_JOURNAL',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { discountAmount: 999 },
  })

  assert.equal(world.syncLogs.length, 1)
})

test('QuickBooks is fenced identically — the cross-port rule (Codex r1 F1)', async () => {
  const { queueQuickBooksSync } = await import('@/lib/connectors/quickbooks/queue')
  const { STALE_ORDER_DISCOUNT_ENQUEUE_ACTION } = await import('@/lib/domain/accounting/enqueue-order-guard')
  resetWorld()
  world.orders[0].discountAmount = 0

  await queueQuickBooksSync({
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { invoiceNumber: 'INV-1', discountAmount: 10 },
  })

  assert.equal(world.syncLogs.length, 0)
  assert.equal(world.activity[0]?.action, STALE_ORDER_DISCOUNT_ENQUEUE_ACTION)
  assert.equal(world.activity[0]?.metadata?.connector, 'quickbooks')
})

test('a non-numeric discount fails CLOSED rather than being read as zero (Codex r1 F1)', async () => {
  const { findStaleOrderLevelDiscount } = await import('@/lib/domain/accounting/enqueue-order-guard')
  resetWorld()

  const stale = await runTx(async (tx) =>
    findStaleOrderLevelDiscount(tx, {
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      orderId: 'order-1',
      payload: { discountAmount: 'ten' },
    }),
  )

  assert.ok(stale, 'a payload this check cannot read is refused, not waved through')
  assert.equal(stale?.liveDiscount, 10)
})

test('rounding matches the payload convention, so 2dp equality is not a false alarm', async () => {
  // Both builders round the order-level discount to 2dp; the column holds 4. Comparing raw values
  // would refuse ordinary invoices on the fourth decimal.
  const { findStaleOrderLevelDiscount } = await import('@/lib/domain/accounting/enqueue-order-guard')
  resetWorld()
  world.orders[0].discountAmount = 10.0049

  const stale = await runTx(async (tx) =>
    findStaleOrderLevelDiscount(tx, {
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      orderId: 'order-1',
      payload: { discountAmount: 10 },
    }),
  )

  assert.equal(stale, null)
})
