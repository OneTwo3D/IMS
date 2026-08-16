import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-5ct. The o3d-y14 backfill used to PATCH the queued SALES_INVOICE payload, because the
 * processors post from a payload snapshot rather than re-reading the order. That can never be made
 * safe from the writer's side: both processors read the sync row BEFORE they conditionally claim it,
 * so a worker can be holding the old payload while the row still reads PENDING. Re-checking the
 * status inside a transaction does not reach another process's memory — it only narrows the window.
 *
 * So the backfill does not touch the queue at all. It takes the sales-order row lock — the SAME
 * `SELECT ... FOR UPDATE` that `lockOrderForAccountingEnqueue` takes inside queueXeroSync /
 * queueQuickBooksSync, and that queueAccountingSyncTx refuses to run without — and DECLINES any order
 * that has live invoice work, reporting it.
 *
 * The second half of that fence is NOT here: the lock serialises the INSERT of a queue row, not the
 * CONSTRUCTION of its payload. See tests/domain/accounting/enqueue-discount-fence.test.ts for the
 * producer that snapshots BEFORE blocking on the lock, which this file's ordering cannot express.
 *
 * The doubles below honour their `where` clauses. A double that returned a fixed count, or ignored
 * the status filter, could not tell "declined because a job is live" from "corrected anyway" — which
 * is the entire property under test.
 */

const events: string[] = []
const locked: string[] = []

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async (_tx: unknown, orderId: string) => {
      events.push(`lock:${orderId}`)
      locked.push(orderId)
    },
  },
})

type SyncLogRow = { id: string; referenceType: string; referenceId: string; type: string; status: string }

type OrderRow = {
  id: string
  discountAmount: number
  discountModel: string | null
  lines: Array<{ discountAmount: number }>
  importedAt: string | null
}

type Store = {
  orders: OrderRow[]
  syncLogs: SyncLogRow[]
  activity: Array<{ action: string; entityId: string | null; metadata: Record<string, unknown> }>
}

/**
 * A transaction stub that actually EVALUATES its predicates: findUnique matches on id and returns
 * the FULL evidence set (amount, lines, link timestamp) the way the real select does, updateMany
 * applies the full compare-and-set and only mutates on a match, and count filters by
 * referenceType/referenceId/type/status. Anything on `accountingSyncLog` other than `count` throws —
 * the backfill must never write to the queue.
 */
function makeTx(store: Store, hooks: { afterRead?: () => void } = {}) {
  return {
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        events.push(`findUnique:${where.id}`)
        const found = store.orders.find((order) => order.id === where.id)
        const snapshot = found
          ? {
              id: found.id,
              discountAmount: found.discountAmount,
              discountModel: found.discountModel,
              lines: found.lines.map((line) => ({ ...line })),
              shoppingLinks: found.importedAt ? [{ createdAt: new Date(found.importedAt) }] : [],
            }
          : null
        // Lets a test land a concurrent write in the window BETWEEN the read and the update — the
        // window the row lock closes for enqueue paths, and the compare-and-set closes for anything
        // that reaches the row without taking it.
        hooks.afterRead?.()
        return snapshot
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; discountAmount?: number; discountModel?: null }
        data: { discountAmount?: number; discountModel: string }
      }) => {
        events.push(`updateMany:${where.id}`)
        // Modelled on Prisma: a predicate that is ABSENT does not constrain. If it did, dropping the
        // compare-and-set from production would make the double reject every write and every test
        // would fail for the wrong reason — hiding which property the CAS actually carries.
        const target = store.orders.find(
          (order) =>
            order.id === where.id &&
            (!('discountAmount' in where) || order.discountAmount === where.discountAmount) &&
            (!('discountModel' in where) || order.discountModel === where.discountModel),
        )
        if (!target) return { count: 0 }
        // Likewise: a field the write does NOT set must stay as it was, or a stamp-only write would
        // be indistinguishable from a correction that happened to keep the amount.
        if ('discountAmount' in data && data.discountAmount !== undefined) {
          target.discountAmount = data.discountAmount
        }
        target.discountModel = data.discountModel
        return { count: 1 }
      },
    },
    accountingSyncLog: {
      count: async ({ where }: { where: { referenceType: string; referenceId: string; type: { in: string[] }; status: { in: string[] } } }) => {
        events.push(`count:${where.referenceId}`)
        return store.syncLogs.filter(
          (log) =>
            log.referenceType === where.referenceType &&
            log.referenceId === where.referenceId &&
            where.type.in.includes(log.type) &&
            where.status.in.includes(log.status),
        ).length
      },
      update: async () => {
        throw new Error('the backfill must never mutate a queued payload (o3d-5ct)')
      },
      updateMany: async () => {
        throw new Error('the backfill must never mutate a queued payload (o3d-5ct)')
      },
      delete: async () => {
        throw new Error('the backfill must never retire a queued job (o3d-5ct)')
      },
    },
    activityLog: {
      create: async ({ data }: { data: { action: string; entityId: string | null; metadata: Record<string, unknown> } }) => {
        events.push('activityLog:create')
        store.activity.push(data)
        return data
      },
    },
  } as never
}

