import {
  PURCHASE_ORDER_STATUSES,
  REFUND_STATUSES,
  SALES_ORDER_STATUSES,
  SHIPMENT_STATUSES,
  STOCK_TRANSFER_STATUSES,
  type PurchaseOrderStatus,
  type RefundStatus,
  type SalesOrderStatus,
  type ShipmentStatus,
  type StockTransferStatus,
} from './status-types'
import { canTransitionPurchaseOrder } from './purchase-order-state'
import { canTransitionRefund } from './refund-state'
import { canTransitionSalesOrder } from './sales-order-state'
import { canTransitionShipment } from './shipment-state'
import { canTransitionStockTransfer } from './stock-transfer-state'

export type WorkflowTransitionGuardResult =
  | { success: true }
  | { success: false; error: string }

function isKnownStatus<Status extends string>(
  statuses: readonly Status[],
  status: string,
): status is Status {
  return statuses.includes(status as Status)
}

function validateWorkflowTransition<Status extends string>(
  workflow: string,
  statuses: readonly Status[],
  from: string,
  to: string,
  canTransitionWorkflow: (from: Status, to: Status) => boolean,
): WorkflowTransitionGuardResult {
  if (!isKnownStatus(statuses, from)) {
    return { success: false, error: `Unknown current ${workflow} status: ${from}` }
  }
  if (!isKnownStatus(statuses, to)) {
    return { success: false, error: `Unknown target ${workflow} status: ${to}` }
  }
  if (!canTransitionWorkflow(from, to)) {
    return { success: false, error: `Cannot transition ${workflow} from ${from} to ${to}` }
  }
  return { success: true }
}

export function validateSalesOrderStatusTransition(
  from: string,
  to: string,
): WorkflowTransitionGuardResult {
  return validateWorkflowTransition<SalesOrderStatus>(
    'sales order',
    SALES_ORDER_STATUSES,
    from,
    to,
    canTransitionSalesOrder,
  )
}

export function validateShipmentStatusTransition(
  from: string,
  to: string,
): WorkflowTransitionGuardResult {
  return validateWorkflowTransition<ShipmentStatus>(
    'shipment',
    SHIPMENT_STATUSES,
    from,
    to,
    canTransitionShipment,
  )
}

export function validatePurchaseOrderStatusTransition(
  from: string,
  to: string,
): WorkflowTransitionGuardResult {
  return validateWorkflowTransition<PurchaseOrderStatus>(
    'purchase order',
    PURCHASE_ORDER_STATUSES,
    from,
    to,
    canTransitionPurchaseOrder,
  )
}

export function validateRefundStatusTransition(
  from: string,
  to: string,
): WorkflowTransitionGuardResult {
  return validateWorkflowTransition<RefundStatus>(
    'refund',
    REFUND_STATUSES,
    from,
    to,
    canTransitionRefund,
  )
}

export function validateStockTransferStatusTransition(
  from: string,
  to: string,
): WorkflowTransitionGuardResult {
  return validateWorkflowTransition<StockTransferStatus>(
    'stock transfer',
    STOCK_TRANSFER_STATUSES,
    from,
    to,
    canTransitionStockTransfer,
  )
}
