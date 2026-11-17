/**
 * The one-step manual status flow offered on a sales order.
 *
 * Shared by the order page's workflow button and the sales-order list's bulk "Advance status", so
 * both read the same table. Statuses that are absent (ALLOCATED, PICKING, PACKING) advance through
 * the shipment workflow, not through a button; ON_HOLD, DELIVERED and CANCELLED have no next step.
 */

import type { SalesOrderStatus } from './../workflows/status-types'

export type StatusFlowAction = { label: string; target: SalesOrderStatus }

export const STATUS_FLOW: Readonly<Record<string, readonly StatusFlowAction[]>> = {
  DRAFT: [{ label: 'Process', target: 'PROCESSING' }],
  PENDING_PAYMENT: [{ label: 'Process', target: 'PROCESSING' }],
  PROCESSING: [{ label: 'Allocate', target: 'ALLOCATED' }],
  SHIPPED: [{ label: 'Complete', target: 'COMPLETED' }],
  COMPLETED: [{ label: 'Delivered', target: 'DELIVERED' }],
}

/** The workflow actions the order page shows for a status (Delivered only once delivery tracking is on). */
export function nextStatusActions(status: string, deliveryTrackingEnabled: boolean): StatusFlowAction[] {
  return (STATUS_FLOW[status] ?? []).filter((a) => a.target !== 'DELIVERED' || deliveryTrackingEnabled)
}