async function load() {
  return await import('@/lib/connectors/woocommerce/sync/coupon-discount-backfill')
}

const IMPORTED_AT = '2026-05-01T00:00:00.000Z'

function makeStore(over: Partial<Store> = {}): Store {
  return {
    orders: [
      { id: 'order-1', discountAmount: 10, discountModel: null, lines: [{ discountAmount: 10 }], importedAt: IMPORTED_AT },
    ],
    syncLogs: [],
    activity: [],
    ...over,
  }
}

/** The reviewed allowlist entry — the ONLY thing apply is allowed to act on. */
const entry = {
  orderId: 'order-1',
  orderNumber: 'WC-1001',
  externalOrderNumber: '1001',
  currency: 'GBP',
  storedOrderDiscount: 10,
  lineDiscountTotal: 10,
  importedAt: IMPORTED_AT,
  keptOrderLevel: 0,
  clearedBy: 10,
  partial: false,
  accountingInvoiceId: null,
  nearCutoff: false,
}

function reset() {
  events.length = 0
  locked.length = 0
}

test('a reviewed order is corrected and STAMPED in the same write (o3d-5ct/o3d-9te)', async () => {
  const { applyWcCouponCorrection, WC_COUPON_DISCOUNT_MODEL } = await load()
  reset()
  const store = makeStore()

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.deepEqual(result, { outcome: 'CORRECTED' })
  assert.equal(store.orders[0].discountAmount, 0, 'the duplicated part is cleared')
  assert.equal(
    store.orders[0].discountModel,
    WC_COUPON_DISCOUNT_MODEL,
    'and the row now SAYS what its amount means, so a later run cannot re-derive it',
  )
  assert.equal(store.activity.length, 1)
  assert.equal(store.activity[0].entityId, 'order-1')
})

test('the order row lock is taken BEFORE anything is read or decided (o3d-5ct)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()

  await applyWcCouponCorrection(makeTx(makeStore()), entry)

  assert.deepEqual(locked, ['order-1'], 'the same row every accounting enqueue path locks')
  assert.deepEqual(
    events,
    ['lock:order-1', 'findUnique:order-1', 'count:order-1', 'updateMany:order-1', 'activityLog:create'],
    'reading or counting before the lock would make the live-invoice check a sample, not a decision',
  )
})

test('an order with a PENDING invoice job is DECLINED and nothing is written (o3d-5ct)', async () => {
  // The exact race: a worker has already read this row and kept its payload. It will claim next and
  // post the old figure. Correcting the order here would record it as fixed anyway.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [{ id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'PENDING' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome, 'DECLINED')
  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_INVOICE_QUEUED')
  assert.equal(store.orders[0].discountAmount, 10, 'the order is untouched, so a re-run re-evaluates it')
  assert.equal(store.orders[0].discountModel, null, 'and unstamped, so nothing hides it from a re-run')
  assert.equal(store.activity.length, 0, 'no marker: it was NOT corrected')
})

test('a PROCESSING job — a worker mid-post — also declines (o3d-5ct)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [{ id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'PROCESSING' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_INVOICE_QUEUED')
})

test('a retryable FAILED job blocks too — "Retry All" would still post it (o3d-5ct)', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [{ id: 'job-1', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE_UPDATE', status: 'FAILED' }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LIVE_INVOICE_QUEUED')
})

