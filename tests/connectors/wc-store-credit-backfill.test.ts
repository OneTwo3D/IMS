import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WC_COUPON_DISCOUNT_MODEL,
  decideWcCouponBackfill,
  type WcCouponBackfillRow,
} from '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'

/**
 * The o3d-y14 coupon backfill reads only STORED columns (`discountAmount`, the line discounts, the
 * import provenance); it never sees the WooCommerce payload, so it cannot tell store credit from a
 * discount. What it can and must guarantee is MONOTONICITY: it only ever CLEARS order-level discount
 * that the lines also carry, so it can never restate store credit back INTO a discount.
 */

const CUTOFF = new Date('2026-07-25T14:00:00.000Z')

function row(over: Partial<WcCouponBackfillRow> = {}): WcCouponBackfillRow {
  return {
    orderId: 'order-1',
    orderNumber: 'WC-1001',
    externalOrderNumber: '1001',
    currency: 'GBP',
    storedOrderDiscount: 0,
    lineDiscountTotal: 0,
    accountingInvoiceId: null,
    postedInvoiceExternalIds: [],
    discountModel: null,
    importedAt: new Date('2026-05-01T00:00:00.000Z'),
    alreadyBackfilled: false,
    liveInvoiceJobs: 0,
    revenueDeferredBatchRef: null,
    refunds: { disposition: 'NONE', refundIds: [], postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: [] },
    liveBatchDeferralJobs: 0,
    ...over,
  }
}

function precondition(name: string, facts: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION ${name}: ${JSON.stringify(facts)}`)
}

test('an order imported by the store-credit-aware importer (discount 0, credit in its own column) is never touched', () => {
  const decision = decideWcCouponBackfill(
    row({ storedOrderDiscount: 0, lineDiscountTotal: 0, discountModel: WC_COUPON_DISCOUNT_MODEL, importedAt: new Date('2026-10-09T00:00:00.000Z') }),
    { importedBefore: CUTOFF },
  )
  precondition('post-fix credit order', { storedOrderDiscount: 0, discountModel: WC_COUPON_DISCOUNT_MODEL })
  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'POST_FIX_IMPORT')
})

test('a LEGACY credit-only order (credit stored as discount, nothing on the lines) is left exactly as it is, never corrected', () => {
  const decision = decideWcCouponBackfill(row({ storedOrderDiscount: 12, lineDiscountTotal: 0 }), { importedBefore: CUTOFF })
  precondition('legacy credit-only', { storedOrderDiscount: 12, lineDiscountTotal: 0, discountModel: null })
  assert.equal(decision.action, 'SKIP')
  assert.equal(decision.action === 'SKIP' && decision.reason, 'NOTHING_DUPLICATED')
})

test('a LEGACY mixed order clears only the duplicated coupon: what remains is never larger than what was stored', () => {
  // 5 of percentage coupon (also on the lines) + 10 of credit stored as discount = 15.
  const decision = decideWcCouponBackfill(row({ storedOrderDiscount: 15, lineDiscountTotal: 5 }), { importedBefore: CUTOFF })
  precondition('legacy mixed', { storedOrderDiscount: 15, lineDiscountTotal: 5 })
  assert.equal(decision.action, 'CORRECT')
  if (decision.action !== 'CORRECT') return
  assert.equal(decision.clearedBy, 5)
  assert.equal(decision.keptOrderLevel, 10, 'the credit portion is carried through unchanged, never grown')
  assert.ok(decision.keptOrderLevel <= decision.couponTotal)
})
