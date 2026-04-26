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

export function validateManualSalesOrderStatusTransition(
  from: string,
  to: string,
  options: { bypass?: boolean } = {},
): WorkflowTransitionGuardResult {
  if (options.bypass) return { success: true }

  if (to === 'PARTIALLY_REFUNDED' || to === 'REFUNDED') {
    return {
      success: false,
      error: 'Use the refund workflow to update refund status.',
    }
  }

  return validateSalesOrderStatusTransition(from, to)
}

export function validateRefundSalesOrderStatusUpdate(
  from: string,
  to: string,
): WorkflowTransitionGuardResult {
  if (from === to) return { success: true }
  return validateSalesOrderStatusTransition(from, to)
}

export function validateLinkedFreightReceiptStatus(
  status: string,
): WorkflowTransitionGuardResult {
  if (!isKnownStatus(PURCHASE_ORDER_STATUSES, status)) {
    return { success: false, error: `Unknown current purchase order status: ${status}` }
  }
  if (['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(status)) {
    return { success: true }
  }
  return {
    success: false,
    error: `Cannot mark linked freight purchase order as received from ${status}`,
  }
}

export function validatePurchaseReceiptStatusUpdate(
  from: string,
  to: string,
): WorkflowTransitionGuardResult {
  if (from === 'PARTIALLY_RECEIVED' && to === 'PARTIALLY_RECEIVED') return { success: true }
  return validatePurchaseOrderStatusTransition(from, to)
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
