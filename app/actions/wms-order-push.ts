'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'

/**
 * Read + recovery surface for the outbound WMS order push (Phase 8). Reads the
 * connector-agnostic WmsOrderPushLink; the replay action re-queues a
 * dead-lettered push for the next sweep. Connector-agnostic.
 */

export type WmsOrderPushStateView = {
  state: string
  externalOrderNumber: string | null
  attempts: number
  lastError: string | null
  pushedAt: string | null
  /** Dead-lettered pushes can be re-queued by an operator. */
  canRetry: boolean
}

export async function getWmsOrderPushStateForSalesOrder(salesOrderId: string): Promise<WmsOrderPushStateView | null> {
  await requireAuth()
  const link = await db.wmsOrderPushLink.findUnique({
    where: { orderId: salesOrderId },
    select: { state: true, externalOrderNumber: true, attempts: true, lastError: true, pushedAt: true },
  })
  if (!link) return null
  return {
    state: link.state,
    externalOrderNumber: link.externalOrderNumber,
    attempts: link.attempts,
    lastError: link.lastError,
    pushedAt: link.pushedAt?.toISOString() ?? null,
    canRetry: link.state === 'DEAD_LETTER',
  }
}

export async function replayWmsOrderPush(salesOrderId: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sync')
  const link = await db.wmsOrderPushLink.findUnique({
    where: { orderId: salesOrderId },
    select: { id: true, state: true },
  })
  if (!link) return { success: false, error: 'No WMS push record for this order.' }
  if (link.state !== 'DEAD_LETTER') return { success: false, error: 'Only dead-lettered pushes can be re-queued.' }

  // Re-queue for the next sweep. The sweep's eligibility (ready + paid + bound)
  // still applies, so a no-longer-eligible order simply won't re-push.
  await db.wmsOrderPushLink.update({
    where: { id: link.id },
    data: { state: 'PENDING_CREATE', attempts: 0, lastError: null },
  })
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: salesOrderId,
    action: 'wms_push_replay',
    tag: 'sync',
    level: 'INFO',
    description: 'Re-queued a dead-lettered WMS order push for retry',
  })
  revalidatePath(`/sales/${salesOrderId}`)
  return { success: true }
}
