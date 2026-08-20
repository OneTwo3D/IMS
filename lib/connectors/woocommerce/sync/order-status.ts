/**
 * Bidirectional order status sync between WooCommerce and IMS.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_STATUS_TRANSITION_BYPASS } from '@/lib/sales/status-transition-bypass'
import { isPermanentStatusTransitionError } from '@/lib/domain/sales/status-transition-errors'
import { wcFetch, wcPut } from '../api'
import type { WcFullOrder } from './types'

type SalesOrderStatus = string

// ---------------------------------------------------------------------------
// WC → IMS status sync
// ---------------------------------------------------------------------------

/**
 * `permanent: true` means a stable business rule refused the transition, so re-delivering the identical
 * webhook re-hits the identical rule. The caller acknowledges those instead of retrying (o3d-bx9).
 */
export async function syncWcOrderStatus(wcOrder: WcFullOrder): Promise<{ success: boolean; error?: string; permanent?: boolean }> {
  try {
    const link = await db.shoppingOrderLink.findUnique({
      where: {
        connector_externalOrderId: {
          connector: 'woocommerce',
          externalOrderId: String(wcOrder.id),
        },
      },
      select: {
        order: {
          select: {
            id: true, externalOrderNumber: true, status: true,
            withdrawalHoldAt: true, withdrawalApprovedAt: true,
          },
        },
      },
    })
    const so = link?.order ?? null
    if (!so) return { success: false, error: `Order not found for WC #${wcOrder.id}` }

    // EU right-of-withdrawal (o3d-e1yb). Runs BEFORE the status mapping: the
    // withdrawal statuses have no mapping and would simply be ignored, and —
    // more importantly — a REJECTION arrives as an ordinary status like
    // `processing`, which the mapping would happily apply and thereby let the
    // WMS release pass re-push an order the customer had asked to stop.
    const { handleWcWithdrawalStatus } = await import('./withdrawal')
    const withdrawal = await handleWcWithdrawalStatus(wcOrder, so)
    // Propagate the transition's OWN result. Returning a blanket success would
    // acknowledge the webhook for a hold or cancellation that never landed,
    // and no later delivery would retry it: an identical redelivery classifies
    // as already-held and does nothing.
    if (withdrawal.kind !== 'not-a-withdrawal') return withdrawal.result

    // Resolve IMS status
    const mapping = await db.shoppingStatusMapping.findUnique({
      where: {
        connector_externalStatus: {
          connector: 'woocommerce',
          externalStatus: wcOrder.status,
        },
      },
    })
    if (!mapping) return { success: true } // no mapping = ignore this status

    const targetStatus = mapping.imsStatus
    if (targetStatus === so.status) return { success: true } // already in sync

    // Special case: WC completed → run completion flow
    if (wcOrder.status === 'completed') {
      const { processWcCompletion } = await import('./completion-flow')
      // o3d-xnwu: propagate the completion's OWN result. Returning a blanket
      // success acknowledged a webhook for a fulfilment that never landed — the
      // store showed the order as completed while IMS held no shipment, and no
      // later delivery retried it. Same reasoning as the withdrawal branch above.
      return processWcCompletion(so.id, wcOrder)
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
    return { success: false, error: String(e), permanent: isPermanentStatusTransitionError(e) }
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

    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        externalOrderNumber: true,
        trackingNumber: true,
        shippingService: true,
        shoppingLinks: {
          where: { connector: 'woocommerce' },
          select: { externalOrderId: true, externalOrderNumber: true },
          take: 1,
        },
      },
    })
    const wcLink = order?.shoppingLinks[0]
    if (!order) return
    if (!wcLink?.externalOrderId) return // not a WC order

    // Idempotent: skip the PUT when WooCommerce is already at the target status.
    // Re-PUTting the same status risks re-firing storefront transition hooks (e.g. the
    // AST despatch email) when another integration already moved the order — split-order
    // completion via the companion plugin, or a WMS bridge pushing the status directly
    // during the cutover period.
    const currentWc = await wcFetch(`/orders/${wcLink.externalOrderId}`)
    if (!currentWc.error && (currentWc.data as { status?: string } | null)?.status === externalStatus) {
      return
    }

    const { data: pushedOrder, error } = await wcPut(`/orders/${wcLink.externalOrderId}`, { status: externalStatus })

    if (error) {
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_push_failed', tag: 'sync', level: 'WARNING',
        description: `Failed to push status ${newStatus} → ${externalStatus} to WC order #${wcLink.externalOrderNumber ?? order.externalOrderNumber}: ${error}`,
        resolveUser: false,
      })
      return
    }

    // Record WHEN our write landed, straight from WooCommerce's own clock.
    //
    // This is what lets the echo check identify OUR write rather than guessing from the
    // status string. WC stamps date_modified_gmt on every change, so the echo of this
    // push carries exactly this timestamp, while any later change (a refund, an edit)
    // carries a greater one. Comparing status alone cannot tell those apart, which is
    // how refunds were being discarded (o3d-uxv).
    const pushedDateModifiedGmt = (pushedOrder as { date_modified_gmt?: string } | null)?.date_modified_gmt

    await db.shoppingSyncLog.create({
      data: {
        direction: 'TO_CONNECTOR',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: orderId,
        externalId: wcLink.externalOrderId,
        payload: JSON.parse(JSON.stringify({ status: externalStatus, pushedDateModifiedGmt })),
        syncedAt: new Date(),
      },
    })

    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_status_pushed', tag: 'sync', level: 'INFO',
      description: `Pushed status ${externalStatus} to WC order #${wcLink.externalOrderNumber ?? order.externalOrderNumber}`,
      resolveUser: false,
    })
  } catch {
    // Fire-and-forget — don't break the IMS flow
  }
}
