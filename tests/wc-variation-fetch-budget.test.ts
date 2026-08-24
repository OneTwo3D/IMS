import assert from 'node:assert/strict'
import test from 'node:test'

import { WC_PAGINATION_UNKNOWN, WC_REQUEST_TIMEOUT_MS, readWcCountHeader } from '@/lib/connectors/woocommerce/api'
import {
  MAX_WC_VARIATIONS_PER_PRODUCT,
  MAX_WC_VARIATION_PAGES,
  PRODUCT_WRITE_TX_MAX_WAIT_MS,
  PRODUCT_WRITE_TX_TIMEOUT_MS,
  WC_VARIATION_FETCH_BUDGET_MS,
  WC_VARIATION_PAGE_LATENCY_ALLOWANCE_MS,
  WC_VARIATION_PAGE_SIZE,
} from '@/lib/connectors/woocommerce/sync/product-sync'
import { getWcWebhookStaleProcessingMs } from '@/lib/connectors/shopping-webhook-inbox'

// o3d-jcx: the numbers, checked against each other. Constants that agree only by accident are the
// reason an unbounded prefetch could outlive the inbox claim on the item it was processing.

test('o3d-jcx: an unreadable page-count header becomes the UNKNOWN sentinel, never NaN', () => {
  // `parseInt('')` is NaN and `page <= NaN` is false, so an empty x-wp-totalpages ended every
  // paging loop in this connector after page one and reported the truncated result as complete.
  assert.equal(readWcCountHeader('', 1), WC_PAGINATION_UNKNOWN)
  assert.equal(readWcCountHeader('   ', 1), WC_PAGINATION_UNKNOWN)
  assert.equal(readWcCountHeader('not-a-number', 1), WC_PAGINATION_UNKNOWN)
  assert.equal(readWcCountHeader('-3', 1), WC_PAGINATION_UNKNOWN)
  // An ABSENT header is a different fact from an unreadable one and keeps the caller's default.
  assert.equal(readWcCountHeader(null, 1), 1)
  assert.equal(readWcCountHeader(null, 0), 0)
  assert.equal(readWcCountHeader('7', 1), 7)
  assert.equal(readWcCountHeader(' 7 ', 1), 7)
  assert.equal(readWcCountHeader('0', 1), 0)
})

test('o3d-jcx: the variations prefetch cannot outlive the webhook inbox claim it holds', () => {
  // Worst case for one claimed inbox item: the fetch spends its whole budget, one final request is
  // already in flight when the deadline passes (the check happens BETWEEN pages), and the write
  // transaction then takes its full budget including the wait for a connection.
  const worstCase =
    WC_VARIATION_FETCH_BUDGET_MS + WC_REQUEST_TIMEOUT_MS + PRODUCT_WRITE_TX_TIMEOUT_MS + PRODUCT_WRITE_TX_MAX_WAIT_MS
  const reclaimAfter = getWcWebhookStaleProcessingMs({})
  assert.ok(
    worstCase < reclaimAfter,
    `a claimed item can be in flight for ${worstCase}ms but is reclaimable after ${reclaimAfter}ms — `
    + 'a second worker would duplicate the expensive fetch and contend on the same SKU advisory locks, '
    + 'and each reclaim burns an attempt toward the dead-letter cap',
  )
})

test('o3d-jcx: the page ceiling can always carry the item ceiling, whatever page size the store grants', () => {
  // The page ceiling exists to stop a store that ignores `page` being asked for ever — it must
  // never be the thing that refuses a product inside the SUPPORTED item count. WooCommerce's own
  // default page size for a collection is 10, which is the stingiest a store realistically grants,
  // and the walk needs one more request for the empty page that ends it.
  assert.equal(WC_VARIATION_PAGE_SIZE, 100, 'the WooCommerce REST API caps per_page at 100')
  assert.ok(
    MAX_WC_VARIATION_PAGES >= Math.ceil(MAX_WC_VARIATIONS_PER_PRODUCT / 10) + 1,
    `${MAX_WC_VARIATION_PAGES} pages cannot collect ${MAX_WC_VARIATIONS_PER_PRODUCT} variations from a `
    + 'store granting 10 rows a page, so the page ceiling would refuse a product the item ceiling allows',
  )
})

