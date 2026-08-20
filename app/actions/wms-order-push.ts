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
    select: { id: true, state: true, externalOrderId: true },
  })
  if (!link) return { success: false, error: 'No WMS push record for this order.' }
  // o3d-92fu: a payload-invalid push has nothing to re-queue. Re-queueing would set
  // PENDING_CREATE, the next sweep would fail to build the payload again and park it straight
  // back — and in between the order would be undeletable again, because PENDING_CREATE blocks
  // the hard-delete guard and VALIDATION_FAILED (at zero remote attempts) deliberately does
  // not. The sweep's revalidation pass re-queues it automatically once the data is fixed.
  if (link.state === 'VALIDATION_FAILED') {
    return {
      success: false,
      error: 'This order could not be turned into a WMS payload at all (see the error on the push chip) — '
        + 'nothing was sent, so there is nothing to replay. Fix the order data and the push sweep re-queues it by itself.',
    }
  }
  if (link.state !== 'DEAD_LETTER') return { success: false, error: 'Only dead-lettered pushes can be re-queued.' }
  // o3d-bjc.8: a dead letter that still carries an external id is not a failed
  // create — it is an order that EXISTS in the WMS and could not be verified as
  // ours (or was found to be someone else's). Re-queueing it means creating a
  // SECOND warehouse order, which is exactly the duplicate fulfilment the
  // PENDING_VERIFY state exists to prevent. That call needs a human who has
  // looked at the WMS.
  if (link.externalOrderId) {
    return {
      success: false,
      error: `This order is already linked to WMS order ${link.externalOrderId}, which could not be verified. `
        + 'Re-queueing would create a second warehouse order. Check the WMS first: if that order is ours, '
        + 'the link is already correct; if it is not, clear the link before re-pushing.',
    }
  }

  // Re-queue for the next sweep. The sweep's eligibility (ready + paid + bound)
  // still applies, so a no-longer-eligible order simply won't re-push.
  await db.wmsOrderPushLink.update({
    where: { id: link.id },
    // The replay re-creates the WMS order, so any dispatch dead-letter state
    // from the previous order must not carry over (6oyu.2).
    data: {
      state: 'PENDING_CREATE',
      attempts: 0,
      lastError: null,
      dispatchFailureCount: 0,
      dispatchLastError: null,
      dispatchDeadLetteredAt: null,
      // ...nor an unresolved-record quarantine (o3d-bjc.9): the unreadable
      // record belonged to the WMS order this replay is about to replace.
      dispatchUnresolvedCount: 0,
      dispatchUnresolvedError: null,
      dispatchUnresolvedAt: null,
    },
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
