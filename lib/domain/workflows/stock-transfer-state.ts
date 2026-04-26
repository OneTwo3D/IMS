import {
  assertTransition,
  canTransition,
  type StockTransferStatus,
  type WorkflowTransitions,
} from './status-types'

export const STOCK_TRANSFER_TRANSITIONS = {
  DRAFT: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: [],
  CANCELLED: [],
} as const satisfies WorkflowTransitions<StockTransferStatus>

export function canTransitionStockTransfer(
  from: StockTransferStatus,
  to: StockTransferStatus,
): boolean {
  return canTransition(STOCK_TRANSFER_TRANSITIONS, from, to)
}

export function assertStockTransferTransition(
  from: StockTransferStatus,
  to: StockTransferStatus,
): void {
  assertTransition('stock transfer', STOCK_TRANSFER_TRANSITIONS, from, to)
}
