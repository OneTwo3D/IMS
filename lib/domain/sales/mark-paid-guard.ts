/**
 * When `markSalesOrderPaid` must refuse. It is a manual flag with no Payment row behind it, so: never on a draft or cancelled order, and the OFF direction only clears the flag while no receipt exists (the marker is no longer required: legacy paid flags with no payments can be cleared) — clearing `paidAt` over real receipts would leave IMS "unpaid" against a settled ledger and make every further receipt an over-payment.
 */
export function markPaidRefusal(o: { status: string; markingAsPaid: boolean; hasUnregisteredPaidMarker: boolean; paymentCount: number }): string | null {
  if (o.status === 'DRAFT' || o.status === 'CANCELLED') {
    return `A ${o.status === 'DRAFT' ? 'draft' : 'cancelled'} order cannot be marked as paid or unpaid.`
  }
  if (!o.markingAsPaid) {
    if (o.paymentCount > 0) return 'This order has recorded payments, so it cannot be marked unpaid. Delete the payment instead.'
    // An order flagged paid before the `unregisteredPaidAt` marker existed has a paid flag and no Payment rows. With no receipt behind it, clearing the flag is safe whether or not the marker is set, so the paid flag with no payments is the legacy signal (`paymentCount === 0` here).
  }
  return null
}
