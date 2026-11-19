/**
 * o3d-hqvrp.389: whether a credit note that FULLY reverses an invoice carries the order total follows HOW THE INVOICE WAS POSTED, never the setting's current value.
 * An invoice posted with `xero_round_to_order_total_enabled` on carries a Rounding line and totals the order total; one posted with it off totals the per-line figure. A credit
 * note raised after the setting was flipped must still match the invoice it clears, in both directions. The invoice's own payload (the sync row that posted it, which keeps
 * `orderTotal` even though it is not part of the posting key) is the record of that.
 */
export interface InvoiceSyncRowReader {
  accountingSyncLog: {
    findFirst(args: {
      where: { referenceType: 'SalesOrder'; referenceId: string; type: { in: Array<'SALES_INVOICE' | 'SALES_INVOICE_UPDATE'> }; status: { in: Array<'SYNCED' | 'PENDING' | 'PROCESSING'> } }
      orderBy: Array<{ createdAt: 'desc' }>
      select: { payload: true }
    }): Promise<{ payload: unknown } | null>
  }
}

/** The order total the order's invoice was (or is queued to be) posted with; null when it carried none (the invoice was posted per line). */
export async function invoicePostedOrderTotal(client: InvoiceSyncRowReader, orderId: string): Promise<number | null> {
  // The latest invoice document row decides: an update re-posts the whole document, so the newest SYNCED row is what the ledger holds; a newer queued row is what it is about to hold.
  const row = await client.accountingSyncLog.findFirst({
    where: { referenceType: 'SalesOrder', referenceId: orderId, type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] }, status: { in: ['SYNCED', 'PENDING', 'PROCESSING'] } },
    orderBy: [{ createdAt: 'desc' }],
    select: { payload: true },
  })
  const payload = row?.payload
  if (!payload || typeof payload !== 'object') return null
  const total = (payload as { orderTotal?: unknown }).orderTotal
  return typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null
}

/** The `orderTotal` a credit note carries: the invoice's own, and only when this refund is the order's single FULL refund or a chargeback. A partial refund never carries one. */
export async function fullReversalOrderTotal(
  client: InvoiceSyncRowReader,
  orderId: string,
  order: { refundStatus: string; refunds: Array<{ id: string; chargeback: boolean }> } | null,
  refundId: string,
): Promise<{ orderTotal?: number }> {
  if (!order) return {}
  const only = order.refunds.length === 1 && order.refunds[0]!.id === refundId ? order.refunds[0]! : null
  if (!only || !(only.chargeback || order.refundStatus === 'FULL')) return {}
  const total = await invoicePostedOrderTotal(client, orderId)
  return total == null ? {} : { orderTotal: total }
}
