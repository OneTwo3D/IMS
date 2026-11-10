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
 * How an order whose every shipment has left the building reaches SHIPPED.
 *
 * `SALES_ORDER_TRANSITIONS` has a direct ->SHIPPED edge only from ALLOCATED, PICKING and PACKING. An
 * order parked in ON_HOLD, PROCESSING, DRAFT or PENDING_PAYMENT can still have a shipment dispatched
 * (shipment transitions do not look at those statuses), and when it does the goods are gone: the
 * only truthful outcome is SHIPPED, reached by the same legal route an operator would take, through
 * ALLOCATED. `viaAllocated` says the direct edge was absent so the caller can leave a trace.
 * Anything with no route at all (an unknown status) is refused.
 */
export function resolveShippedPromotion(
  from: SalesOrderStatus,
): { success: true; viaAllocated: boolean } | { success: false; error: string } {
  if (!(from in SALES_ORDER_TRANSITIONS)) {
    return { success: false, error: `Cannot transition sales order from ${from} to SHIPPED` }
  }
  if (canTransitionSalesOrder(from, 'SHIPPED')) return { success: true, viaAllocated: false }
  if (canTransitionSalesOrder(from, 'ALLOCATED') && canTransitionSalesOrder('ALLOCATED', 'SHIPPED')) {
    return { success: true, viaAllocated: true }
  }
  return { success: false, error: `Cannot transition sales order from ${from} to SHIPPED` }
}
