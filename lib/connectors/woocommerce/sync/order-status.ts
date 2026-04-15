/**
 * Bidirectional order status sync between WooCommerce and IMS.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcPut } from '../api'
import type { WcFullOrder } from './types'

type SalesOrderStatus = string

// ---------------------------------------------------------------------------
// WC → IMS status sync
// ---------------------------------------------------------------------------

export async function syncWcOrderStatus(wcOrder: WcFullOrder): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({
      where: { wcOrderId: wcOrder.id },
      select: { id: true, wcOrderNumber: true, status: true },
    })
    if (!so) return { success: false, error: `Order not found for WC #${wcOrder.id}` }

    // Resolve IMS status
    const mapping = await db.wcStatusMapping.findUnique({ where: { wcStatus: wcOrder.status } })
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
    })

    if (!result.success) {
      logActivity({
        entityType: 'SALES_ORDER', entityId: so.id, action: 'status_sync_failed', tag: 'sync', level: 'WARNING',
        description: `Could not sync WC status ${wcOrder.status} → ${targetStatus} for order #${so.wcOrderNumber}: ${result.error}`,
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
    const wcStatus = IMS_TO_WC[newStatus]
    if (!wcStatus) return // no WC equivalent

    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { wcOrderId: true, wcOrderNumber: true, trackingNumber: true, shippingService: true },
    })
    if (!so?.wcOrderId) return // not a WC order

    const { error } = await wcPut(`/orders/${so.wcOrderId}`, { status: wcStatus })

    if (error) {
      logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_push_failed', tag: 'sync', level: 'WARNING',
        description: `Failed to push status ${newStatus} → ${wcStatus} to WC order #${so.wcOrderNumber}: ${error}`,
      })
      return
    }

    await db.wcSyncLog.create({
      data: {
        direction: 'TO_WC',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: orderId,
        wcId: so.wcOrderId,
        payload: JSON.parse(JSON.stringify({ status: wcStatus })),
        syncedAt: new Date(),
      },
    })

    logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_status_pushed', tag: 'sync', level: 'INFO',
      description: `Pushed status ${wcStatus} to WC order #${so.wcOrderNumber}`,
    })
  } catch {
    // Fire-and-forget — don't break the IMS flow
  }
}
