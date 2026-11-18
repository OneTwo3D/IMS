/**
 * How much deferred (unearned) revenue a refund's UNEARNED_REV_REVERSAL takes out of the unearned account.
 *
 * The line-driven figure is what the refund's own lines were worth (unshipped quantity value plus non-quantity
 * revenue). On its own it leaves two remainders in Unearned that nothing will ever recognise:
 *
 *  - a refund that reaches the FULL threshold (99.9% of the net total) but not 100%. FULL orders are excluded from
 *    every later daily-batch window, so the uncovered sliver of the deferral stays for ever;
 *  - the shipping / discount share of an order whose unshipped remainder has just been refunded. Group B recognises
 *    that share pro rata on shipments and trues the rest up on the final dispatched shipment, but a refunded
 *    remainder produces no further shipment, so the share was never recognised.
 *
 * In both cases no later posting can release the balance, so the reversal sweeps it. `remainingUnearned` already nets
 * shipment recognition and earlier reversals, so the sweep can never exceed what is still deferred.
 */
export function resolveUnearnedReversal(params: {
  remainingUnearned: number
  lineDrivenRevenue: number
  isFullRefund: boolean
  /** True while any product line still has units that are neither shipped (journaled) nor refunded. */
  hasOutstandingUnshippedQty: boolean
}): number {
  const lineDriven = Math.min(
    params.remainingUnearned,
    Math.round(params.lineDrivenRevenue * 100) / 100,
  )
  if (params.isFullRefund) return Math.max(lineDriven, params.remainingUnearned)
  if (!params.hasOutstandingUnshippedQty) return Math.max(lineDriven, params.remainingUnearned)
  return lineDriven
}
