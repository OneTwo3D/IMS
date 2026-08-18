import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-y14 r2 finding 1, the half a wiring test cannot express: A DAILY-BATCH PRODUCER THAT
 * SNAPSHOTS FIRST AND BLOCKS SECOND.
 *
 *      daily batch (Group A1)                backfill
 *      ----------------------                --------
 *      read discountAmount = 10   (unlocked)
 *      derive deferral = 90
 *                                            LOCK order
 *                                            count live invoice rows  -> 0   (true)
 *                                            count live batch rows    -> 0   (TRUE: A1 has not
 *                                                                             inserted one yet)
 *                                            write discountAmount = 0, stamp as corrected
 *                                            COMMIT / release
 *      open transaction
 *      LOCK order   (was parked here)
 *      insert DAILY_BATCH_REVENUE_DEFERRAL { orderDeferrals: [90] }
 *      stamp unearnedRevenueAmount = 90
 *      -> a worker posts a GL journal deferring 90 for an order whose own discount says 100,
 *         and the order carries a stale unearned figure that revenue recognition and the refund
 *         service will both read as authoritative.
 *
 * Codex round 1 established that a lock double which merely records call order CANNOT host this
 * shape: with no waiting, the producer can never snapshot first and block second, so the
 * interleaving linearises away and the test proves nothing. The mutex below is therefore a REAL
 * FIFO mutex — held by whichever transaction took it until that transaction ends — and both
 * acquirers go through it: `lockSalesOrder` for the backfill, and the fence's bulk
 * `SELECT … FOR UPDATE` for the batch. The parking is asserted directly, so a mutex that stopped
 * blocking fails the test rather than quietly passing it.
 */

const ORDER_ID = 'order-1'

const world = {
  order: {
    id: ORDER_ID,
    discountAmount: 10,
    discountModel: null as string | null,
    accountingInvoiceId: null as string | null,
    revenueDeferredBatchRef: null as string | null,
    unearnedRevenueAmount: null as number | null,
    fxRateToBase: 1,
    subtotalBase: 100,
    shippingBase: 0,
    pricesIncludeVat: false,
    taxRatePercent: 0,
    shoppingLinks: [{ connector: 'woocommerce' }],
    lines: [{ discountAmount: 10, totalBase: 100, taxRate: { rate: 0 } }],
  },
  syncLogs: [] as Array<{ type: string; referenceId: string; payload: Record<string, unknown> }>,
  stamps: [] as Array<{ id: string; unearnedRevenueAmount: number }>,
  events: [] as string[],
}

function reset() {
  world.order.discountAmount = 10
  world.order.discountModel = null
  world.order.accountingInvoiceId = null
  world.order.revenueDeferredBatchRef = null
  world.order.unearnedRevenueAmount = null
  world.syncLogs = []
  world.stamps = []
  world.events = []
}

/** Let queued microtasks run, so a blocked acquirer really is parked on the mutex. */
async function settle(times = 5) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// A REAL FIFO mutex, per order id
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

