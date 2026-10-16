/**
 * WAS THIS PAYMENT MADE AFTER THE ORDER WAS CANCELLED?
 *
 * Two different bookkeeping paths hang on the answer, and they must not be confused:
 *
 *   ACTIVE / CREDIT_NOTE_PATH  The order was active when the customer paid (or nothing says otherwise). If it
 *                              was cancelled afterwards, the invoice is credited and the payment is handled as
 *                              for any cancelled paid order. The payment registers exactly as it always has.
 *   AFTER_CANCELLATION         The invoice is void/cancelled and the money is real. In Xero that is an
 *                              OVERPAYMENT (a bank transaction), not a payment against the invoice: the
 *                              Payments endpoint refuses a payment on a voided or paid invoice, and refuses any
 *                              amount over what is outstanding. That path is NOT built yet, so such a payment
 *                              is held visibly rather than posted.
 *
 * THE RULE IS NARROW AND FAILS TOWARDS THE ORDINARY PATH. The payment is "after" only when BOTH instants are
 * known and the payment is STRICTLY later. A tie, a missing cancellation instant (an order cancelled before
 * the column existed) or a missing payment time all take the credit-note path, as the owner ruled.
 *
 * THE INSTANTS. `cancelledAt` is minted by the database clock (`sales_orders.cancelled_at`, a trigger), so it
 * cannot be moved by the writer that cancelled the order. `paidAt` is the receipt's own business date, entered
 * by an operator (and day-granular in practice), so it can be backdated: a backdated receipt reads as paid
 * while the order was active. That is the accepted weakness of comparing against a business date.
 */

export type PaymentTiming = 'ACTIVE' | 'CREDIT_NOTE_PATH' | 'AFTER_CANCELLATION'

export function paymentTimingAgainstCancellation(input: {
  orderStatus: string
  cancelledAt: Date | null
  paidAt: Date | null
}): PaymentTiming {
  if (input.orderStatus !== 'CANCELLED') return 'ACTIVE'
  if (input.cancelledAt === null || input.paidAt === null) return 'CREDIT_NOTE_PATH'
  const cancelled = input.cancelledAt.getTime()
  const paid = input.paidAt.getTime()
  if (Number.isNaN(cancelled) || Number.isNaN(paid)) return 'CREDIT_NOTE_PATH'
  return paid > cancelled ? 'AFTER_CANCELLATION' : 'CREDIT_NOTE_PATH'
}
