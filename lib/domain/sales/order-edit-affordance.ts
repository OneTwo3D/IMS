/**
 * WHEN A SALES ORDER CAN BE EDITED, AND WHY NOT (mirrors order-delete-affordance.ts).
 *
 * Owner ruling 2026-11-10: drafts are editable; a confirmed order is editable only after a warning that the edit desyncs it from WooCommerce; after dispatch only addresses and notes are editable (a line change
 * after dispatch goes through a refund or an added line).
 *
 *   DRAFT                                              full edit (lines, money, header). Nothing outside the order's own rows holds a copy of a draft.
 *   PENDING_PAYMENT / ON_HOLD / PROCESSING / ALLOCATED full edit. The server releases the order's stock reservations, rewrites the lines, re-reserves, queues an update of the posted invoice and lets the
 *   (and PICKING / PACKING while nothing is picked)    warehouse amendment pass pick the change up.
 *   SHIPPED / COMPLETED, or any order with a shipment  addresses and notes only.
 *   that has left the building
 *   DELIVERED, CANCELLED, or erased                    blocked.
 *
 * Both the server action and the order page call these functions, so the page can disable Edit with the reason the server would give. The server remains the authority: this predicts the refusal from data the
 * page already holds, it never grants an edit (the action re-reads every input under the order lock).
 *
 * What stays refused for a line edit whatever the status, because the rows are pointed at by something an edit would orphan: a refund against the order's lines, a return expectation, a shipment that is already picked or
 * packed (the warehouse holds that stock), an invoice that is queued but not yet posted (its payload would go out stale), a warehouse that is already picking an order it holds, and a shop fee line the order form cannot represent.
 */

export type SalesOrderEditBlockCode =
  | 'ERASED'
  | 'CANCELLED'
  | 'CLOSED'
  | 'DISPATCHED'
  | 'ACCOUNTING_INVOICE'
  | 'WMS_PUSH'
  | 'WMS_PICKING'
  | 'SHIPMENT'
  | 'PAYMENT'
  | 'STORE_CREDIT'
  | 'INVOICE_RECORD'
  | 'ACCOUNTING_SYNC'
  | 'INVOICE_NOT_POSTED'
  | 'REFUND'
  | 'RETURN_EXPECTATION'
  | 'ALLOCATION'
  | 'FEE_LINES'

export type SalesOrderEditBlock = {
  code: SalesOrderEditBlockCode
  /** Operator-facing sentence: what stops the edit. */
  reason: string
}

/** Statuses an order has once its goods have left (or are on their way): lines are no longer editable. */
const DISPATCHED_STATUSES: ReadonlySet<string> = new Set(['SHIPPED', 'COMPLETED'])

export type SalesOrderEditInput = {
  status: string
  /** How many stock allocations the order holds (any state). */
  allocations: number
  /** How many shipments exist for the order (any state). */
  shipments: number
  /** How many of those shipments are NOT a pending draft (picked, packed or shipped): the warehouse already holds that stock. Defaults to all of `shipments` for a caller that cannot tell. */
  committedShipments?: number
  /** How many shipments have been shipped (a partly shipped order is a dispatched order). */
  shippedShipments?: number
  /** Set once an invoice has been posted for the order in the accounting system. */
  accountingInvoiceId: string | null
  /** Whether a warehouse (WMS) push row exists for the order. */
  wmsPush: boolean
  /** Whether the order is linked to a shopping-connector (WooCommerce) order. Not a blocker: it makes the edit need the desync acknowledgement (see shopDesyncAcknowledgementRefusal). */
  hasExternalSource: boolean
  /** Whether the order's personal data was erased. */
  erased?: boolean
  /** How many refunds exist for the order, and its refund disposition: a refund line points at the order's line rows, which an edit replaces. */
  refunds?: number
  refundStatus?: string
  /**
   * Order-level money records a currency or total change would desync. addPayment accepts a DRAFT, and an imported/paid order carries `paidAt` with no Payment row.
   * For a DRAFT these refuse the edit; for a confirmed order the action instead refuses only an edit that changes the total or the currency (see paidOrderTotalChangeRefusal).
   */
  payments?: number
  paid?: boolean
  storeCreditForeign?: number
  invoiceRecords?: number
  accountingSyncLogs?: number
  /** How many return expectations exist (they hang off the refund lines). */
  returnExpectations?: number
  /** Whether an invoice for the order is queued (or failed) in the accounting system but has not posted: editing now would leave that queued document stale. */
  invoiceNotPosted?: boolean
  /** How many lines carry no product (a shop fee line: duty, handling): the order form folds fees into shipping and would change what the invoice posts. */
  productlessLines?: number
}

