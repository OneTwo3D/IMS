import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WcRefund } from '../lib/connectors/woocommerce/sync/types.ts'

/**
 * o3d-ecbj round 5: what a POSITIONAL pager over a MUTABLE collection can and cannot establish.
 *
 * The sweep's own suite (tests/wc-refund-sweep-pagination.test.ts) is built on a double whose
 * `per_page` is `Math.min(requested, 100)` — a store that always grants what it is asked for. No
 * case in it can distinguish a page that ENDED from a page that was CUT, which is why deleting the
 * short-page bound left all nine of its tests green. This file's double grants LESS than it is
 * asked for, TRIMS responses independently of the offsets it computes, and lets the collection
 * MOVE between two requests of one walk.
 *
 * THE THREE THINGS THAT COST REFUNDS, and what the walk now does about each:
 *
 *   1. A CAP BELOW THE REQUESTED SIZE. `per_page=100` is a request, not a grant. A store capping
 *      at ten answers with ten and no error, so under a "shorter than asked for" rule EVERY page is
 *      short and the walk ends after the first one. Only an EMPTY page ends it now.
 *   2. A CAP THAT VARIES. A proxy or load-shedder trims one response without moving the offsets, so
 *      the rows in the gap are served to nobody while every page still looks plausible. No length
 *      rule can see that; the store's own `x-wp-total` can, and refuses.
 *   3. A REFUND DELETED BEHIND THE CURSOR. Every later row shifts down one offset and the row that
 *      was going to open the next page is served to nobody. The list still carries the id of the
 *      DELETED row, so it is one too long by precisely the amount it is one too short — the count
 *      balances and no arithmetic over a single walk recovers the difference. What IS caught is the
 *      same motion running the other way: an insertion re-serves a row, and offsets do not overlap.
 *
 * The walk is deliberately NOT run twice here — see `fetchAllWcRefundsForOrder`. Its output only
 * ever WITHHOLDS (an unread refund is demand never netted, so a dispatch is refused), and a short
 * list can withhold but never grant.
 */

/** Every request the walk made, so the test can assert on what was ASKED, not only what returned. */
const requests: Array<{ path: string; params: Record<string, string> }> = []

/** The refund ids the fake store holds, in the order it lists them. Mutable mid-walk, on purpose. */
let collection: number[] = []
/** The page size the STORE GRANTS, however much is asked for. Affects the offsets it computes. */
let grantedPerPage = 100
/**
 * Rows to trim a response down to, keyed by page — a proxy or load-shedder cutting the RESPONSE
 * after the store computed the page. Deliberately does NOT move the next page's offset, which is
 * what makes the trimmed rows unreachable.
 */
const trims = new Map<number, number>()
/** Runs BEFORE a page is served, so the collection can move BETWEEN two requests of one walk. */
const mutations = new Map<number, () => void>()
/** A stale/cached `x-wp-total`: WordPress computes it from a COUNT query taken apart from the page. */
let frozenTotal: number | null = null
/** A store that ignores `page` in the other direction: endless distinct rows, so the walk must stop itself. */
let endless = false
let endlessNextId = 1
/** A hard stop, so a walk that never terminates fails as a test rather than hanging the run. */
const REQUEST_CEILING = 200

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
      const page = Number(params.page ?? '1')
      mutations.get(page)?.()

      if (endless) {
        const slice = Array.from({ length: grantedPerPage }, () => fakeRefund(endlessNextId++))
        return { data: slice, totalPages: 1, totalItems: 0 }
      }

      // WooCommerce's own default is TEN; `grantedPerPage` is what THIS store is willing to serve,
      // which is where a request stops being a grant.
      const requested = Number(params.per_page ?? '10')
      const asked = Number.isFinite(requested) && requested > 0 ? requested : 10
      const perPage = Math.min(asked, grantedPerPage)
      const start = (page - 1) * perPage
      const served = collection.slice(start, start + perPage)
      // The trim happens AFTER the offset was computed, so the rows it removes are never served on
      // any page. That is the whole point of modelling it separately from the cap.
      const trimmed = trims.has(page) ? served.slice(0, trims.get(page)) : served
      return {
        data: trimmed.map(fakeRefund),
        totalPages: Math.max(1, Math.ceil(collection.length / perPage)),
        totalItems: frozenTotal ?? collection.length,
      }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

/** Activity rows the module wrote, so an incomplete read cannot pass for a silent one. */
const activity: Array<Record<string, unknown>> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) },
  },
})