test('o3d-jcx: the unbounded fetch could not have fitted the transaction budget', () => {
  // The supported count is derived from what the WRITE transaction can complete, not from what the
  // fetch could hold. At one advisory lock plus one to four statements per variation, the ceiling
  // has to leave real headroom inside PRODUCT_WRITE_TX_TIMEOUT_MS — this pins the relationship so
  // raising the count without raising the budget fails here rather than in production.
  const statementsPerVariation = 4
  const budgetPerStatementMs = PRODUCT_WRITE_TX_TIMEOUT_MS / (MAX_WC_VARIATIONS_PER_PRODUCT * (statementsPerVariation + 1))
  assert.ok(
    budgetPerStatementMs >= 10,
    `only ${budgetPerStatementMs.toFixed(2)}ms per statement is left for ${MAX_WC_VARIATIONS_PER_PRODUCT} `
    + `variations inside a ${PRODUCT_WRITE_TX_TIMEOUT_MS}ms transaction`,
  )
})

test('o3d-xnwu: the TIME budget can carry the PAGE ceiling — the relationship the two ceilings never had', () => {
  // THE GAP THIS CLOSES. MAX_WC_VARIATIONS_PER_PRODUCT is sized against the write transaction and
  // MAX_WC_VARIATION_PAGES against the stingiest page size a store grants. Neither was ever
  // compared to WC_VARIATION_FETCH_BUDGET_MS — yet the two together describe a REAL product: the
  // largest supported product on the stingiest supported store needs every one of those pages, and
  // all of them have to fit inside the budget.
  //
  // If they do not, the walk throws its TRANSIENT budget error, the item is retried, the retry
  // makes exactly the same 101 requests against exactly the same store, and the product retries for
  // ever with no progress and no operator-facing line — the throw is a webhook item failure, not a
  // "this product cannot be imported" record.
  const roundTripsForTheWorstSupportedProduct = Math.ceil(MAX_WC_VARIATIONS_PER_PRODUCT / 10) + 1
  assert.ok(
    MAX_WC_VARIATION_PAGES >= roundTripsForTheWorstSupportedProduct,
    'precondition: the page ceiling must at least admit that product (asserted above too)',
  )

  // The allowance the budget implies for each of those round trips, named as a constant so the
  // relationship is a value rather than a division somebody has to spot.
  assert.equal(
    WC_VARIATION_PAGE_LATENCY_ALLOWANCE_MS,
    WC_VARIATION_FETCH_BUDGET_MS / MAX_WC_VARIATION_PAGES,
    'the allowance must be derived from the two constants, not chosen independently of them',
  )

  // One full second per variations page is the floor. Below that the walk is betting on a store
  // faster than most WooCommerce installs serve a 100-row collection, and losing the bet costs an
  // unimportable product that nothing reports.
  assert.ok(
    WC_VARIATION_PAGE_LATENCY_ALLOWANCE_MS >= 1_000,
    `${WC_VARIATION_FETCH_BUDGET_MS}ms across a ${MAX_WC_VARIATION_PAGES}-page ceiling leaves only `
    + `${WC_VARIATION_PAGE_LATENCY_ALLOWANCE_MS.toFixed(0)}ms per request. The largest supported product on `
    + 'the stingiest supported store cannot be fetched in that, so it would throw transiently and retry '
    + 'for ever with no progress and no operator signal. Raise WC_VARIATION_FETCH_BUDGET_MS with the '
    + 'ceilings, or lower MAX_WC_VARIATIONS_PER_PRODUCT.',
  )

  // And the budget must still fit under the reclaim window after any such rise — the invariant the
  // second test in this file owns. Restated as a dependency so raising the budget to satisfy the
  // assertion above cannot silently break that one.
  assert.ok(
    WC_VARIATION_FETCH_BUDGET_MS + WC_REQUEST_TIMEOUT_MS < getWcWebhookStaleProcessingMs({}),
    'raising the fetch budget must not push the worst case past the inbox reclaim window',
  )
})