/** A dispatched order: lines are closed. */
export function isDispatchedForEdit(input: Pick<SalesOrderEditInput, 'status' | 'shippedShipments'>): boolean {
  return DISPATCHED_STATUSES.has(input.status) || (input.shippedShipments ?? 0) > 0
}

const DISPATCHED_LINES_REASON = 'This order has been dispatched, so its lines can no longer be edited. Edit its addresses and notes, or use Refund (or add a line) for a change to what was sent.'

/** The refusal common to both kinds of edit: an order that is gone, cancelled, closed or erased. Null when the order can still be changed at all. */
function terminalBlock(input: Pick<SalesOrderEditInput, 'status' | 'erased'>): SalesOrderEditBlock | null {
  if (input.erased) {
    return { code: 'ERASED', reason: 'This order\'s personal data has been erased, so it can no longer be edited.' }
  }
  if (input.status === 'CANCELLED') {
    return { code: 'CANCELLED', reason: 'This order is cancelled, so it can no longer be edited. Clone it to start a new order from its lines.' }
  }
  if (input.status === 'DELIVERED') {
    return { code: 'CLOSED', reason: 'This order is delivered and closed, so it can no longer be edited.' }
  }
  return null
}

/**
 * Why an order's LINES (and its money) cannot be edited, or null when they can. Used for the full edit; an address-and-notes edit uses resolveSalesOrderAddressEditBlock.
 */
export function resolveSalesOrderEditBlock(input: SalesOrderEditInput): SalesOrderEditBlock | null {
  const terminal = terminalBlock(input)
  if (terminal) return terminal
  if (isDispatchedForEdit(input)) return { code: 'DISPATCHED', reason: DISPATCHED_LINES_REASON }
  if ((input.refunds ?? 0) > 0 || (input.refundStatus ?? 'NONE') !== 'NONE') {
    return { code: 'REFUND', reason: 'This order has refunds recorded against its lines, so its lines can no longer be edited.' }
  }
  if ((input.returnExpectations ?? 0) > 0) {
    return { code: 'RETURN_EXPECTATION', reason: 'This order has return expectations recorded against its lines, so its lines can no longer be edited.' }
  }

  if (input.status === 'DRAFT') {
    // A draft is held by nothing else; any of these means it was not (or is no longer) such a draft.
    if (input.accountingInvoiceId) {
      return { code: 'ACCOUNTING_INVOICE', reason: 'An accounting invoice has already been posted for this order, so it can no longer be edited.' }
    }
    if (input.wmsPush) {
      return { code: 'WMS_PUSH', reason: 'This order has been sent to the warehouse, so it can no longer be edited.' }
    }
    if ((input.payments ?? 0) > 0 || input.paid) {
      return { code: 'PAYMENT', reason: 'A payment is recorded on this order, so it can no longer be edited: changing its currency or total would no longer match what was paid.' }
    }
    if ((input.storeCreditForeign ?? 0) > 0) {
      return { code: 'STORE_CREDIT', reason: 'Store credit has been applied to this order, so it can no longer be edited.' }
    }
    if ((input.invoiceRecords ?? 0) > 0) {
      return { code: 'INVOICE_RECORD', reason: 'An invoice number or invoice document has been generated for this order, so it can no longer be edited.' }
    }
    if ((input.accountingSyncLogs ?? 0) > 0) {
      return { code: 'ACCOUNTING_SYNC', reason: 'An accounting entry (invoice or payment registration) is queued or posted for this order, so it can no longer be edited.' }
    }
    if (input.shipments > 0) {
      return { code: 'SHIPMENT', reason: 'A shipment exists for this order, so it can no longer be edited.' }
    }
    if (input.allocations > 0) {
      return { code: 'ALLOCATION', reason: 'Stock is allocated to this order, so it can no longer be edited.' }
    }
    return null
  }

  // A confirmed (pre-dispatch) order: stock is released and re-reserved, the posted invoice is updated and the warehouse order amended, so allocation, a warehouse push, a posted invoice and a shop link are not blockers.
  const committed = input.committedShipments ?? input.shipments
  if (committed > 0) {
    return {
      code: 'SHIPMENT',
      reason: 'Stock for this order has already been picked or packed into a shipment, so its lines can no longer be edited. Reopen the shipment for repack, or cancel the order and create a new one.',
    }
  }
  if (input.invoiceNotPosted && !input.accountingInvoiceId) {
    return {
      code: 'INVOICE_NOT_POSTED',
      reason: 'This order\'s invoice is queued for the accounting system but has not been posted yet, so it cannot be edited until it has been (the edit would have to change a document that has not been sent). Try again shortly.',
    }
  }
  if ((input.status === 'PICKING' || input.status === 'PACKING') && input.wmsPush) {
    return { code: 'WMS_PICKING', reason: 'The warehouse is already picking this order, so its lines can no longer be edited here: the warehouse cannot amend an order that has moved past new. Edit its addresses and notes, or cancel it.' }
  }
  if ((input.productlessLines ?? 0) > 0) {
    return { code: 'FEE_LINES', reason: 'This order has fee lines from the shop (for example duty or handling) that the order form cannot represent, so its lines cannot be edited here. Edit its addresses and notes, or use Refund.' }
  }
  return null
}

