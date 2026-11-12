import {
  assertTransition,
  canTransition,
  type SalesOrderStatus,
  type WorkflowTransitions,
} from './status-types'

export const SALES_ORDER_TRANSITIONS = {
  DRAFT: ['PROCESSING', 'PENDING_PAYMENT', 'ALLOCATED', 'CANCELLED', 'ON_HOLD'],
  PENDING_PAYMENT: ['PROCESSING', 'DRAFT', 'ALLOCATED', 'CANCELLED', 'ON_HOLD'],
  ON_HOLD: ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'CANCELLED'],
  PROCESSING: ['ALLOCATED', 'CANCELLED', 'ON_HOLD'],
  ALLOCATED: ['PICKING', 'PROCESSING', 'SHIPPED', 'CANCELLED', 'ON_HOLD'],
  PICKING: ['PACKING', 'SHIPPED', 'CANCELLED', 'ON_HOLD'],
  PACKING: ['SHIPPED', 'CANCELLED', 'ON_HOLD'],
  SHIPPED: ['COMPLETED', 'DELIVERED'],
  COMPLETED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
} as const satisfies WorkflowTransitions<SalesOrderStatus>

export function canTransitionSalesOrder(
  from: SalesOrderStatus,
  to: SalesOrderStatus,
): boolean {
  return canTransition(SALES_ORDER_TRANSITIONS, from, to)
}

export function assertSalesOrderTransition(
  from: SalesOrderStatus,
  to: SalesOrderStatus,
): void {
  assertTransition('sales order', SALES_ORDER_TRANSITIONS, from, to)
}

/**
 * Order statuses in which an in-app dispatch is refused: the order is not ready to ship, and shipping it
 * would silently finalise a draft, clear an operator's hold or bypass payment.
 */
export const ORDER_STATUSES_NOT_READY_TO_DISPATCH: ReadonlySet<string> = new Set(['DRAFT', 'ON_HOLD', 'PENDING_PAYMENT'])

export function orderNotReadyToDispatchMessage(status: string): string {
  switch (status) {
    case 'DRAFT':
      return 'This order is still a draft, so its shipments cannot be dispatched. Finalise the draft, then dispatch again.'
    case 'ON_HOLD':
      return 'This order is on hold, so its shipments cannot be dispatched. Release the hold, then dispatch again.'
    case 'PENDING_PAYMENT':
      return 'This order is waiting for payment, so its shipments cannot be dispatched. Record the payment, then dispatch again.'
    default:
      return `This order is ${status}, so its shipments cannot be dispatched.`
  }
}

/**
 * How an order whose every shipment has left reaches SHIPPED.
 *
 * `SALES_ORDER_TRANSITIONS` has a direct ->SHIPPED edge only from ALLOCATED, PICKING and PACKING. An order
 * still in PROCESSING (ready to fulfil, not yet allocated) is promoted by the same legal route an operator
 * would take, through ALLOCATED; `viaAllocated` says so the caller can leave a trace. DRAFT, ON_HOLD and
 * PENDING_PAYMENT are never promoted by a dispatch (an in-app dispatch is refused for them, and a
 * warehouse-reported one is recorded without touching the order). Anything else is refused.
 */
export function resolveShippedPromotion(
  from: SalesOrderStatus,
): { success: true; viaAllocated: boolean } | { success: false; error: string } {
  if (!(from in SALES_ORDER_TRANSITIONS)) {
    return { success: false, error: `Cannot transition sales order from ${from} to SHIPPED` }
  }
  if (canTransitionSalesOrder(from, 'SHIPPED')) return { success: true, viaAllocated: false }
  // Only PROCESSING is "ready to fulfil" without a direct edge. DRAFT, ON_HOLD and PENDING_PAYMENT are
  // deliberately NOT routed through ALLOCATED: a dispatch must not finalise a draft, clear a hold or
  // stand in for a payment (see `ORDER_STATUSES_NOT_READY_TO_DISPATCH`).
  if (from === 'PROCESSING' && canTransitionSalesOrder(from, 'ALLOCATED') && canTransitionSalesOrder('ALLOCATED', 'SHIPPED')) {
    return { success: true, viaAllocated: true }
  }
  return { success: false, error: `Cannot transition sales order from ${from} to SHIPPED` }
}
