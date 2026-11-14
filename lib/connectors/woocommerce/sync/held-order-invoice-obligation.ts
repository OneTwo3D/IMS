import { heldSalesInvoiceQueueWhere } from './held-sales-invoice'

/**
 * WHAT A REDELIVERY OF AN ALREADY-IMPORTED ORDER MUST FIND BEFORE IT MAY READ AS SUCCESS.
 *
 * The first import OWES a sales invoice from the transaction that commits the order (`SalesOrder.salesInvoiceOwedAt`, set only when the import will invoice it) until the
 * transaction that queues the invoice, or parks it as a held invoice, clears it in the same commit. If the enqueue, the park and even the failure log all fail, the mark is
 * still set, with no marker text and no failure row to depend on. A later delivery takes the existing-order branch, which neither rebuilds nor queues an invoice (the first
 * import owns the payload: tax treatment, store credit, FX), so what it can and must do is refuse to call the order handled while the mark is set and nothing stands for the
 * invoice: neither a held invoice nor a SALES_INVOICE row in ANY status (an attempt that exists is never re-queued from here). Once one stands, the mark is cleared.
 * Orders imported before the column existed have it unset, so they behave exactly as before.
 */
export type HeldOrderInvoiceObligationClient = {
  salesOrder: {
    findUnique: (args: { where: { id: string }; select: { salesInvoiceOwedAt: true } }) => Promise<{ salesInvoiceOwedAt: Date | null } | null>
    updateMany: (args: { where: { id: string; salesInvoiceOwedAt: { not: null } }; data: { salesInvoiceOwedAt: null } }) => Promise<unknown>
  }
  shoppingSyncLog: { findFirst: (args: { where: object; select: { id: true } }) => Promise<{ id: string } | null> }
  accountingSyncLog: { findFirst: (args: { where: object; select: { id: true } }) => Promise<{ id: string } | null> }
}

/** 'met': nothing is owed, or an invoice obligation stands (and the mark is cleared). 'unmet': an invoice is owed and nothing stands for it. */
export async function heldOrderInvoiceObligation(
  client: HeldOrderInvoiceObligationClient,
  order: { orderId: string },
): Promise<'met' | 'unmet'> {
  const owed = await client.salesOrder.findUnique({ where: { id: order.orderId }, select: { salesInvoiceOwedAt: true } })
  if (!owed?.salesInvoiceOwedAt) return 'met'
  const ledgerRow = await client.accountingSyncLog.findFirst({
    where: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: order.orderId },
    select: { id: true },
  })
  const held = ledgerRow ? null : await client.shoppingSyncLog.findFirst({ where: heldSalesInvoiceQueueWhere({ salesOrderId: order.orderId }), select: { id: true } })
  if (!ledgerRow && !held) return 'unmet'
  await client.salesOrder.updateMany({ where: { id: order.orderId, salesInvoiceOwedAt: { not: null } }, data: { salesInvoiceOwedAt: null } })
  return 'met'
}
