import { endOfBusinessDateUtc, isMissingFxRateError, MissingFxRateError } from '@/lib/currencies/fx-select'

/**
 * o3d-q0x56.19 - THE SETTLEMENT RATE OF AN IMPORTED WOOCOMMERCE RECEIPT (owner ruling 2026-10-25).
 *
 * WHICH DATE IS THE PAYMENT DATE. WooCommerce's `date_paid_gmt` (the GMT form, not the site-local `date_paid`):
 * the importer stores it as `Payment.paidAt` / `SalesOrder.paidAt`, and the Xero follow-up sends its first ten
 * characters (the UTC calendar date) as the payment date. WooCommerce writes it WITHOUT a zone suffix, so it is read
 * as UTC explicitly, never in the server's local zone. The order's date is `date_created_gmt` the same way
 * (`date_created` only when the GMT form is absent). An order with no `date_paid_gmt` has no receipt at all
 * (`importedReceipt` in order-import.ts), so this module is never reached for it.
 *
 * THE RULE (one date rule, the repo's: the UTC calendar date, a business date maps to the end of that day):
 *  - base currency: no settlement rate (null), as before;
 *  - the payment's UTC calendar date equals the order's: the receipt keeps the order's own booked rate;
 *  - any other day (in practice a later one: bank transfer, pay-later, B2B on account): the central rate as of the end of
 *    the payment's business day (`getFxRateToBase(asOf = endOfBusinessDateUtc(paidAt))`);
 *  - no usable rate for that day: refused as `foreign_payment_missing_rate`. The order's rate is never a fallback.
 *    The refusal is a MissingFxRateError, so the existing pending-FX queue holds the order and retries it after the
 *    next rate refresh; nothing is written meanwhile.
 */

/** WooCommerce GMT timestamps carry no zone suffix; read them as UTC. */
export function parseWcGmtInstant(value: string): Date {
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`)
}

export function utcCalendarDate(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}

/**
 * THE SAME-DAY TEST, the importer's own and the reconciliation pack's (R16 holds a posted receipt to it): the receipt keeps the order's booked rate only when
 * the payment's UTC calendar date equals the order's. An unknown order instant (null) is never "the same day".
 */
export function receiptOnOrderDay(orderedAt: Date | null, paidAt: Date): boolean {
  return orderedAt !== null && utcCalendarDate(paidAt) === utcCalendarDate(orderedAt)
}

export type WcReceiptRateLookup = (currency: string, asOf: Date) => Promise<number>

export async function resolveWcReceiptSettlementRate(params: {
  currency: string
  baseCurrency: string
  /** The instant the order was priced at (its `date_created_gmt`; now when it has none). */
  orderedAt: Date | null
  /** The order's own booked rate (1 base = X foreign). */
  orderRate: number
  /** WooCommerce `date_paid_gmt`. */
  datePaidGmt: string
  lookup: WcReceiptRateLookup
}): Promise<number | null> {
  const currency = params.currency.trim().toUpperCase()
  if (currency === params.baseCurrency.trim().toUpperCase()) return null
  const paidAt = parseWcGmtInstant(params.datePaidGmt)
  if (Number.isNaN(paidAt.getTime())) {
    throw new MissingFxRateError(
      `foreign_payment_missing_rate: the payment date ${JSON.stringify(params.datePaidGmt)} is not a readable date`,
      currency, undefined, 'invalid_as_of',
    )
  }
  // no known order instant is never "the same day": the payment-day central rate is used
  if (receiptOnOrderDay(params.orderedAt, paidAt)) return params.orderRate
  const asOf = endOfBusinessDateUtc(paidAt)
  try {
    return await params.lookup(currency, asOf)
  } catch (error) {
    if (!isMissingFxRateError(error)) throw error
    throw new MissingFxRateError(
      `foreign_payment_missing_rate: ${error.message} (the payment was made on ${utcCalendarDate(paidAt)}, a different day from the order; the order's rate is not used for it)`,
      error.currency, error.asOf ?? asOf, error.reason, error.baseCurrency,
    )
  }
}