/**
 * Enough of the database for `syncWcRefund` to bail out on its FIRST query. The sweep's per-refund
 * work is not what these tests are about — what matters is that the count it returns is the same
 * whether the list was whole or not, which is exactly why the count could not carry completeness.
 */
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findFirst: async () => null },
      salesOrderRefund: { findFirst: async () => null },
      shoppingSyncLog: { findFirst: async () => null },
      warehouse: { findFirst: async () => null },
      $transaction: async () => { throw new Error('unexpected transaction') },
    },
  },
})

type RefundSyncModule = typeof import('../lib/connectors/woocommerce/sync/refund-sync.ts')

async function loadFetchAll(): Promise<RefundSyncModule['fetchAllWcRefundsForOrder']> {
  return (await import('@/lib/connectors/woocommerce/sync/refund-sync')).fetchAllWcRefundsForOrder
}

async function loadSyncRefunds(): Promise<RefundSyncModule['syncRefundsForOrder']> {
  return (await import('@/lib/connectors/woocommerce/sync/refund-sync')).syncRefundsForOrder
}

function reset(held: number, granted = 100) {
  requests.length = 0
  activity.length = 0
  collection = Array.from({ length: held }, (_, index) => index + 1)
  grantedPerPage = granted
  trims.clear()
  mutations.clear()
  frozenTotal = null
  endless = false
  endlessNextId = 1
}

function pagesAsked(): string[] {
  return requests.map((request) => request.params.page ?? '1')
}

test('a store that CAPS per_page below the request still yields every refund', async () => {
  // The store grants ten however loudly a hundred is asked for — a `rest_post_per_page` filter, a
  // hardened host, a security plugin. Under "a page shorter than the one asked for is the last
  // page" this order contributed TEN refunds and reported success.
  reset(25, 10)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.refunds.map((refund) => refund.id),
    Array.from({ length: 25 }, (_, index) => index + 1),
  )
  // Three pages of ten, then the empty one that ends it.
  assert.deepEqual(pagesAsked(), ['1', '2', '3', '4'])
})

test('a capped store is asked for the maximum anyway — the cap is the store\'s answer, not our request', async () => {
  reset(25, 10)
  const fetchAll = await loadFetchAll()

  await fetchAll(4242)

  assert.deepEqual([...new Set(requests.map((request) => request.params.per_page))], ['100'])
})

test('a page TRIMMED below the granted size does not end the walk, and the shortfall is reported', async () => {
  // A cap that VARIES: the store computed a hundred rows for page one and something between it and
  // us delivered forty. Offsets did not move, so rows 41-100 are served to nobody. No length rule
  // can see that — a short page is exactly as consistent with the end of a collection — so the walk
  // ADVANCES, and it is the store's own stated total that proves the read was short.
  reset(150)
  trims.set(1, 40)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  // It did NOT stop on the forty.
  assert.deepEqual(pagesAsked(), ['1', '2', '3'])
  assert.equal(result.refunds.length, 90)
  assert.match(result.error ?? '', /says that order has 150 refunds but served only 90/)
  assert.equal(activity.filter((entry) => entry.action === 'wc_refund_read_incomplete').length, 1)
})

test('the SMALLEST stated total is used, so a refund created mid-walk is not a permanent refusal', async () => {
  // 150 refunds, read as two full pages. A 151st is then created — newest first, so it takes offset
  // zero, behind a cursor that has already passed it — and the closing empty page states 151 while
  // every page before it stated 150. Taking the LATEST claim refuses a read that was complete when
  // it was made, and refuses it again on every sweep, because each sweep can be overtaken the same
  // way. Taking the SMALLEST, the walk is complete on its own terms and the new refund is the next
  // sweep's business.
  reset(150)
  mutations.set(3, () => { collection.unshift(9001) })
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.refunds.map((refund) => refund.id),
    Array.from({ length: 150 }, (_, index) => index + 1),
  )
})

test('a refund CREATED behind the cursor re-serves a row, and a repeat refuses', async () => {
  // WooCommerce lists refunds newest first, so a refund created mid-walk takes offset 0 and pushes
  // a row already read onto the next page. Offsets do not overlap, so a repeat can only mean the
  // list moved — the one direct proof of motion a single walk can obtain.
  reset(205)
  mutations.set(2, () => { collection.unshift(9001) })
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.match(result.error ?? '', /served refund 100 twice, on different pages/)
  assert.deepEqual(pagesAsked(), ['1', '2'])
  const logged = activity.filter((entry) => entry.action === 'wc_refund_read_incomplete')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].level, 'WARNING')
})

