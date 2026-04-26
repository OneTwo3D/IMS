import {
  assertTransition,
  canTransition,
  type SalesOrderStatus,
  type WorkflowTransitions,
} from './status-types'

export const SALES_ORDER_TRANSITIONS = {
  DRAFT: ['PROCESSING', 'PENDING_PAYMENT', 'CANCELLED', 'ON_HOLD'],
  PENDING_PAYMENT: ['PROCESSING', 'DRAFT', 'CANCELLED', 'ON_HOLD'],
  ON_HOLD: ['DRAFT', 'PROCESSING', 'CANCELLED'],
  PROCESSING: ['ALLOCATED', 'CANCELLED', 'ON_HOLD'],
  ALLOCATED: ['PICKING', 'PROCESSING', 'CANCELLED', 'ON_HOLD'],
  PICKING: ['PACKING', 'CANCELLED', 'ON_HOLD'],
  PACKING: ['SHIPPED', 'CANCELLED', 'ON_HOLD'],
  SHIPPED: ['COMPLETED'],
  COMPLETED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: [],
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
