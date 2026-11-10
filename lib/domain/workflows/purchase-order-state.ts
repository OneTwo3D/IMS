import {
  assertTransition,
  canTransition,
  type PurchaseOrderStatus,
  type WorkflowTransitions,
} from './status-types'

export const PURCHASE_ORDER_TRANSITIONS = {
  DRAFT: ['RFQ_SENT', 'PO_SENT', 'CANCELLED'],
  RFQ_SENT: ['QUOTE_RECEIVED', 'PO_SENT', 'CLOSED', 'CANCELLED'],
  QUOTE_RECEIVED: ['PO_SENT', 'CLOSED', 'CANCELLED'],
  PO_SENT: ['SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED', 'CANCELLED'],
  SHIPPED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED', 'CANCELLED'],
  RECEIVED: ['INVOICED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED'],
  CLOSED: [],
  INVOICED: ['PARTIALLY_RETURNED', 'RETURNED', 'CLOSED'],
  // PARTIALLY_RECEIVED / CLOSED / CANCELLED: a return that left a balance outstanding used to strand the order here
  // (nothing could receive, close or cancel it). A return now keeps such an order PARTIALLY_RECEIVED; these exits
  // are for orders already stranded and for the nothing-outstanding case.
  PARTIALLY_RETURNED: ['RETURNED', 'PARTIALLY_RECEIVED', 'CLOSED', 'CANCELLED'],
  RETURNED: [],
  CANCELLED: [],
} as const satisfies WorkflowTransitions<PurchaseOrderStatus>

export function canTransitionPurchaseOrder(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): boolean {
  return canTransition(PURCHASE_ORDER_TRANSITIONS, from, to)
}

export function assertPurchaseOrderTransition(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): void {
  assertTransition('purchase order', PURCHASE_ORDER_TRANSITIONS, from, to)
}
