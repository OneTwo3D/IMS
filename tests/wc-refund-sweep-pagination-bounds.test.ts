import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WcRefund } from '../lib/connectors/woocommerce/sync/types.ts'

/**
 * o3d-okbd, THE HEADER THAT OVER-CLAIMS.
 *
 * WHICH RULE REPLACED WHICH, AND WHY (o3d-ux35). This file was written on this branch against a
 * pager whose walk ended on A SHORT PAGE — "the second bound", the one the sibling suite never
 * exercised. That pager is gone: the sibling branch (o3d-ecbj, merged as PR #636) rebuilt
 * `fetchAllWcRefundsForOrder` to a STRICTER rule and it is what is on development now, so it wins.
 *
 *   ONLY AN EMPTY PAGE ENDS THE WALK. `per_page` is a REQUEST, NOT A GRANT: a store capping below
 *   it answers with its own page size and no error, so EVERY page is short and a length rule
 *   truncates on page one — the very defect the pager exists to remove. A granted size is no
 *   promise either, since nothing keeps it stable across requests. A non-empty page of any length
 *   therefore advances, and the walk costs one extra request per order.
 *
 * So the bound this file was built to defend NO LONGER EXISTS, and the two assertions that pinned
 * it (a walk ending on page 1 of 1, and on page 3 of 3) are rewritten below to the empty-page rule
 * rather than deleted — deleting them would drop the case with them.
 *
 * WHAT IS STILL UNIQUELY COVERED HERE, and why the file earns its place under the new rule: a store
 * whose reported total is LARGER than the collection it describes. `x-wp-totalpages` is computed
 * from a COUNT query taken separately from the page itself, so a refund deleted between the two —
 * or a filtered collection, or a caching layer serving a stale header — reports pages that do not
 * exist. Under the merged rule a header can neither end the walk NOR EXTEND IT: the empty page
 * arrives where the collection really stops, and an over-claiming store costs ONE extra request
 * rather than the forty-nine it claims. A pager that consulted the header for anything but
 * telemetry fails here, at up to a hundred refunds a page against a live store.
 *
 * The double implements WooCommerce's real collection semantics — `per_page` defaults to TEN
 * and caps at ONE HUNDRED — so a walk that goes back to trusting the header fails here
 * authentically rather than against a double built to agree with it.
 */

const requests: Array<{ path: string; params: Record<string, string> }> = []

/** How many refunds the fake store actually holds. */
let storeRefundCount = 0
/** What the fake store CLAIMS in `x-wp-totalpages`, regardless of what it holds. */
let claimedTotalPages = 1
/** A hard stop, so a walk that never terminates fails as a test rather than hanging the run. */
const REQUEST_CEILING = 40

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
      if (requests.length > REQUEST_CEILING) {
        throw new Error(`the refund walk did not terminate: ${requests.length} requests for one order`)
      }
      // WooCommerce's own collection defaults: ten per page, capped at one hundred.
      const requested = Number(params.per_page ?? '10')
      const perPage = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10, 100)
      const page = Number(params.page ?? '1')
      const start = (page - 1) * perPage
      const slice = Array.from({ length: storeRefundCount })
        .map((_, index) => fakeRefund(index + 1))
        .slice(start, start + perPage)
      // The header is a COUNT taken apart from the page, so it is allowed to disagree with it.
      return { data: slice, totalPages: claimedTotalPages, totalItems: storeRefundCount }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
  },
})

type RefundSyncModule = typeof import('../lib/connectors/woocommerce/sync/refund-sync.ts')

async function loadFetchAll(): Promise<RefundSyncModule['fetchAllWcRefundsForOrder']> {
  return (await import('@/lib/connectors/woocommerce/sync/refund-sync')).fetchAllWcRefundsForOrder
}

function reset(held: number, claimed: number) {
  requests.length = 0
  storeRefundCount = held
  claimedTotalPages = claimed
}

test('a store claiming more pages than it holds stops on the EMPTY page, not on the header', async () => {
  // Thirty refunds — a third of one page — behind a header claiming fifty pages.
  //
  // REWRITTEN (o3d-ux35): this asserted ['1'], because the superseded rule ended the walk on page
  // one the moment it came back shorter than the hundred asked for. Under the merged rule a short
  // page proves nothing — a store capping per_page answers exactly like this and still has more —
  // so page two is requested and its EMPTINESS is what ends it. The point of the case is unchanged
  // and is the reason it is rewritten rather than dropped: the header claimed fifty pages and the
  // walk must not spend forty-nine requests on nothing, so the cost of the over-claim is ONE extra
  // request, not fifty.
  reset(30, 50)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.equal(result.error, undefined)
  assert.equal(result.refunds.length, 30)
  assert.deepEqual(requests.map((request) => request.params.page), ['1', '2'])
})

test('the empty page ends a MULTI-page walk too, at the real end rather than the claimed one', async () => {
  // 250 refunds is three pages — 100, 100, 50 — and the header claims fifty pages.
  //
  // REWRITTEN (o3d-ux35): this asserted ['1', '2', '3'], ending on the short third page. The
  // merged rule advances past it and stops on the empty fourth, so the walk is one request longer
  // and still lands on the real end of the collection rather than the claimed one — which is what
  // this case was always about. The 250 ids are asserted unchanged: both rules agree the walk must
  // bank every refund, and the extra page contributes nothing to bank.
  reset(250, 50)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.deepEqual(
    result.refunds.map((refund) => refund.id),
    Array.from({ length: 250 }, (_, index) => index + 1),
  )
  assert.deepEqual(requests.map((request) => request.params.page), ['1', '2', '3', '4'])
})

test('an order with NO refunds is one request, not a walk of the claimed pages', async () => {
  // KEPT AS WRITTEN: both rules agree here, for different reasons. The old rule saw a page shorter
  // than a hundred; the merged rule sees an empty one, which is its only proof of an ending. The
  // ordinary case — most orders have no refunds at all, and the sweep asks about every one of them
  // — must cost exactly one request under either.
  reset(0, 12)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.deepEqual(result.refunds, [])
  assert.deepEqual(requests.map((request) => request.params.page), ['1'])
})
