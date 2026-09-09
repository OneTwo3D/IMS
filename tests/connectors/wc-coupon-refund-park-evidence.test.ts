import assert from 'node:assert/strict'
import test from 'node:test'

import { readWcCouponRefundParks } from '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'
import { shoppingSyncLogFake, type ShoppingSyncLogRow } from '../helpers/shopping-sync-log-fake'

/**
 * o3d-272i — THE COPY THAT WAS SIMPLY WRONG.
 *
 * Three of the four hand-written copies of the pre-`recordKind` refund-park predicate matched a
 * defensible SET and only described it badly. This one did not: it is the coupon correction's
 * REFUND EVIDENCE, and `wcCouponCorrectionNeedsLedgerAdjustment` classifies the handoff on it. A
 * held sales invoice (o3d-k26m.6) writes the same connector, direction, `SalesOrder` and an
 * actionable status, so an order with NO REFUND AT ALL — only an invoice waiting for its number —
 * reported refund evidence that does not exist, and was routed to a human on the strength of it.
 *
 * The reader has no protective role, so pointing it at `activeRefundParkWhere()` is the whole fix.
 *
 * The fake evaluates the predicate it is handed (tests/helpers/shopping-sync-log-fake.ts), so these
 * assertions are about what the reader ASKS FOR.
 */

const ORDER = 'order-1'

async function parksFor(rows: ShoppingSyncLogRow[]): Promise<string[]> {
  const client = { shoppingSyncLog: shoppingSyncLogFake(rows) }
  return readWcCouponRefundParks(client as never, ORDER)
}

test('o3d-272i: a genuine park on the order is refund evidence', async () => {
  // PRECONDITION. Without this the exclusion assertions below would pass over a reader that returns
  // nothing at all.
  assert.deepEqual(
    await parksFor([
      { id: 'park-1', entityId: ORDER, externalId: '7001' },
      { id: 'park-2', entityId: ORDER, externalId: '7002', status: 'QUARANTINED' },
    ]),
    ['7001', '7002'],
  )
})

test('o3d-272i: a HELD SALES INVOICE on the order is not refund evidence', async () => {
  // MUTATION ROUTE: drop `recordKind` from `activeRefundParkWhere()`, or put the old five-clause
  // literal back into WC_COUPON_REFUND_PARK_WHERE. The hold is returned as a park again and this
  // fails — which is the bug, in the smallest form it can be stated.
  assert.deepEqual(
    await parksFor([{ id: 'hold-1', entityId: ORDER, externalId: '9001', recordKind: 'WC_HELD_SALES_INVOICE' }]),
    [],
    'an invoice waiting for its number is not a refund that has not been resolved',
  )
})

test('o3d-272i: parks on other orders, settled parks and unstamped rows are all excluded', async () => {
  assert.deepEqual(
    await parksFor([
      { id: 'other-order', entityId: 'order-2', externalId: '7100' },
      { id: 'settled', entityId: ORDER, externalId: '7101', status: 'SYNCED' },
      { id: 'unstamped', entityId: ORDER, externalId: '7102', recordKind: null },
      // The clause this reader keeps ON TOP of the shared predicate: it returns externalIds as the
      // evidence, so a park without one would contribute a null to that list.
      { id: 'no-external-id', entityId: ORDER, externalId: null },
    ]),
    [],
  )
})