function makeTx(hooks: { onBackfillCount?: () => Promise<void> | void } = {}) {
  const tx: Record<string, unknown> = {}
  Object.assign(tx, {
    // The fence's bulk lock. Routed through the SAME mutex the backfill takes, because the whole
    // claim under test is that the two serialise on one row.
    //
    // IT READS THE STATEMENT rather than assuming it. The previous revision acquired the mutex for
    // ANY raw query, which made "the fence locked the member rows" true of a statement with no
    // `FOR UPDATE` at all — so the interleaving below would have passed on a fence that took no
    // lock, which is precisely the defect this file exists to catch. Now only a `FOR UPDATE`
    // statement locks, and only over the ids it actually binds.
    $queryRaw: async (query: unknown) => {
      const statement = (query ?? {}) as { values?: unknown[] }
      const text = String((query as { text?: unknown } | null)?.text ?? '')
      const bound = (statement.values ?? []).flatMap((value) => (Array.isArray(value) ? value : [value]))
      if (!/FOR UPDATE/i.test(text)) return []
      for (const id of bound.filter((value): value is string => typeof value === 'string').sort()) {
        await acquire(tx, id)
      }
      return []
    },
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== ORDER_ID) return null
        return {
          id: world.order.id,
          discountAmount: world.order.discountAmount,
          discountModel: world.order.discountModel,
          accountingInvoiceId: world.order.accountingInvoiceId,
          revenueDeferredBatchRef: world.order.revenueDeferredBatchRef,
          unearnedRevenueAmount: world.order.unearnedRevenueAmount,
          // o3d-y14 r6 finding 1 — the refund position the correction reads under the same lock.
          refundStatus: 'NONE',
          refunds: [],
          lines: world.order.lines.map((line) => ({ discountAmount: line.discountAmount })),
          shoppingLinks: [{ createdAt: new Date('2026-05-01T00:00:00.000Z') }],
        }
      },
      // The fence's re-read, in the fence's own select shape.
      findMany: async () => [
        {
          id: world.order.id,
          fxRateToBase: world.order.fxRateToBase,
          subtotalBase: world.order.subtotalBase,
          shippingBase: world.order.shippingBase,
          discountAmount: world.order.discountAmount,
          pricesIncludeVat: world.order.pricesIncludeVat,
          taxRatePercent: world.order.taxRatePercent,
          shoppingLinks: world.order.shoppingLinks,
          lines: world.order.lines.map((line) => ({ totalBase: line.totalBase, taxRate: line.taxRate })),
        },
      ],
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (
          where.id !== ORDER_ID ||
          ('discountAmount' in where && world.order.discountAmount !== where.discountAmount) ||
          ('discountModel' in where && world.order.discountModel !== where.discountModel)
        ) {
          return { count: 0 }
        }
        if (typeof data.discountAmount === 'number') world.order.discountAmount = data.discountAmount
        if (typeof data.discountModel === 'string') world.order.discountModel = data.discountModel
        world.events.push('backfill:write')
        return { count: 1 }
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        world.stamps.push({ id: where.id, unearnedRevenueAmount: Number(data.unearnedRevenueAmount) })
        world.events.push('batch:stamped')
        return { id: where.id }
      },
    },
    accountingSyncLog: {
      count: async ({ where }: { where: { referenceId: string | { in: string[] } } }) => {
        // The backfill's two live-work counts. The hook fires on the first, i.e. under its lock and
        // before its write — the window the producer has to start in.
        if (typeof where.referenceId === 'string') await hooks.onBackfillCount?.()
        return 0
      },
      findMany: async () => [],
      create: async ({ data }: { data: { type: string; referenceId: string; payload: Record<string, unknown> } }) => {
        world.events.push('batch:inserted')
        world.syncLogs.push({ type: data.type, referenceId: data.referenceId, payload: data.payload })
        return { id: `log-${world.syncLogs.length}` }
      },
    },
    // The refund-park read (r7 F1). These tests are about the batch-producer race, not
    // about parks, so the honest answer is "this order has none" — but the double THROWS on
    // any predicate it was not taught, so a production query that changes shape surfaces
    // here instead of silently matching everything.
    shoppingSyncLog: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const taught = new Set(['connector', 'direction', 'entityType', 'status', 'entityId', 'externalId'])
        for (const key of Object.keys(where)) {
          if (!taught.has(key)) throw new Error(`shoppingSyncLog double was not taught the predicate ${key}`)
        }
        return []
      },
    },
    activityLog: { create: async () => ({ id: 'activity-1' }) },
  })
  return tx
}

async function runTx<T>(fn: (tx: never) => Promise<T>, hooks?: { onBackfillCount?: () => Promise<void> | void }) {
  const tx = makeTx(hooks)
  try {
    return await fn(tx as never)
  } finally {
    releaseAll(tx)
  }
}

const ENTRY = {
  orderId: ORDER_ID,
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
  postedInvoiceExternalIds: [] as string[],
  // o3d-y14 r6 finding 1: the refund position the reviewer saw, which apply compares against live
  // state before it will prescribe anything about this order's documents.
  refunds: { disposition: 'NONE' as const, refundIds: [] as string[], postedCreditNoteExternalIds: [] as string[], unresolvedRefundParkExternalIds: [] as string[] },
  revenueDeferredBatchRef: null,
  nearCutoff: false,
}

/**
 * The Group A1 producer, in the shape both connectors have: read UNLOCKED, derive, then open a
 * transaction that fences, stages the journal and stamps every member order.
 */
type Fence = typeof import('@/lib/domain/accounting/daily-batch-discount-fence')

async function runBatchProducer(fence: Fence): Promise<{ staged: boolean; error: string | null }> {
  // The module is passed in ALREADY LOADED, deliberately. An `await import(...)` here would put a
  // module-resolution await between "the producer starts" and "the producer reads the discount",
  // which is long enough for the backfill to commit first — and the interleaving under test is the
  // one where the producer reads FIRST.
  const { revenueDeferralAmount, assertRevenueDeferralsUnchanged, StaleDailyBatchDeferralError } = fence

  world.events.push('batch:start')
  // The UNLOCKED read, before any transaction exists — the defect's origin.
  const snapshot = revenueDeferralAmount({
    id: world.order.id,
    fxRateToBase: world.order.fxRateToBase,
    subtotalBase: world.order.subtotalBase,
    shippingBase: world.order.shippingBase,
    discountAmount: world.order.discountAmount,
    pricesIncludeVat: world.order.pricesIncludeVat,
    taxRatePercent: world.order.taxRatePercent,
    shoppingLinks: world.order.shoppingLinks,
    lines: world.order.lines.map((line) => ({ totalBase: line.totalBase, taxRate: line.taxRate })),
  })
  const deferrals = [{ orderId: ORDER_ID, amount: snapshot }]

  try {
    await runTx(async (tx) => {
      await assertRevenueDeferralsUnchanged(tx, deferrals)
      const client = tx as unknown as {
        accountingSyncLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> }
        salesOrder: { update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> }
      }
      await client.accountingSyncLog.create({
        data: {
          type: 'DAILY_BATCH_REVENUE_DEFERRAL',
          referenceId: 'A1-2026-07-01-aaaabbbb',
          payload: { orderDeferrals: deferrals },
        },
      })
      await client.salesOrder.update({
        where: { id: ORDER_ID },
        data: { unearnedRevenueAmount: snapshot },
      })
    })
    world.events.push('batch:done')
    return { staged: true, error: null }
  } catch (error) {
    world.events.push('batch:refused')
    return {
      staged: false,
      error: error instanceof StaleDailyBatchDeferralError ? error.message : String(error),
    }
  }
}

