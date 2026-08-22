import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WcRefund } from '../lib/connectors/woocommerce/sync/types.ts'

/**
 * o3d-okbd: the refund sweep read the FIRST PAGE of refunds and returned as though that were
 * every refund on the order.
 *
 * `/orders/{id}/refunds` is an ordinary WooCommerce collection: `per_page` defaults to TEN and
 * caps at 100, `page` defaults to 1, and the response reports `x-wp-totalpages`. The sweep
 * called the path with no parameters, so an order with more than ten refunds silently
 * contributed ten — and a capped page is indistinguishable from a short one at the call site.
 *
 * The double below implements those semantics rather than a convenient approximation,
 * because that is the whole of what is being tested: a request that names no `per_page` must
 * come back holding ten, exactly as the live store would answer it.
 */

/** Every request the sweep made, so the test can assert on what was ASKED, not only what returned. */
const requests: Array<{ path: string; params: Record<string, string> }> = []

/** How many refunds the fake store holds for the order under test. */
let storeRefundCount = 0
/** Pages that should fail, keyed by page number, to exercise a mid-pagination failure. */
let failingPage: number | null = null
/** Whether the fake store reports `x-wp-totalpages` at all. */
let reportTotalPages = true

function fakeRefund(id: number): WcRefund {
  return {
    id,
    parent_id: 4242,
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
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      requests.push({ path, params })
      // WooCommerce's own collection defaults: ten per page, capped at one hundred.
      const requested = Number(params.per_page ?? '10')
      const perPage = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10, 100)
      const page = Number(params.page ?? '1')
      if (failingPage !== null && page === failingPage) {
        return { data: null, totalPages: 0, totalItems: 0, error: 'WC API error: 503' }
      }
      const start = (page - 1) * perPage
      const slice = Array.from({ length: storeRefundCount })
        .map((_, index) => fakeRefund(index + 1))
        .slice(start, start + perPage)
      return {
        data: slice,
        totalPages: reportTotalPages ? Math.max(1, Math.ceil(storeRefundCount / perPage)) : 1,
        totalItems: storeRefundCount,
      }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

/** Activity rows the module wrote, so a silent truncation cannot pass for a logged one. */
const activity: Array<Record<string, unknown>> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => {
      activity.push(entry)
    },
  },
})

type RefundSyncModule = typeof import('../lib/connectors/woocommerce/sync/refund-sync.ts')

async function loadFetchAll(): Promise<RefundSyncModule['fetchAllWcRefundsForOrder']> {
  return (await import('@/lib/connectors/woocommerce/sync/refund-sync')).fetchAllWcRefundsForOrder
}

function reset(count: number) {
  requests.length = 0
  activity.length = 0
  storeRefundCount = count
  failingPage = null
  reportTotalPages = true
}

test('an order with more than ten refunds yields ALL of them, not the first page', async () => {
  reset(205)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  // The specific identity that matters: every refund id 1..205, in order. Reading one page
  // returns ten (WooCommerce's default) or one hundred (the cap) — both are wrong, and both
  // are silent.
  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.refunds.map((refund) => refund.id),
    Array.from({ length: 205 }, (_, index) => index + 1),
  )
})

test('each page is asked for at the maximum size, so the ten-per-page default is never taken', async () => {
  reset(205)
  const fetchAll = await loadFetchAll()

  await fetchAll(4242)

  assert.deepEqual(
    requests.map((request) => ({ path: request.path, ...request.params })),
    [
      { path: '/orders/4242/refunds', per_page: '100', page: '1' },
      { path: '/orders/4242/refunds', per_page: '100', page: '2' },
      { path: '/orders/4242/refunds', per_page: '100', page: '3' },
      // The fourth is the EMPTY page that ends the walk. 205 refunds leave page 3 five rows long,
      // and a short page proves nothing (round 5).
      { path: '/orders/4242/refunds', per_page: '100', page: '4' },
    ],
  )
})

test('paging stops one page PAST the last refund — an empty page, not a short one', async () => {
  // 150 refunds is a full page and a half. The half-full page does NOT end the walk (round 5: a
  // short page is exactly as consistent with a trimmed response as with the end of a collection),
  // so page 3 comes back empty and that is what ends it.
  reset(150)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.equal(result.refunds.length, 150)
  assert.deepEqual(requests.map((request) => request.params.page), ['1', '2', '3'])
})

test('an exact multiple of the page size ends on the empty page too', async () => {
  // 200 refunds fill two pages exactly, so no page is ever short and only the empty third page
  // can end the walk. This is the case the old length rule could never have covered either.
  reset(200)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.equal(result.refunds.length, 200)
  assert.deepEqual(requests.map((request) => request.params.page), ['1', '2', '3'])
})

test('a store that reports no page total still terminates, on the empty page', async () => {
  reset(30)
  reportTotalPages = false
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.equal(result.refunds.length, 30)
  assert.deepEqual(requests.map((request) => request.params.page), ['1', '2'])
})

test('a page that fails returns the refunds already read AND says it failed', async () => {
  reset(205)
  failingPage = 2
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  // Partial, and it says so — the caller is not handed a truncated list that looks complete.
  assert.equal(result.refunds.length, 100)
  assert.match(result.error ?? '', /503/)
})

test('a first-page failure yields nothing and the error, not an empty success', async () => {
  reset(205)
  failingPage = 1
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.deepEqual(result.refunds, [])
  assert.match(result.error ?? '', /503/)
})

test('a short read is LOGGED, naming the order and how far it got', async () => {
  reset(205)
  failingPage = 2
  const fetchAll = await loadFetchAll()

  await fetchAll(4242)

  const logged = activity.filter((entry) => entry.action === 'wc_refund_read_incomplete')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].level, 'WARNING')
  assert.deepEqual(logged[0].metadata, {
    externalOrderId: 4242,
    failedPage: 2,
    readSoFar: 100,
    error: 'WC API error: 503',
  })
})

test('a COMPLETE read logs nothing — the warning means "short", not "ran"', async () => {
  reset(205)
  const fetchAll = await loadFetchAll()

  await fetchAll(4242)

  assert.deepEqual(activity.filter((entry) => entry.action === 'wc_refund_read_incomplete'), [])
})
