import {
  assertTransition,
  canTransition,
  type SalesOrderStatus,
  type WorkflowTransitions,
} from './status-types'

export const SALES_ORDER_TRANSITIONS = {
  DRAFT: ['PROCESSING', 'PENDING_PAYMENT', 'ALLOCATED', 'CANCELLED', 'ON_HOLD', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  PENDING_PAYMENT: ['PROCESSING', 'DRAFT', 'ALLOCATED', 'CANCELLED', 'ON_HOLD', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  ON_HOLD: ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  PROCESSING: ['ALLOCATED', 'CANCELLED', 'ON_HOLD', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  ALLOCATED: ['PICKING', 'PROCESSING', 'SHIPPED', 'CANCELLED', 'ON_HOLD', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  PICKING: ['PACKING', 'SHIPPED', 'CANCELLED', 'ON_HOLD', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  PACKING: ['SHIPPED', 'CANCELLED', 'ON_HOLD', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  SHIPPED: ['COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  COMPLETED: ['DELIVERED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  DELIVERED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: ['REFUNDED'],
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