// ---------------------------------------------------------------------------

test('a batch producer that SNAPSHOTTED before blocking on the lock cannot stage the stale deferral (o3d-y14 r2 F1)', async () => {
  const { applyWcCouponCorrection } = await import('@/lib/connectors/woocommerce/sync/coupon-discount-backfill')
  const fence = await import('@/lib/domain/accounting/daily-batch-discount-fence')
  reset()

  let batch: Promise<{ staged: boolean; error: string | null }> | null = null

  const result = await runTx((tx) => applyWcCouponCorrection(tx, ENTRY), {
    // Under the backfill's lock, before its write. The batch starts here, takes its unlocked
    // snapshot of 10, and then parks on the fence's FOR UPDATE.
    onBackfillCount: async () => {
      world.events.push('backfill:lock')
      batch = runBatchProducer(fence)
      await settle()
      assert.ok(
        !world.events.includes('batch:inserted'),
        'the batch must be PARKED on the lock here — if it staged, the mutex is not a mutex and ' +
          'this test proves nothing',
      )
    },
  })

  assert.equal(result.outcome, 'CORRECTED')
  const batchResult = await batch!

  assert.equal(world.order.discountAmount, 0, 'the backfill corrected the order')
  assert.equal(batchResult.staged, false)
  assert.deepEqual(world.syncLogs, [], 'and NO deferral journal carrying the superseded 90 was staged')
  assert.deepEqual(world.stamps, [], 'and no order was stamped with a superseded unearned figure')
  assert.match(batchResult.error ?? '', /batch 90, live 100/, 'the refusal names both figures')
  assert.deepEqual(
    world.events,
    ['backfill:lock', 'batch:start', 'backfill:write', 'batch:refused'],
    'the batch really did run second, after the lock was released — the interleaving under test',
  )
})

test('the same producer stages normally when no correction interleaves (o3d-y14 r2 F1 control)', async () => {
  // Without this, the test above passes on a fence that refuses unconditionally — which would stop
  // the daily batch entirely and be a far worse defect than the one it fixes.
  const fence = await import('@/lib/domain/accounting/daily-batch-discount-fence')
  reset()

  const batchResult = await runBatchProducer(fence)

  assert.equal(batchResult.staged, true)
  assert.deepEqual(world.syncLogs[0].payload.orderDeferrals, [{ orderId: ORDER_ID, amount: 90 }])
  assert.deepEqual(world.stamps, [{ id: ORDER_ID, unearnedRevenueAmount: 90 }])
  assert.deepEqual(world.events, ['batch:start', 'batch:inserted', 'batch:stamped', 'batch:done'])
})

test('a batch already staged BEFORE the backfill blocks the correction instead (o3d-y14 r2 F1)', async () => {
  // The mirror image, and the reason both halves are needed: whichever party gets the lock first,
  // the loser must see the winner's committed outcome rather than a stale snapshot. Here the batch
  // wins, so the backfill is the one that must decline.
  const { applyWcCouponCorrection } = await import('@/lib/connectors/woocommerce/sync/coupon-discount-backfill')
  const fence = await import('@/lib/domain/accounting/daily-batch-discount-fence')
  reset()

  const staged = await runBatchProducer(fence)
  assert.equal(staged.staged, true, 'the batch went first')

  // Its journal is now PENDING, and the order carries the batch reference the stamp wrote.
  world.order.revenueDeferredBatchRef = 'A1-2026-07-01-aaaabbbb'
  const tx = makeTx()
  ;(tx.accountingSyncLog as { count: (args: { where: { referenceId: string | { in: string[] } } }) => Promise<number> }).count =
    async ({ where }) => (typeof where.referenceId === 'string' ? 0 : 1)

  try {
    const result = await applyWcCouponCorrection(tx as never, {
      ...ENTRY,
      revenueDeferredBatchRef: 'A1-2026-07-01-aaaabbbb',
    })

    assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_BATCH_QUEUED')
    assert.equal(world.order.discountAmount, 10, 'untouched while a worker can still post that journal')
    assert.equal(world.order.discountModel, null, 'and unstamped, so a later run re-proposes it')
  } finally {
    releaseAll(tx)
  }
})
