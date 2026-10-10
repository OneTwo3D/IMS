/**
 * AN ORDER WHOSE DISCOUNT IS NOT PROVEN CREDIT-FREE, OR THAT IS HELD FOR STORE-CREDIT REVIEW, IS NOT PUSHED.
 *
 * Store credit is a payment, so the warehouse must be told the FULL goods value (customs, IOSS). The
 * credit-aware import keeps credit out of `SalesOrder.discountAmount` and writes
 * `storeCreditAssessment = ASSESSED` in the creating write, so for those orders the pushed discount is
 * provably credit-free. A later delivery that shows credit (or a conflict about credit) the row does not
 * account for sets REVIEW_REQUIRED instead; the credit is never recorded after creation. A row that was
 * not created by the credit-aware import (NULL) and carries credit cannot be proven, so it fails closed.
 * The order is parked with this reason, visible to the operator, before anything is claimed or sent.
 */

import { toDecimal } from '@/lib/domain/math/decimal'

// Kept under the 300-character operator-text limit the WMS error scrubber applies, so it reaches the operator whole.
export const STORE_CREDIT_PUSH_WITHHELD_REASON =
  'Store credit order not proven credit-free, or held for store-credit review: the warehouse could be told a reduced goods '
  + 'value. NOT sent; nothing was sent. Create the warehouse order by hand at full value, or resolve the review first.'

/**
 * True when the order is held for store-credit review, or has store credit and was not created by the
 * credit-aware import (`storeCreditAssessment` ASSESSED is written only there, in the creating write). A row
 * with NULL fails CLOSED whenever credit is present, which is how legacy rows resolve. Fails closed on an
 * unreadable credit amount.
 */
export function storeCreditPushMustBeWithheld(order: { storeCreditForeign?: unknown; storeCreditAssessment?: unknown }): boolean {
  if (order.storeCreditAssessment === 'REVIEW_REQUIRED') return true
  const raw = order.storeCreditForeign
  if (raw === null || raw === undefined) return false
  let credit
  try {
    credit = toDecimal(raw as string | number)
  } catch {
    return true
  }
  if (credit.isFinite() && !credit.gt(0)) return false
  return order.storeCreditAssessment !== 'ASSESSED'
}
