import type { WmsOrderStatus } from '@/lib/connectors/wms/types'

/**
 * The category of the order-level exception row raised when the WAREHOUSE has put an order IMS still treats as live into a terminal status
 * that is not a despatch (cancelled, deleted, voided, rejected). IMS never acts on it by itself: whether to cancel the order, release its
 * stock, refund it or re-send it is a business decision. It is stored in wms_order_discrepancies.category (free text, so no migration).
 */
export const WMS_TERMINAL_NON_DESPATCH_CATEGORY = 'CANCELLED_IN_WMS'

/**
 * Pure test: does this WMS status read as TERMINAL and NOT a despatch? A completed word is required, and in-flight or failed forms
 * ("Cancel Requested", "Cancellation Failed", "Cancel Pending") are rejected, because those orders may still fulfil.
 */
export function isWmsTerminalNonDespatchStatus(status: Pick<WmsOrderStatus, 'status' | 'statusLabel'>): boolean {
  const combined = `${status.status ?? ''} ${status.statusLabel ?? ''}`
  return /\b(cancell?ed|deleted|voided?|rejected)\b/i.test(combined) && !/request|fail|pending/i.test(combined)
}