test('a TERMINAL job does not block, and another order\'s job is not confused for this one (o3d-5ct)', async () => {
  // Proves the double's filter is really applied: SYNCED/CANCELLED rows cannot be claimed, so no
  // worker can still post them; and a live job on a DIFFERENT order is irrelevant here.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    syncLogs: [
      { id: 'job-synced', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'SYNCED' },
      { id: 'job-cancelled', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'SALES_INVOICE', status: 'CANCELLED' },
      { id: 'job-other', referenceType: 'SalesOrder', referenceId: 'order-2', type: 'SALES_INVOICE', status: 'PENDING' },
      { id: 'job-cogs', referenceType: 'SalesOrder', referenceId: 'order-1', type: 'COGS_JOURNAL', status: 'PENDING' },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.deepEqual(result, { outcome: 'CORRECTED' })
})

test('the queue is never written to, only counted (o3d-5ct)', async () => {
  // The stub throws on any accountingSyncLog write. Patching a payload is the behaviour this issue
  // removed, and it must not come back under a different name.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  await applyWcCouponCorrection(makeTx(store), entry)

  assert.deepEqual(
    events.filter((event) => event.startsWith('count:')),
    ['count:order-1'],
    'the only queue interaction is a read',
  )
})

// ---------------------------------------------------------------------------
// Re-verifying the REVIEWED evidence (Codex r1 F3)
// ---------------------------------------------------------------------------

test('an order whose amount moved since the review is DECLINED, not clobbered', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 7, discountModel: null, lines: [{ discountAmount: 10 }], importedAt: IMPORTED_AT }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'VALUE_CHANGED')
  assert.equal(store.orders[0].discountAmount, 7)
})

test('an order whose LINE discounts moved since the review is DECLINED (Codex r1 F3)', async () => {
  // The order-level amount still matches, so the old value-only check would have proceeded — and
  // written a residual computed from lines that no longer exist. The subtraction reads the lines,
  // so the lines are part of the evidence the reviewer approved.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 10, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'LINES_CHANGED')
  assert.equal(store.orders[0].discountAmount, 10, 'untouched')
  assert.equal(store.orders[0].discountModel, null, 'and unstamped, so a later review sees it again')
})

test('an order RE-IMPORTED since the review is DECLINED — its provenance evidence moved (Codex r1 F3)', async () => {
  // importedAt IS the provenance. A row whose link timestamp changed was re-linked or re-imported,
  // so the reviewer's dating of it — the only thing that made it a candidate — no longer applies.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: null,
        lines: [{ discountAmount: 10 }],
        importedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'IMPORT_CHANGED')
  assert.equal(store.orders[0].discountAmount, 10)
})

test('a HAND-EDITED residual in the allowlist is refused, never written (Codex r1 F3)', async () => {
  // The allowlist decides WHICH orders, never WHAT is written: the amount is re-derived from the
  // live evidence, and a file that disagrees with its own inputs is a refusal. Otherwise a typo in a
  // reviewed file would be an instruction to write a wrong figure.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  const result = await applyWcCouponCorrection(makeTx(store), { ...entry, keptOrderLevel: 9 })

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'PLAN_MISMATCH')
  assert.equal(store.orders[0].discountAmount, 10, 'nothing was written')
  assert.equal(store.orders[0].discountModel, null)
})

test('the residual actually written comes from the LIVE evidence, not the file', async () => {
  // Same row, a genuine partial: 4 of the 10 reached the lines, so 6 is real order-level money and
  // must survive. The reviewed entry agrees, and the write is the re-derived figure.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 10, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await applyWcCouponCorrection(makeTx(store), {
    ...entry,
    lineDiscountTotal: 4,
    keptOrderLevel: 6,
    clearedBy: 4,
    partial: true,
  })

  assert.deepEqual(result, { outcome: 'CORRECTED' })
  assert.equal(store.orders[0].discountAmount, 6)
})

test('a write that lands BETWEEN the read and the update loses to the compare-and-set', async () => {
  // The re-read alone cannot catch this one: at the moment it ran, the value still matched. Only the
  // predicate ON THE WRITE does. Anything that reaches the row without taking the order lock — which
  // no enqueue path does, but a future one might — must make this a no-op rather than a clobber.
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore()

  const result = await applyWcCouponCorrection(
    makeTx(store, {
      afterRead: () => {
        store.orders[0].discountAmount = 3
      },
    }),
    entry,
  )

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'VALUE_CHANGED')
  assert.equal(store.orders[0].discountAmount, 3, 'the concurrent value stands; ours is discarded')
  assert.equal(store.orders[0].discountModel, null, 'and nothing is stamped, so a re-run re-evaluates it')
  assert.equal(store.activity.length, 0, 'no marker for a correction that did not happen')
})

