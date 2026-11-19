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
 * In both cases no later posting can release the balance, so the reversal sweeps it. The sweep reads `sweepableUnearned`,
 * which the caller derives only from durable facts (the order's deferral stamp, shipment recognition stamps and each
 * earlier refund's own recorded reversal) and which is 0 when those cannot be established; sync-log rows are not a
 * source because retention deletes them. `remainingUnearned` still caps the line-driven figure.
 */
export function resolveUnearnedReversal(params: {
  remainingUnearned: number
  /** What the sweep may take, from durable sources only; 0 when the open balance cannot be proved. */
  sweepableUnearned: number
  lineDrivenRevenue: number
  isFullRefund: boolean
  /** True while any product line still has units that are neither shipped (journaled) nor refunded. */
  hasOutstandingUnshippedQty: boolean
}): number {
  const lineDriven = Math.min(
    params.remainingUnearned,
    Math.round(params.lineDrivenRevenue * 100) / 100,
  )
  if (params.isFullRefund) return Math.max(lineDriven, Math.min(params.remainingUnearned, params.sweepableUnearned))
  if (!params.hasOutstandingUnshippedQty) return Math.max(lineDriven, Math.min(params.remainingUnearned, params.sweepableUnearned))
  return lineDriven
}
