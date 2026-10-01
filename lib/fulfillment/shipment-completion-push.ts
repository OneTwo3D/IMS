/**
 * THE one decision point for "a shipment just shipped — what does the storefront hear?" (o3d-zvec.15).
 *
 * Every IMS-driven dispatch path used to hand-roll this and they drifted: the in-app shipment path
 * pushed only the tracking, so a WooCommerce order shipped inside IMS stayed `processing` and no
 * "completed" email went out, while the manual order-status path pushed the status BEFORE the
 * tracking, so the completed email went out without it. Routing both through here makes the rule a
 * single function a future path has to call rather than re-derive:
 *
 *   1. ALWAYS push the tracking (a partial shipment's tracking is still real);
 *   2. THEN, and only when the order has just reached SHIPPED, push the SHIPPED status — after the
 *      tracking so the storefront's completed email carries it.
 *
 * "Has just reached SHIPPED" is the caller's `orderReachedShipped` — for the shipment path that is the
 * reconciliation's own flip signal (`ShipmentReconciliationResult.orderReachedShipped`), true for the
 * one call that promoted the order, so a partial shipment, a shortfall-held order, a retry and an order
 * another path already promoted all push no status. `pushStatus: false` is for callers where the
 * storefront owns the status (an inbound WooCommerce completion, an externally fulfilled dispatch that
 * pushes its own) — pushing there would only echo.
 *
 * POST-COMMIT, best-effort: call it after the transaction that shipped the order has committed. It
 * never throws and never fails the shipment; a failed push is logged so a missed completion email is
 * not invisible. The storefront's own "only promote while still processing" guard and its
 * already-at-target idempotence live in the connector (`pushImsStatusToWc`).
 *
 * This file is NOT 'use server', so it may export freely.
 */

import { logActivity } from '@/lib/activity-log'
import { pushOrderDeliveryMetadata, pushSalesOrderStatus } from '@/lib/shopping'

export type ShipmentCompletionPushInput = {
  orderId: string
  /** The order reached SHIPPED in THIS operation (and not before). */
  orderReachedShipped: boolean
  /** False when the storefront owns the status and a push would only echo. */
  pushStatus: boolean
  /** Human order reference for the failure log. */
  orderRef?: string | null
}

export async function pushShipmentCompletionToShopping(input: ShipmentCompletionPushInput): Promise<void> {
  try {
    await pushOrderDeliveryMetadata(input.orderId)
  } catch (syncError) {
    console.error(syncError)
  }

  if (!input.orderReachedShipped || !input.pushStatus) return

  const logFailure = async (detail: string) => {
    try {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: input.orderId,
        action: 'shopping_status_push_failed',
        tag: 'sync',
        level: 'WARNING',
        description: `Failed to push status SHIPPED for order ${input.orderRef ?? input.orderId} to shopping connector: ${detail} — the storefront order may still be processing and the customer despatch email may not have fired`,
        metadata: { orderNumber: input.orderRef ?? null, targetStatus: 'SHIPPED', error: detail },
        resolveUser: false,
      })
    } catch (logError) {
      console.error(logError)
    }
  }

  try {
    const result = await pushSalesOrderStatus(input.orderId, 'SHIPPED')
    if (!result.success) await logFailure(result.error ?? 'unknown error')
  } catch (error) {
    await logFailure(error instanceof Error ? error.message : String(error))
  }
}
