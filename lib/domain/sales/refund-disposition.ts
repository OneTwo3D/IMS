/**
 * Refund disposition is the orthogonal refund dimension of a sales order
 * (NONE / PARTIAL / FULL), stored on `SalesOrder.refundStatus`. While the legacy
 * `status` lifecycle still carries PARTIALLY_REFUNDED/REFUNDED, this helper derives
 * the disposition from a status value so every site that writes a refund status to
 * `status` keeps `refundStatus` consistent (dual-write). Later epic stages move
 * consumers onto `refundStatus` and stop encoding refund state in `status`.
 */
export type RefundDisposition = 'NONE' | 'PARTIAL' | 'FULL'

export function refundDispositionForStatus(status: string): RefundDisposition {
  if (status === 'REFUNDED') return 'FULL'
  if (status === 'PARTIALLY_REFUNDED') return 'PARTIAL'
  return 'NONE'
}
