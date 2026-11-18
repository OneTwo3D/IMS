/**
 * When `markSalesOrderPaid` must refuse. It is a manual flag with no Payment row behind it, so: never on a draft or cancelled order, and the OFF direction only clears a flag that this control itself set
 * (`unregisteredPaidAt`) and only while no receipt exists — clearing `paidAt` over real receipts would leave IMS "unpaid" against a settled ledger and make every further receipt an over-payment.
 */
export function markPaidRefusal(o: { status: string; markingAsPaid: boolean; hasUnregisteredPaidMarker: boolean; paymentCount: number }): string | null {
  if (o.status === 'DRAFT' || o.status === 'CANCELLED') {
    return `A ${o.status === 'DRAFT' ? 'draft' : 'cancelled'} order cannot be marked as paid or unpaid.`
  }
  if (!o.markingAsPaid) {
    if (o.paymentCount > 0) return 'This order has recorded payments, so it cannot be marked unpaid. Delete the payment instead.'
    if (!o.hasUnregisteredPaidMarker) return 'This order\u2019s paid state did not come from marking it paid, so it cannot be cleared here.'
  }
  return null
}
