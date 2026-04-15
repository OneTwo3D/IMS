/**
 * Bidirectional order status sync between WooCommerce and IMS.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_STATUS_TRANSITION_BYPASS } from '@/lib/sales/status-transition-bypass'
import { wcPut } from '../api'
import type { WcFullOrder } from './types'

type SalesOrderStatus = string

// ---------------------------------------------------------------------------
// WC → IMS status sync
// ---------------------------------------------------------------------------

export async function syncWcOrderStatus(wcOrder: WcFullOrder): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({
      where: { externalOrderId: wcOrder.id },
      select: { id: true, externalOrderNumber: true, status: true },
    })
    if (!so) return { success: false, error: `Order not found for WC #${wcOrder.id}` }

    // Resolve IMS status
    const mapping = await db.shoppingStatusMapping.findUnique({ where: { externalStatus: wcOrder.status } })
    if (!mapping) return { success: true } // no mapping = ignore this status

    const targetStatus = mapping.imsStatus
    if (targetStatus === so.status) return { success: true } // already in sync

    // Special case: WC completed → run completion flow
    if (wcOrder.status === 'completed') {
      const { processWcCompletion } = await import('./completion-flow')
      await processWcCompletion(so.id, wcOrder)
      return { success: true }
    }

    // Special case: WC refunded → handled by refund sync, not status sync
    if (wcOrder.status === 'refunded') return { success: true }

    // Standard status update
    const { applySalesOrderStatusTransition } = await import('@/app/actions/sales')
    const result = await applySalesOrderStatusTransition(so.id, targetStatus as never, undefined, {
      pushStatusToWooCommerce: false,
      internalBypassToken: INTERNAL_STATUS_TRANSITION_BYPASS,
    })

    if (!result.success) {
      await logActivity({
        entityType: 'SALES_ORDER', entityId: so.id, action: 'status_sync_failed', tag: 'sync', level: 'WARNING',
        description: `Could not sync WC status ${wcOrder.status} → ${targetStatus} for order #${so.externalOrderNumber}: ${result.error}`,
        resolveUser: false,
      })
    }

    return result
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// IMS → WC status push
// ---------------------------------------------------------------------------

// Only push these IMS statuses to WC
const IMS_TO_WC: Partial<Record<SalesOrderStatus, string>> = {
  SHIPPED: 'completed',
  CANCELLED: 'cancelled',
  ON_HOLD: 'on-hold',
}

export async function pushImsStatusToWc(orderId: string, newStatus: SalesOrderStatus): Promise<void> {
  try {
    const externalStatus = IMS_TO_WC[newStatus]
    if (!externalStatus) return // no WC equivalent

    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { externalOrderId: true, externalOrderNumber: true, trackingNumber: true, shippingService: true },
    })
    if (!so?.externalOrderId) return // not a WC order

    const { error } = await wcPut(`/orders/${so.externalOrderId}`, { status: externalStatus })

    if (error) {
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_push_failed', tag: 'sync', level: 'WARNING',
        description: `Failed to push status ${newStatus} → ${externalStatus} to WC order #${so.externalOrderNumber}: ${error}`,
        resolveUser: false,
      })
      return
    }

    await db.shoppingSyncLog.create({
      data: {
        direction: 'TO_CONNECTOR',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: orderId,
        externalId: so.externalOrderId,
        payload: JSON.parse(JSON.stringify({ status: externalStatus })),
        syncedAt: new Date(),
      },
    })

    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_status_pushed', tag: 'sync', level: 'INFO',
      description: `Pushed status ${externalStatus} to WC order #${so.externalOrderNumber}`,
      resolveUser: false,
    })
  } catch {
    // Fire-and-forget — don't break the IMS flow
  }
}
