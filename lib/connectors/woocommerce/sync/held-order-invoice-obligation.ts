import { heldSalesInvoiceQueueWhere } from './held-sales-invoice'

/**
 * WHAT A REDELIVERY OF AN ALREADY-IMPORTED ORDER MUST FIND BEFORE IT MAY READ AS SUCCESS.
 *
 * When the sales invoice enqueue of the FIRST import throws, the importer parks the payload it built as a held sales invoice (the reconcile's release sweep enqueues it, through
 * the same enqueue and the same (order, number) idempotency key), and fails the import. If even the park fails, the failure text carries this marker. A later delivery of the
 * order takes the existing-order branch, which neither rebuilds nor queues an invoice (the first import owns the payload: tax treatment, store credit, FX), so what it can
 * and must do is refuse to call the order handled while an invoice failure is on record and nothing, not a held invoice and not a ledger row in ANY status, stands for it.
 * A row in any status means an attempt exists and is never re-queued from here.
 */
export const SALES_INVOICE_QUEUE_FAILED_NOT_HELD = '[sales-invoice-queue-failed-not-held]'

export type HeldOrderInvoiceObligationClient = {
  shoppingSyncLog: { findFirst: (args: { where: object; select: { id: true } }) => Promise<{ id: string } | null> }
  accountingSyncLog: { findFirst: (args: { where: object; select: { id: true } }) => Promise<{ id: string } | null> }
}

/** 'met': nothing failed, or the failure left a held invoice or a ledger row. 'unmet': an enqueue failure is on record and nothing will post this order's invoice. */
export async function heldOrderInvoiceObligation(
  client: HeldOrderInvoiceObligationClient,
  order: { orderId: string; wcOrderId: number | string },
): Promise<'met' | 'unmet'> {
  const failure = await client.shoppingSyncLog.findFirst({
    where: { connector: 'woocommerce', externalId: String(order.wcOrderId), errorMessage: { contains: SALES_INVOICE_QUEUE_FAILED_NOT_HELD } },
    select: { id: true },
  })
  if (!failure) return 'met'
  const ledgerRow = await client.accountingSyncLog.findFirst({
    where: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: order.orderId },
    select: { id: true },
  })
  if (ledgerRow) return 'met'
  const held = await client.shoppingSyncLog.findFirst({ where: heldSalesInvoiceQueueWhere({ salesOrderId: order.orderId }), select: { id: true } })
  return held ? 'met' : 'unmet'
}
