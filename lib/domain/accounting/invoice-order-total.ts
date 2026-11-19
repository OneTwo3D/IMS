import { invoiceToReverse } from '@/lib/domain/accounting/eu-vat-credit-note'
import { LEDGER_STANDING_SELECT, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'

/**
 * o3d-hqvrp.389: whether a credit note that FULLY reverses an invoice carries the order total follows HOW THE INVOICE WAS POSTED, never the setting's current value.
 * An invoice posted with `xero_round_to_order_total_enabled` on carries a Rounding line and totals the order total; one posted with it off totals the per-line figure. A credit
 * note raised after the setting was flipped must still match the invoice it clears, in both directions. The invoice's own payload (the sync row that posted it, which keeps
 * `orderTotal` even though it is not part of the posting key) is the record of that.
 */
export interface InvoiceSyncRowReader {
  accountingSyncLog: {
    findMany(args: {
      where: { referenceType: 'SalesOrder'; referenceId: string; type: { in: Array<'SALES_INVOICE' | 'SALES_INVOICE_UPDATE'> } }
      select: typeof LEDGER_STANDING_SELECT & { createdAt: true; payload: true }
    }): Promise<Array<LedgerStandingRow & { createdAt: Date; payload: unknown }>>
  }
}

/**
 * The order total of the invoice VERSION XERO HOLDS; null when it carried none (posted per line) or when which version Xero holds is not known.
 * The version is chosen by `invoiceToReverse`, the same rule a whole-order reversal uses: the newest row not proven unposted must be CONFIRMED_POSTED. A newer queued, failed-unknown
 * or cancelled-unproven row is never read from, and when the newest version's standing is unknown nothing is carried (the credit note posts per line, which can differ by pennies).
 */
export async function invoicePostedOrderTotal(client: InvoiceSyncRowReader, orderId: string): Promise<number | null> {
  const rows = await client.accountingSyncLog.findMany({
    where: { referenceType: 'SalesOrder', referenceId: orderId, type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] } },
    select: { ...LEDGER_STANDING_SELECT, createdAt: true, payload: true },
  })
  const picked = invoiceToReverse(rows)
  if (!picked.ok) return null
  const payload = picked.payload
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
