import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-ves4's REFUND PAGER TESTS, AND WHY THEY ARE NOT HERE ANY MORE.
 *
 * This file used to exercise a pager o3d-ves4 built on this branch: `readWcOrderRefunds`, a
 * `WcRefundPageFetch` injected as a dependency, exported `WC_REFUND_PAGE_SIZE` /
 * `WC_REFUND_MAX_PAGES`, and a `syncRefundsForOrder(id, { fetchPage, syncRefund })` overload. That
 * branch's own commit message anticipated this moment — it noted the shape "match[es] the sibling
 * branch's ... with a note to collapse onto one reader when both land".
 *
 * They have both landed. o3d-ecbj (PR #636) rebuilt the pager on `development`, and its rule wins:
 * ONLY AN EMPTY PAGE ENDS THE WALK. `per_page` is a request and not a grant, so a short page proves
 * nothing; and because `wcFetch` parses a missing `x-wp-totalpages` as `1`, a store that SAID
 * NOTHING is indistinguishable from one that SAID ONE PAGE, so a reported page count cannot end a
 * walk either. Neither the injected-fetch surface nor the exported constants survived that rebuild,
 * so every test below tested an API that no longer exists.
 *
 * ONE OF THEM DID NOT MERELY GO STALE — IT BECAME WRONG. "an order with a single page of refunds
 * reads exactly ONE page and is complete" asserted the precise inference o3d-ecbj removed: under
 * the rule that only an empty page proves an ending, a single page of refunds costs TWO requests,
 * and a walk that stopped after one would be the original truncation defect reinstated. Re-pointing
 * that assertion at the new reader would have re-asserted the bug.
 *
 * The other five were re-proved on `development` rather than lost. The map is below, and it is
 * ASSERTED rather than written down and trusted: if a replacement is renamed or deleted, this fails
 * and names the coverage that went with it. That is the whole job this file still has.
 *
 * The o3d-ves4 behaviour that was NOT purely a pager concern — that a short read must reach its
 * CALLERS, so a webhook is not acknowledged and an import cursor does not advance over an order
 * whose refunds were only partly read — is unaffected and lives where it always did, in
 * lib/connectors/woocommerce/webhooks.ts and lib/connectors/woocommerce/sync/order-import.ts.
 */

/** Each retired assertion, and the test on `development` that now carries it. */
const SUPERSEDED: Array<{ retired: string; by: string; file: string }> = [
  {
    retired: 'syncRefundsForOrder asks for 100 per page and walks EVERY reported page',
    by: 'each page is asked for at the maximum size, so the ten-per-page default is never taken',
    file: 'tests/wc-refund-sweep-pagination.test.ts',
  },
  {
    retired: 'a refund on the SECOND page is imported, not read as absent',
    by: 'an order with more than ten refunds yields ALL of them, not the first page',
    file: 'tests/wc-refund-sweep-pagination.test.ts',
  },
  {
    retired: 'past the page bound the read refuses to claim completeness — and says so permanently',
    by: 'a list that never ends stops at the page ceiling and says the read is INCOMPLETE',
    file: 'tests/wc-refund-sweep-pagination-motion.test.ts',
  },
  {
    retired: 'a mid-walk fetch error reports incomplete and RETRYABLE, keeping the pages already read',
    by: 'a page that fails returns the refunds already read AND says it failed',
    file: 'tests/wc-refund-sweep-pagination.test.ts',
  },
  {
    retired: 'a non-list response is incomplete, not an empty set of refunds',
    by: 'an order the store says HAS refunds but serves none is incomplete, not empty',
    file: 'tests/wc-refund-sweep-pagination-motion.test.ts',
  },
]

test('every retired o3d-ves4 paging assertion is carried by a live test on development', () => {
  const missing: string[] = []
  for (const entry of SUPERSEDED) {
    const source = readFileSync(path.join(process.cwd(), entry.file), 'utf8')
    if (!source.includes(entry.by)) missing.push(`${entry.file}: ${entry.by} (retired: ${entry.retired})`)
  }
  assert.deepEqual(missing, [], [
    'o3d-ves4 retired these paging assertions because o3d-ecbj (PR #636) replaced the pager they',
    'tested. Each was retired ONLY because a named replacement covers it. A replacement has been',
    'renamed or deleted, so that coverage is now gone — restore it, or re-prove the retired',
    'assertion against the current reader.',
  ].join(' '))
})

test('the branch-local pager o3d-ves4 built is really gone, so nothing still tests a dead API', () => {
  // The point of collapsing onto one reader is that there is ONE. If a merge ever reintroduced the
  // injected-fetch pager beside development's, the two would page by different rules — and the
  // whole defect class here is a caller that cannot tell a short read from a complete one.
  const source = readFileSync(
    path.join(process.cwd(), 'lib/connectors/woocommerce/sync/refund-sync.ts'),
    'utf8',
  )
  for (const symbol of ['readWcOrderRefunds', 'WcRefundPageFetch', 'SyncRefundsForOrderResult']) {
    assert.ok(
      !source.includes(symbol),
      `${symbol} is o3d-ves4's superseded pager surface — development's fetchAllWcRefundsForOrder is the one reader`,
    )
  }
  assert.ok(
    source.includes('fetchAllWcRefundsForOrder'),
    'development’s reader must be the one that is present',
  )
})
