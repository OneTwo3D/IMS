/**
 * THE one decision point for "a shipment just shipped — what does the storefront hear?" (o3d-zvec.15).
 *
 * The decision is now made INSIDE the transaction that ships the order, where it is durable: when the
 * order reached SHIPPED and the caller owns the storefront status, `scheduleShoppingOrderCompletion` wrote
 * a `woocommerce/order.complete` outbox row with the flip, and passes its key here. After the commit this
 * module only makes the IMMEDIATE attempt:
 *
 *   - with a key: run that one job un-awaited (tracking first, then the status, re-reading WooCommerce on
 *     every attempt). A failure leaves the row for the `shopping-webhook-inbox` cron to retry, so the
 *     shipment — already committed — is never failed or held up by a slow storefront (each WooCommerce
 *     request can take up to 120 s);
 *   - without a key (a partial shipment, an EXTERNAL-authority dispatch, an unlinked order, a WooCommerce-
 *     driven transition): tracking only, as before.
 *
 * Never throws. NOT 'use server', so it may export freely.
 */

import { logActivity } from '@/lib/activity-log'
import { pushOrderDeliveryMetadata, processShoppingOrderCompletions, scheduleShoppingOrderCompletion } from '@/lib/shopping'

/**
 * The manual "mark the order SHIPPED" path's half of the decision, called INSIDE its transaction after the
 * order lock: enqueue the durable completion job unless the transition does not own the storefront status
 * (`enabled` false for a WooCommerce-driven transition, or an order with no storefront link).
 */
export async function scheduleManualShipCompletion(
  tx: Parameters<typeof scheduleShoppingOrderCompletion>[0],
  input: { orderId: string; enabled: boolean; shippedAt?: Date },
): Promise<string | null> {
  if (!input.enabled) return null
  return scheduleShoppingOrderCompletion(tx, { orderId: input.orderId, shippedAt: input.shippedAt ?? new Date() })
}

export type ShipmentCompletionPushInput = {
  orderId: string
  /** The idempotency key of the completion job enqueued with the flip, or null when there is none. */
  completionKey: string | null
}

export async function pushShipmentCompletionToShopping(input: ShipmentCompletionPushInput): Promise<void> {
  if (input.completionKey) {
    // Un-awaited on purpose: the row is durable and the cron is the backstop.
    void processShoppingOrderCompletions({ idempotencyKeys: [input.completionKey] })
      .catch((error) => {
        console.error(error)
        void logActivity({
          entityType: 'SALES_ORDER', entityId: input.orderId, action: 'wc_completion_attempt_failed',
          tag: 'sync', level: 'WARNING',
          description: `The immediate WooCommerce completion attempt for order ${input.orderId} threw (${error instanceof Error ? error.message : String(error)}); the queued job will be retried`,
          resolveUser: false,
        }).catch(() => {})
      })
    return
  }
  try {
    await pushOrderDeliveryMetadata(input.orderId)
  } catch (syncError) {
    console.error(syncError)
  }
}
