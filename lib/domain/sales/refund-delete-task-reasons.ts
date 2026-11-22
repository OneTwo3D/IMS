/**
 * #1132 R2-LOW-6: the operator task reasons the refund delete raises. They are about Xero and IMS, never a warehouse query: Sync > Exceptions lists
 * them in their own section, and marking one done changes nothing in Xero, the warehouse or the refund. Kept in a module of its own so the
 * listing, the done action and the delete (which closes them when the refund is finally deleted) share one list without importing the service.
 */
export const REFUND_DELETE_TASK_REASONS = ['REFUND_DELETE_VOIDED_NOT_UNWOUND', 'REFUND_DELETE_VOID_STUCK'] as const
export type RefundDeleteTaskReason = (typeof REFUND_DELETE_TASK_REASONS)[number]

export function isRefundDeleteTaskReason(reason: string): reason is RefundDeleteTaskReason {
  return (REFUND_DELETE_TASK_REASONS as readonly string[]).includes(reason)
}
