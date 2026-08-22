import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WcRefund } from '../lib/connectors/woocommerce/sync/types.ts'

/**
 * o3d-xnwu round 3 (Codex HIGH) — A SWEEP THAT READ EVERY PAGE AND APPLIED NOTHING.
 *
 * `RefundSweepResult.complete` is a fact about the READ and only about the read: it is true when
 * `fetchAllWcRefundsForOrder` reached the empty page that ends the walk, and it says nothing at all
 * about what happened to the refunds afterwards. `syncWcRefund` can refuse every one of them — an
 * IMS order it cannot resolve, a refund WooCommerce has already attached to a DIFFERENT order,
 * anything its body throws — and round 2's caller read that silence two ways, both wrong:
 * `complete && synced === 0` as proof the STORE HOLDS NO REFUNDS, and `complete && synced > 0` as
 * proof EVERY REFUND IS NOW IN IMS.
 *
 * This file is the sweep's half of the fix: the result carries `fetched` and `failed`, counted from
 * what actually happened, so the caller has something to decide on. The webhook's half — which
 * verdict it draws from them — is tests/wc-completion-refund-ordering.test.ts.
 *
 * NOTHING ABOUT `syncWcRefund` IS DOUBLED HERE. It is the real function, refused by the real
 * ownership guard it already carries (`refusing to apply it here`) and by the real
 * order-not-resolved guard, driven through a database double. A stub that simply returned
 * `{ success: false }` would prove the counter counts a stub.
 */

/** The refund ids the fake store holds for the order under test, in listing order. */
let collection: number[] = []
/** Refund ids WooCommerce has already attached to ANOTHER IMS order — these must fail to apply. */
let ownedByAnotherOrder = new Set<number>()
/** Refund ids already synced against THIS order — idempotent success. */
let alreadySyncedHere = new Set<number>()
/** Whether the IMS order behind this WC order can be resolved at all. */
let orderResolves = true

const WC_ORDER_ID = 7301
const IMS_ORDER_ID = 'so-1'
const PER_PAGE = 100

function fakeRefund(id: number): WcRefund {
  return {
    id,
    parent_id: WC_ORDER_ID,
    date_created: '2026-08-01T00:00:00',
    date_created_gmt: '2026-08-01T00:00:00',
    amount: '1.00',
    reason: '',
    refunded_by: 1,
    refunded_payment: true,
    meta_data: [],
    line_items: [],
  }
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string> = {}) => {
      const page = Number(params.page ?? '1')
      const start = (page - 1) * PER_PAGE
      return {
        data: collection.slice(start, start + PER_PAGE).map(fakeRefund),
        totalPages: Math.max(1, Math.ceil(collection.length / PER_PAGE)),
        totalItems: collection.length,
      }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

const activity: Array<Record<string, unknown>> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findFirst: async () => (orderResolves
          ? {
            id: IMS_ORDER_ID,
            externalOrderNumber: String(WC_ORDER_ID),
            fxRateToBase: null,
            totalBase: null,
            taxBase: null,
            taxRatePercent: null,
            shippingBase: null,
            taxForeign: null,
            shippingForeign: null,
            lines: [],
          }
          : null),
      },
      salesOrderRefund: {
        findFirst: async ({ where }: { where: { externalRefundId: number } }) => {
          const id = where.externalRefundId
          if (ownedByAnotherOrder.has(id)) return { orderId: 'so-somebody-else' }
          if (alreadySyncedHere.has(id)) return { orderId: IMS_ORDER_ID }
          return null
        },
      },
      shoppingSyncLog: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => null,
      },
    },
  },
})

type RefundSyncModule = typeof import('../lib/connectors/woocommerce/sync/refund-sync.ts')

async function loadSweep(): Promise<RefundSyncModule['syncRefundsForOrder']> {
  return (await import('@/lib/connectors/woocommerce/sync/refund-sync')).syncRefundsForOrder
}

function reset() {
  activity.length = 0
  collection = []
  ownedByAnotherOrder = new Set()
  alreadySyncedHere = new Set()
  orderResolves = true
}

test('o3d-xnwu r3: a sweep that reads every page and applies NOTHING is not an empty store', async () => {
  reset()
  // The store holds two refunds and the walk reads both — it runs to the empty page that ends it,
  // so `complete` is true and truthfully so. Then every one of them fails to apply.
  collection = [11, 12]
  orderResolves = false
  const sweep = await loadSweep()

  const result = await sweep(WC_ORDER_ID)

  assert.equal(result.complete, true, 'the READ finished — that is what complete means')
  assert.equal(result.fetched, 2, 'and it read two refunds, which is what an empty store cannot do')
  assert.equal(result.failed, 2)
  assert.equal(result.synced, 0)
  // The shape the caller used to misread. `complete && synced === 0` is IDENTICAL here to a store
  // that genuinely holds no refunds, and only `fetched` tells them apart.
  assert.equal(result.error, undefined)
})

test('o3d-xnwu r3: a partly-applied sweep says so — synced and failed both non-zero', async () => {
  reset()
  // One refund is already on this order (idempotent success); the other belongs to a different IMS
  // order, which `syncWcRefund` refuses rather than mis-applying. Read complete, application not.
  collection = [21, 22]
  alreadySyncedHere = new Set([21])
  ownedByAnotherOrder = new Set([22])
  const sweep = await loadSweep()

  const result = await sweep(WC_ORDER_ID)

  assert.equal(result.complete, true)
  assert.equal(result.fetched, 2)
  assert.equal(result.synced, 1)
  assert.equal(result.failed, 1)
  // The other shape the caller used to misread: `complete && synced > 0` was taken for "every
  // refund the store holds is now in IMS".
  assert.equal(result.synced + result.failed, result.fetched, 'every refund read is accounted for')
})

test('o3d-xnwu r3: a fully-applied sweep reports no failures, and an empty store reports nothing fetched', async () => {
  reset()
  collection = [31, 32, 33]
  alreadySyncedHere = new Set([31, 32, 33])
  const sweep = await loadSweep()

  const applied = await sweep(WC_ORDER_ID)
  assert.deepEqual(
    { complete: applied.complete, fetched: applied.fetched, synced: applied.synced, failed: applied.failed },
    { complete: true, fetched: 3, synced: 3, failed: 0 },
  )

  reset()
  const empty = await sweep(WC_ORDER_ID)
  assert.deepEqual(
    { complete: empty.complete, fetched: empty.fetched, synced: empty.synced, failed: empty.failed },
    { complete: true, fetched: 0, synced: 0, failed: 0 },
    'nothing fetched on a read that finished is the ONLY evidence that the store holds no refunds',
  )
})
