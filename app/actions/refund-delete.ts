'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync } from '@/lib/shopping'
import { evaluateRefundDeletion, deleteSalesOrderRefund } from '@/lib/domain/sales/refund-delete-service'
import { REFUND_DELETE_SETTING, refundDeleteEnabledFromSetting, type RefundDeleteRefusal } from '@/lib/domain/sales/refund-delete-policy'

/**
 * o3d-ngmt.22: delete a refund recorded in error. The refund permission (`sales.refund`) gates both the question and the act, the same key
 * that records a refund. All the rules live in lib/domain/sales/refund-delete-service.ts; this file is the authenticated edge: permission,
 * the post-commit follow-ups (re-reserving the order, the storefront stock push), and the activity row for a refusal.
 */

export type RefundDeleteEligibility = {
  enabled: boolean
  /** Per refund id: eligible, or the reasons it is not. Empty unless the switch is on, because while it is off the page shows no delete control at all. */
  refunds: Record<string, { eligible: boolean; refusals: RefundDeleteRefusal[] }>
}

export async function getRefundDeleteEligibility(orderId: string): Promise<RefundDeleteEligibility> {
  await requirePermission('sales.refund')
  const setting = await db.setting.findUnique({ where: { key: REFUND_DELETE_SETTING }, select: { value: true } })
  if (!refundDeleteEnabledFromSetting(setting?.value)) return { enabled: false, refunds: {} }
  const refunds = await db.salesOrderRefund.findMany({ where: { orderId }, select: { id: true } })
  const out: RefundDeleteEligibility['refunds'] = {}
  for (const refund of refunds) {
    const verdict = await evaluateRefundDeletion(db, refund.id)
    out[refund.id] = { eligible: verdict.eligible, refusals: verdict.refusals }
  }
  return { enabled: true, refunds: out }
}

export async function deleteRefund(
  refundId: string,
  reason?: string,
): Promise<{ success: boolean; pending?: boolean; error?: string; refusals?: RefundDeleteRefusal[]; warning?: string }> {
  const session = await requirePermission('sales.refund')
  const trimmed = (reason ?? '').trim().slice(0, 500)
  const result = await deleteSalesOrderRefund(db, { refundId, actorUserId: session.user.id ?? null, reason: trimmed || null })
  if (!result.success) {
    return { success: false, error: result.error, refusals: result.refusals }
  }
  const orderId = result.orderId
  // A refund whose credit note was posted is deleted in two steps: the void is queued now and the refund is removed once the accounting system confirms it.
  if (result.pending) {
    if (orderId) revalidatePath(`/sales/${orderId}`)
    return { success: true, pending: true }
  }
  if (result.alreadyDeleted) {
    if (orderId) revalidatePath(`/sales/${orderId}`)
    return { success: true }
  }

  let warning: string | undefined
  // The reservation the refund gave back is taken again for the order's remaining demand. Best effort and after the commit, exactly as the
  // refund's own release is: the delete is already durable, and an order that cannot be re-reserved (a shipment exists, stock is short) is
  // reported rather than failing a committed delete.
  if (orderId) {
    try {
      // Limited to PROCESSING / ALLOCATED, like the refund's own release: a delete must not promote a draft or unpaid order to allocated.
      const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      if (order && (order.status === 'PROCESSING' || order.status === 'ALLOCATED')) {
        const { autoAllocateOrder } = await import('./allocation')
        const allocated = await autoAllocateOrder(orderId, { internalBypassToken: INTERNAL_ACTION_BYPASS, refuseIfShipmentsExist: true })
        if (!allocated.success) {
          warning = `The refund was deleted. The order's stock could not be re-reserved automatically${allocated.error ? ` (${allocated.error})` : ''}; allocate it from the order page.`
        }
      }
    } catch {
      warning = 'The refund was deleted. The order\'s stock could not be re-reserved automatically; allocate it from the order page.'
    }
  }
  if (result.productIds.length > 0) {
    try {
      await enqueueStockSync(result.productIds, 'IMS_CHANGE')
    } catch {
      warning = [warning, 'The stock change could not be queued for the storefront; it will go with the next stock sync.'].filter(Boolean).join(' ')
    }
  }
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'refund_delete_follow_up',
    tag: 'sales',
    level: warning ? 'WARNING' : 'INFO',
    description: warning ?? 'Refund deleted; the order was re-reserved and the stock change queued.',
    metadata: { refundId },
  })
  if (orderId) {
    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
  }
  return { success: true, ...(warning ? { warning } : {}) }
}
