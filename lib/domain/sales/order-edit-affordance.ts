/**
 * WHEN A SALES ORDER CAN BE EDITED, AND WHY NOT (mirrors order-delete-affordance.ts).
 *
 * `updateSalesOrder` rewrites an order's header and replaces its lines. That is only safe while nothing outside this order's own rows has taken a copy of it: a DRAFT order is not invoiced, not
 * allocated, not pushed to the warehouse and not shipped, so a rewrite changes nothing anyone else holds. A confirmed order has a queued/posted SALES_INVOICE (queueSalesInvoiceForOrder runs on create and
 * on finalisation), stock allocations and a WMS push, and an order imported from a shopping connector is mirrored from WooCommerce by webhooks that would overwrite an IMS edit. Editing those needs the
 * invoice-update path, reallocation and a warehouse amendment (and, for a Woo order, the owner-ruled warning that the edit desyncs it from WooCommerce): not built, so every one of those refuses here.
 *
 * Both the server action and the order page call this one function, so the page can disable Edit with the reason the server would give. The server remains the authority: this predicts the refusal from
 * data the page already holds, it never grants an edit (the action re-reads every input under the order lock).
 */

export type SalesOrderEditBlockCode =
  | 'ERASED'
  | 'NOT_DRAFT'
  | 'EXTERNAL_SOURCE'
  | 'ACCOUNTING_INVOICE'
  | 'WMS_PUSH'
  | 'SHIPMENT'
  | 'ALLOCATION'

export type SalesOrderEditBlock = {
  code: SalesOrderEditBlockCode
  /** Operator-facing sentence: what stops the edit. */
  reason: string
}

export function resolveSalesOrderEditBlock(input: {
  status: string
  /** How many stock allocations the order holds (any state). */
  allocations: number
  /** How many shipments exist for the order (any state). */
  shipments: number
  /** Set once an invoice has been posted for the order in the accounting system. */
  accountingInvoiceId: string | null
  /** Whether a warehouse (WMS) push row exists for the order. */
  wmsPush: boolean
  /** Whether the order is linked to a shopping-connector (WooCommerce) order. */
  hasExternalSource: boolean
  /** Whether the order's personal data was erased. */
  erased?: boolean
}): SalesOrderEditBlock | null {
  if (input.erased) {
    return { code: 'ERASED', reason: 'This order\'s personal data has been erased, so it can no longer be edited.' }
  }
  if (input.status !== 'DRAFT') {
    return {
      code: 'NOT_DRAFT',
      reason: 'Only draft orders can be edited. A confirmed order has an invoice queued or posted, reserved stock and a warehouse push that an edit would have to amend; editing confirmed orders is not available yet. '
        + 'Edit notes from the order page, or cancel the order and create a new one.',
    }
  }
  if (input.hasExternalSource) {
    return { code: 'EXTERNAL_SOURCE', reason: 'This order is linked to a WooCommerce order, which mirrors its state onto it, so an edit here could be overwritten. Change it in WooCommerce.' }
  }
  if (input.accountingInvoiceId) {
    return { code: 'ACCOUNTING_INVOICE', reason: 'An accounting invoice has already been posted for this order, so it can no longer be edited.' }
  }
  if (input.wmsPush) {
    return { code: 'WMS_PUSH', reason: 'This order has been sent to the warehouse, so it can no longer be edited.' }
  }
  if (input.shipments > 0) {
    return { code: 'SHIPMENT', reason: 'A shipment exists for this order, so it can no longer be edited.' }
  }
  if (input.allocations > 0) {
    return { code: 'ALLOCATION', reason: 'Stock is allocated to this order, so it can no longer be edited.' }
  }
  return null
}
