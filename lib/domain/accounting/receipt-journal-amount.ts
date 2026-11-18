import { roundQuantity, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * The amount a STOCK_RECEIPT journal should post for a receipt of this value, or null when no journal is owed.
 *
 * The journal lines are written at 2dp, so the question "is there anything to post" has to be asked of the
 * ROUNDED amount. A receipt whose value is positive but under half a penny (a near-free component costed at
 * 0.001) rounds to 0.00; gating on the unrounded value queued a debit-0 / credit-0 manual journal that Xero
 * rejects or books as noise. Both receipt writers (the manual receipt and the WMS book-in) use this one rule so
 * they cannot diverge.
 */
export function receiptJournalAmount(receiptValueBase: DecimalInput): number | null {
  const amount = roundQuantity(receiptValueBase, 2).toNumber()
  return amount > 0 ? amount : null
}
