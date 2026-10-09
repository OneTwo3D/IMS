/**
 * AN ORDER WHOSE DISCOUNT MAY STILL CONTAIN ITS STORE CREDIT IS NOT PUSHED TO THE WAREHOUSE.
 *
 * Store credit is a payment, so the warehouse must be told the FULL goods value (customs, IOSS). The
 * importer keeps credit out of `SalesOrder.discountAmount` and stamps `discountModel = LINE_ALLOCATED` in the
 * same write, so for those orders the pushed discount is provably credit-free.
 *
 * An order that IMS held BEFORE credit was recorded separately is different. When it is re-read, the credit
 * is recorded beside it (no retrospective data fixes), but its `discountAmount` was written by the old
 * importer, which folded the credit in, and nothing on the row says how much. Pushing that discount as
 * `DiscountTotalExVat` would tell the warehouse a reduced goods value, so the push is WITHHELD instead: the
 * order is parked with this reason, visible to the operator, before anything is claimed or sent.
 */

import { toDecimal } from '@/lib/domain/math/decimal'

/** The model stamp that proves `discountAmount` holds only a genuine coupon residual. */
export const CREDIT_FREE_DISCOUNT_MODEL = 'LINE_ALLOCATED'

// Kept under the 300-character operator-text limit the WMS error scrubber applies, so it reaches the operator whole.
export const STORE_CREDIT_PUSH_WITHHELD_REASON =
  'Store credit order, discount not proven credit-free: its discount predates separate credit recording, so the warehouse '
  + 'would be told a reduced goods value. NOT sent; nothing was sent. Create the warehouse order by hand at full value, or restate the order first.'

/** True when the order has store credit and its discount cannot be proven credit-free. Fails closed on an unreadable credit. */
export function storeCreditPushMustBeWithheld(order: { storeCreditForeign?: unknown; discountModel?: unknown }): boolean {
  const raw = order.storeCreditForeign
  if (raw === null || raw === undefined) return false
  let credit
  try {
    credit = toDecimal(raw as string | number)
  } catch {
    return true
  }
  if (credit.isFinite() && !credit.gt(0)) return false
  return order.discountModel !== CREDIT_FREE_DISCOUNT_MODEL
}
