import {
  assertTransition,
  canTransition,
  type PurchaseOrderStatus,
  type WorkflowTransitions,
} from './status-types'

export const PURCHASE_ORDER_TRANSITIONS = {
  DRAFT: ['RFQ_SENT', 'PO_SENT', 'CANCELLED'],
  RFQ_SENT: ['QUOTE_RECEIVED', 'PO_SENT', 'CLOSED'],
  QUOTE_RECEIVED: ['PO_SENT', 'CLOSED'],
  PO_SENT: ['SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED'],
  SHIPPED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED'],
  RECEIVED: ['PARTIALLY_RETURNED', 'RETURNED', 'CLOSED'],
  CLOSED: [],
  INVOICED: ['PARTIALLY_RETURNED', 'RETURNED', 'CLOSED'],
  PARTIALLY_RETURNED: ['RETURNED'],
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
