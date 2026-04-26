import {
  assertTransition,
  canTransition,
  type RefundStatus,
  type WorkflowTransitions,
} from './status-types'

export const REFUND_TRANSITIONS = {
  RECORDED: ['CREDIT_NOTE_SYNCED', 'PAID'],
  CREDIT_NOTE_SYNCED: ['PAID'],
  PAID: [],
} as const satisfies WorkflowTransitions<RefundStatus>

export function canTransitionRefund(
  from: RefundStatus,
  to: RefundStatus,
): boolean {
  return canTransition(REFUND_TRANSITIONS, from, to)
}

export function assertRefundTransition(
  from: RefundStatus,
  to: RefundStatus,
): void {
  assertTransition('refund', REFUND_TRANSITIONS, from, to)
}