test('a refund DELETED behind the cursor is caught when the stated total does not move with it', async () => {
  // Id 51 is deleted after page one served it. Every later row shifts down one offset, so id 101 —
  // which was going to open page two — is served to nobody. `x-wp-total` is a COUNT query taken
  // apart from the page, so a cached or stale header still says 205 while only 204 rows arrive.
  reset(205)
  frozenTotal = 205
  mutations.set(2, () => { collection.splice(50, 1) })
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.match(result.error ?? '', /says that order has 205 refunds but served only 204/)
  assert.equal(result.refunds.some((refund) => refund.id === 101), false, 'the shifted row is the one lost')
})

test('a deletion whose total moves WITH it balances exactly, and the walk cannot see it', async () => {
  // The limit of a single positional walk, pinned rather than assumed. Same deletion, but the store
  // recomputes `x-wp-total` for every page, so it states 204 from page two on. 204 rows are banked
  // and 204 are claimed: the count BALANCES, because the list still carries the id of the DELETED
  // row (banked on page one) and is one too long by precisely the amount it is one too short.
  //
  // Nothing here refuses, and nothing should pretend to: this walk's output only WITHHOLDS a
  // dispatch, never grants one, and the next sweep re-reads the order from page one. The read that
  // AUTHORISES something — the dismissal in app/actions/sync-exceptions.ts — is the one that runs
  // its walk twice and requires the answers to agree.
  reset(205)
  mutations.set(2, () => { collection.splice(50, 1) })
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.equal(result.error, undefined)
  assert.equal(result.refunds.length, 204)
  assert.equal(result.refunds.some((refund) => refund.id === 51), true, 'the deleted row is still banked')
  assert.equal(result.refunds.some((refund) => refund.id === 101), false, 'and the row it hid is missing')
})

test('an order with NO refunds costs exactly one request', async () => {
  // The empty page is the ordinary case: most orders have no refunds and the sweep asks about all
  // of them. Ending only on an empty page must not make the common case more expensive.
  reset(0)
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.deepEqual(result.refunds, [])
  assert.equal(result.error, undefined)
  assert.deepEqual(pagesAsked(), ['1'])
})

test('a list that never ends stops at the page ceiling and says the read is INCOMPLETE', async () => {
  // Distinct rows forever — a store ignoring `page`, or a filter that keeps matching. Without a
  // ceiling, "only an empty page ends the walk" is an unbounded loop against a live store; with
  // one, the stop is reported as incomplete rather than passed off as the end of the collection.
  reset(0)
  endless = true
  const fetchAll = await loadFetchAll()

  const result = await fetchAll(4242)

  assert.match(result.error ?? '', /did not end within 50 pages/)
  assert.equal(requests.length, 50)
  assert.equal(result.refunds.length, 5000)
})

/**
 * ROUND 5, FINDING 3: the incompleteness has to reach a CALLER, not just the activity log.
 *
 * `fetchAllWcRefundsForOrder` has reported a short read since round 4, but `syncRefundsForOrder`
 * destructured `{ refunds }` and returned a bare count — so the webhook handler acknowledged its
 * delivery and the order-import sweep advanced its cursor over an order whose refunds it had only
 * partly read, which is what made a truncation permanent rather than transient. A count cannot
 * carry the fact: the two tests below produce the SAME `synced` number from a whole list and a
 * short one.
 */
test('syncRefundsForOrder reports a SHORT list as incomplete, with the reason', async () => {
  reset(150)
  trims.set(1, 40)
  const syncRefunds = await loadSyncRefunds()

  const result = await syncRefunds(4242)

  assert.equal(result.complete, false)
  assert.match(result.error ?? '', /says that order has 150 refunds but served only 90/)
  assert.equal(result.synced, 0)
})

test('syncRefundsForOrder reports a WHOLE list as complete — same count, different answer', async () => {
  reset(90)
  const syncRefunds = await loadSyncRefunds()

  const result = await syncRefunds(4242)

  assert.equal(result.complete, true)
  assert.equal(result.error, undefined)
  // Identical to the short read above, which is the whole reason completeness needed its own field.
  assert.equal(result.synced, 0)
})

test('an order the store says HAS refunds but serves none is incomplete, not empty', async () => {
  // The most dangerous shape of all, because zero refunds is the ordinary answer: the store states
  // seven and serves an empty first page. To a bare count this is indistinguishable from an order
  // with no refunds — and every refund on it is demand the coverage check never nets.
  reset(0)
  frozenTotal = 7
  const syncRefunds = await loadSyncRefunds()

  const result = await syncRefunds(4242)

  assert.equal(result.complete, false)
  assert.match(result.error ?? '', /says that order has 7 refunds but served only 0/)
  assert.equal(result.synced, 0)
})
