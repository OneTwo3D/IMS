import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWcOrderLevelDiscount } from '@/lib/connectors/woocommerce/sync/field-mapping'

/**
 * WooCommerce allocates cart-coupon money INTO the line items: each line's `total` is already its
 * `subtotal` minus that line's share of every coupon, so mapWcLineItems carries the whole coupon as
 * per-line discountAmount. IMS's ORDER-LEVEL discountAmount slot means something different — a
 * discount that is NOT already in the lines (a native order's orderDiscountForeign, which is
 * deducted from the order total). Storing the coupon in both places double-counts it (o3d-y14).
 *
 * resolveWcOrderLevelDiscount is what keeps the two apart: the order-level slot gets only the
 * residual coupon money Woo left unallocated, which is normally exactly zero.
 */

test('a cart coupon fully allocated to the lines leaves NOTHING at order level', () => {
  // £100 of goods, £10 cart coupon: Woo reduces the line totals by £10 in total.
  const resolved = resolveWcOrderLevelDiscount({ couponTotalForeign: 10, lineDiscountTotalForeign: 10, currency: 'GBP' })
  assert.equal(resolved.orderLevelDiscount, 0)
  assert.equal(resolved.unallocated, 0)
})

test('a coupon split across several lines still nets to zero', () => {
  const resolved = resolveWcOrderLevelDiscount({ couponTotalForeign: 15, lineDiscountTotalForeign: 6.25 + 8.75, currency: 'GBP' })
  assert.equal(resolved.orderLevelDiscount, 0)
})

test('sub-penny allocation rounding does not leak a spurious order-level discount', () => {
  // Woo spreads a £10 coupon over 3 lines as 3.33 / 3.33 / 3.34 — or leaves a 0.0001 tail.
  const resolved = resolveWcOrderLevelDiscount({ couponTotalForeign: 10, lineDiscountTotalForeign: 9.9975, currency: 'GBP' })
  assert.equal(resolved.orderLevelDiscount, 0, 'anything under half a penny is allocation rounding, not a discount')
})

test('coupon money Woo did NOT put on any line survives as an order-level discount', () => {
  // The shape we do not model. It must not be silently dropped — dropping it would OVERSTATE the
  // invoice by exactly the amount the customer was not charged.
  const resolved = resolveWcOrderLevelDiscount({ couponTotalForeign: 10, lineDiscountTotalForeign: 0, currency: 'GBP' })
  assert.equal(resolved.orderLevelDiscount, 10)
  assert.equal(resolved.unallocated, 10, 'flagged so the caller can log an unmodelled coupon shape')
})

test('a partially allocated coupon keeps only the residual', () => {
  const resolved = resolveWcOrderLevelDiscount({ couponTotalForeign: 10, lineDiscountTotalForeign: 4, currency: 'GBP' })
  assert.equal(resolved.orderLevelDiscount, 6)
  assert.equal(resolved.unallocated, 6)
})

test('per-line markdowns bigger than the coupon never produce a NEGATIVE order-level discount', () => {
  // A sale price plus a coupon: the line discount legitimately exceeds the coupon total. A negative
  // order-level figure would post as a positive line on the invoice, INFLATING revenue.
  const resolved = resolveWcOrderLevelDiscount({ couponTotalForeign: 10, lineDiscountTotalForeign: 25, currency: 'GBP' })
  assert.equal(resolved.orderLevelDiscount, 0)
  assert.equal(resolved.unallocated, 0)
})

test('no coupons at all is zero, whatever the lines carry', () => {
  const resolved = resolveWcOrderLevelDiscount({ couponTotalForeign: 0, lineDiscountTotalForeign: 25, currency: 'GBP' })
  assert.equal(resolved.orderLevelDiscount, 0)
  assert.equal(resolved.unallocated, 0)
})

// --- o3d-5tf: the tolerance is half a MINOR UNIT, exclusive -----------------

test('o3d-5tf: a residual of exactly half a penny is RETAINED, because HALF_UP posts it as 0.01', () => {
  // The old `residual <= 0.005` discarded it, on a comment claiming such a residual "can never
  // round up to a posted 0.01". It does: 0.005 rounds HALF_UP to 0.01, so discarding it understated
  // the discount by a whole posted penny.
  const resolved = resolveWcOrderLevelDiscount({
    couponTotalForeign: 10,
    lineDiscountTotalForeign: 9.995,
    currency: 'GBP',
  })
  assert.equal(resolved.orderLevelDiscount, 0.005)
  assert.equal(resolved.unallocated, 0.005)
})

test('o3d-5tf: just under half a penny is still allocation rounding', () => {
  const resolved = resolveWcOrderLevelDiscount({
    couponTotalForeign: 10,
    lineDiscountTotalForeign: 9.9951,
    currency: 'GBP',
  })
  assert.equal(resolved.orderLevelDiscount, 0)
})

test('o3d-5tf: a 3-decimal currency does not lose whole minor units to the tolerance', () => {
  // KWD has 1000 fils to the dinar. 0.004 KWD is FOUR posted minor units of real customer discount;
  // the hard-coded 0.005 penny tolerance swallowed it silently.
  const resolved = resolveWcOrderLevelDiscount({
    couponTotalForeign: 10,
    lineDiscountTotalForeign: 9.996,
    currency: 'KWD',
  })
  assert.equal(resolved.orderLevelDiscount, 0.004)
  assert.equal(resolved.unallocated, 0.004)
  // Half of one fil is still rounding.
  assert.equal(
    resolveWcOrderLevelDiscount({ couponTotalForeign: 10, lineDiscountTotalForeign: 9.9996, currency: 'KWD' }).orderLevelDiscount,
    0,
  )
})

test('o3d-5tf: a 0-decimal currency treats sub-unit residuals as rounding', () => {
  // JPY has no subunit: 0.4 yen can never be posted, so it is allocation rounding — while the old
  // 0.005 tolerance would have kept it and put a fractional-yen discount on the invoice.
  const resolved = resolveWcOrderLevelDiscount({
    couponTotalForeign: 1000,
    lineDiscountTotalForeign: 999.6,
    currency: 'JPY',
  })
  assert.equal(resolved.orderLevelDiscount, 0)
  // A residual of exactly half a yen posts as 1 yen, so it is kept.
  assert.equal(
    resolveWcOrderLevelDiscount({ couponTotalForeign: 1000, lineDiscountTotalForeign: 999.5, currency: 'JPY' }).orderLevelDiscount,
    0.5,
  )
})