/** Why an order's addresses and notes cannot be edited, or null when they can. Possible in every status except cancelled, delivered (closed) and erased. */
export function resolveSalesOrderAddressEditBlock(input: Pick<SalesOrderEditInput, 'status' | 'erased'>): SalesOrderEditBlock | null {
  return terminalBlock(input)
}

/**
 * What the order page offers: the full edit, the dispatched-order address-and-notes edit, or nothing. One decision, so the page never offers an edit the server refuses on status alone.
 */
export function resolveSalesOrderEditScope(input: SalesOrderEditInput): { scope: 'FULL' | 'ADDRESS_NOTES' | 'NONE'; block: SalesOrderEditBlock | null } {
  const lines = resolveSalesOrderEditBlock(input)
  if (!lines) return { scope: 'FULL', block: null }
  const address = resolveSalesOrderAddressEditBlock(input)
  if (!address && lines.code !== 'ERASED') return { scope: 'ADDRESS_NOTES', block: lines }
  return { scope: 'NONE', block: address ?? lines }
}

/** The warning the operator confirms before an edit of an order that came from the shop. The server refuses without the matching acknowledgement. */
export const SHOP_DESYNC_WARNING =
  'This order came from WooCommerce. Editing it in IMS will not change it in WooCommerce: WooCommerce keeps the original order, so the two will no longer match. '
  + 'Later changes made in WooCommerce will not overwrite the addresses, notes or shipping you edit here, and IMS will not report the difference as a WooCommerce edit.'

export const SHOP_DESYNC_REFUSAL = 'This order is linked to a WooCommerce order. Editing it here does not reach WooCommerce (WooCommerce keeps the original), so the edit must be acknowledged first. Nothing was changed.'

/** Null when the edit may proceed; otherwise the refusal. A linked order needs `acknowledged === true` exactly (a truthy string or a missing flag does not count). */
export function shopDesyncAcknowledgementRefusal(hasExternalSource: boolean, acknowledged: unknown): string | null {
  if (!hasExternalSource) return null
  return acknowledged === true ? null : SHOP_DESYNC_REFUSAL
}

/**
 * A confirmed order that already carries money (a payment, the paid flag, applied store credit) can be edited only if the edit leaves its currency and total exactly as they were: the payment and the posted invoice
 * were made for that amount. Null when the edit is allowed.
 */
export function paidOrderTotalChangeRefusal(input: {
  status: string
  payments: number
  paid: boolean
  storeCreditForeign: number
  currencyBefore: string
  currencyAfter: string
  totalBefore: number
  totalAfter: number
}): string | null {
  if (input.status === 'DRAFT') return null
  if (!(input.payments > 0 || input.paid || input.storeCreditForeign > 0)) return null
  if (input.currencyBefore === input.currencyAfter && Math.round(input.totalBefore * 10000) === Math.round(input.totalAfter * 10000)) return null
  return `A payment or store credit is recorded on this order, so an edit must leave its total (${input.totalBefore.toFixed(2)} ${input.currencyBefore}) and currency unchanged; this one would make it ${input.totalAfter.toFixed(2)} ${input.currencyAfter}. Nothing was changed.`
}