test('an order stamped since the review is DECLINED — the stamp is now the truth', async () => {
  const { applyWcCouponCorrection, WC_COUPON_DISCOUNT_MODEL } = await load()
  reset()
  const store = makeStore({
    orders: [
      {
        id: 'order-1',
        discountAmount: 10,
        discountModel: WC_COUPON_DISCOUNT_MODEL,
        lines: [{ discountAmount: 10 }],
        importedAt: IMPORTED_AT,
      },
    ],
  })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'ALREADY_MARKED')
  assert.equal(store.orders[0].discountAmount, 10, 'a stamped residual is never re-derived')
})

test('an order deleted since the review is DECLINED, not resurrected', async () => {
  const { applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({ orders: [] })

  const result = await applyWcCouponCorrection(makeTx(store), entry)

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'ORDER_GONE')
  assert.equal(store.activity.length, 0)
})

// ---------------------------------------------------------------------------
// stampWcCouponDiscountModel — the reviewer's "this one is already correct"
// ---------------------------------------------------------------------------

test('stamping records the model WITHOUT touching the amount (Codex r1 F3)', async () => {
  // The row a manual correction already fixed: 6 residual with 4 on the lines. Re-deriving it would
  // take it to 2. Stamping says so durably, so no later run can.
  const { stampWcCouponDiscountModel, WC_COUPON_DISCOUNT_MODEL, WC_COUPON_STAMP_ACTION } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 6, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await stampWcCouponDiscountModel(makeTx(store), {
    ...entry,
    storedOrderDiscount: 6,
    lineDiscountTotal: 4,
    keptOrderLevel: 2,
    clearedBy: 4,
  })

  assert.deepEqual(result, { outcome: 'CORRECTED' })
  assert.equal(store.orders[0].discountAmount, 6, 'the manually corrected amount SURVIVES')
  assert.equal(store.orders[0].discountModel, WC_COUPON_DISCOUNT_MODEL)
  assert.equal(store.activity[0].action, WC_COUPON_STAMP_ACTION, 'a distinct action: a human assertion, not a computation')
  assert.equal(store.activity[0].metadata.amountChanged, false)
})

test('a stamped row is thereafter refused by the CORRECTION path (Codex r1 F3)', async () => {
  // The point of stamping first: after it, the destructive path cannot reach the row at all — by
  // evidence on the row, not by anyone remembering to keep it off a list.
  const { stampWcCouponDiscountModel, applyWcCouponCorrection } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 6, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })
  const correct = { ...entry, storedOrderDiscount: 6, lineDiscountTotal: 4, keptOrderLevel: 2, clearedBy: 4 }

  await stampWcCouponDiscountModel(makeTx(store), correct)
  const second = await applyWcCouponCorrection(makeTx(store), correct)

  assert.equal(second.outcome === 'DECLINED' && second.reason, 'ALREADY_MARKED')
  assert.equal(store.orders[0].discountAmount, 6, 'still 6 — never eroded to 2')
})

test('stamping is refused when the amount it was asserted about has moved', async () => {
  const { stampWcCouponDiscountModel } = await load()
  reset()
  const store = makeStore({
    orders: [{ id: 'order-1', discountAmount: 5, discountModel: null, lines: [{ discountAmount: 4 }], importedAt: IMPORTED_AT }],
  })

  const result = await stampWcCouponDiscountModel(makeTx(store), { ...entry, storedOrderDiscount: 6 })

  assert.equal(result.outcome === 'DECLINED' && result.reason, 'VALUE_CHANGED')
  assert.equal(store.orders[0].discountModel, null, 'an assertion about a different value is not recorded')
})

test('stamping takes the same row lock as the correction', async () => {
  const { stampWcCouponDiscountModel } = await load()
  reset()

  await stampWcCouponDiscountModel(makeTx(makeStore()), entry)

  assert.deepEqual(locked, ['order-1'])
  assert.equal(events[0], 'lock:order-1')
})
