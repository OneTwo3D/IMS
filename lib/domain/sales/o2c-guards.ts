// ---------------------------------------------------------------------------
// Order-to-cash guard predicates (audit-M-o2c)
//
// Small pure helpers for the order-to-cash medium-gap fixes, extracted so the
// numeric/threshold logic is unit-testable without a database.
// ---------------------------------------------------------------------------

export type SalesOrderStatusName = string

/** Fixed rounding slack for the cumulative-refund-vs-total check (a hair over a penny). */
export const REFUND_TOTAL_EPSILON = 0.011

/**
 * Statuses that have advanced past payment. An order in one of these that is no
 * longer fully paid (e.g. after deleting its last payment) is a status/payment
 * mismatch worth surfacing.
 */
export const PAID_EXPECTED_SALES_STATUSES: ReadonlySet<string> = new Set([
  'SHIPPED',
  'COMPLETED',
  'DELIVERED',
])

/**
 * Whether recording `thisRefund` on top of `previouslyRefunded` would push the
 * cumulative refunded amount past the order total (within a fixed rounding
 * epsilon). Cumulative — not per-refund — so N partial refunds can't each creep
 * over a relative slack.
 */
export function refundWouldExceedOrderTotal(
  thisRefund: number,
  previouslyRefunded: number,
  orderTotal: number,
  epsilon: number = REFUND_TOTAL_EPSILON,
): boolean {
  return thisRefund + previouslyRefunded > orderTotal + epsilon
}

/** Whether an order that just became not-fully-paid is in a status that expected payment. */
export function isPaymentStatusMismatch(status: string, becameUnpaid: boolean): boolean {
  return becameUnpaid && PAID_EXPECTED_SALES_STATUSES.has(status)
}
