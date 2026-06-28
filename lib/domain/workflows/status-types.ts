export const SALES_ORDER_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'ON_HOLD',
  'PROCESSING',
  'ALLOCATED',
  'PICKING',
  'PACKING',
  'SHIPPED',
  'COMPLETED',
  'DELIVERED',
  'CANCELLED',
] as const

export type SalesOrderStatus = typeof SALES_ORDER_STATUSES[number]

export const SHIPMENT_STATUSES = [
  'PENDING',
  'PICKING',
  'PACKED',
  'SHIPPED',
] as const

export type ShipmentStatus = typeof SHIPMENT_STATUSES[number]

export const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'RFQ_SENT',
  'QUOTE_RECEIVED',
  'PO_SENT',
  'SHIPPED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'INVOICED',
  'PARTIALLY_RETURNED',
  'RETURNED',
  'CANCELLED',
] as const

export type PurchaseOrderStatus = typeof PURCHASE_ORDER_STATUSES[number]

export const STOCK_TRANSFER_STATUSES = [
  'DRAFT',
  'IN_TRANSIT',
  'RECEIVED',
  'CANCELLED',
] as const

export type StockTransferStatus = typeof STOCK_TRANSFER_STATUSES[number]

// Refunds do not currently have a persisted status column. These values model
// the derived lifecycle already implied by SalesOrderRefund, accounting sync,
// and refund payments.
export const REFUND_STATUSES = [
  'RECORDED',
  'CREDIT_NOTE_SYNCED',
  'PAID',
] as const

export type RefundStatus = typeof REFUND_STATUSES[number]

export type WorkflowTransitions<Status extends string> = {
  readonly [Key in Status]: readonly Status[]
}

export class WorkflowTransitionError extends Error {
  constructor(workflow: string, from: string, to: string) {
    super(`Cannot transition ${workflow} from ${from} to ${to}`)
    this.name = 'WorkflowTransitionError'
  }
}

export function canTransition<Status extends string>(
  transitions: WorkflowTransitions<Status>,
  from: Status,
  to: Status,
): boolean {
  return transitions[from].includes(to)
}

export function assertTransition<Status extends string>(
  workflow: string,
  transitions: WorkflowTransitions<Status>,
  from: Status,
  to: Status,
): void {
  if (!canTransition(transitions, from, to)) {
    throw new WorkflowTransitionError(workflow, from, to)
  }
}
