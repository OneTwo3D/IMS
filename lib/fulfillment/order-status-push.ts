/**
 * THE one decision point for "an operator just cancelled / held a storefront order — what does the storefront
 * hear?" (o3d-6ldlj). The sibling of shipment-completion-push.ts for the two other IMS -> storefront statuses.
 *
 * The decision is made INSIDE the transaction that flips the order, where it is durable: when the transition
 * owns the storefront status and the order has a link, `scheduleShoppingOrderStatusPush` writes a
 * `woocommerce/order.cancel` / `order.hold` outbox row with the flip. After the commit this module only makes
 * the IMMEDIATE attempt, un-awaited: the row is durable and the `shopping-webhook-inbox` cron is the backstop,
 * so a slow or down storefront (each WooCommerce request can take up to 120 s) never holds up or fails an order
 * transition that has already committed. Never throws. NOT 'use server', so it may export freely.
 */

import { logActivity } from '@/lib/activity-log'
import { processShoppingOrderStatusPushes, scheduleShoppingOrderStatusPush } from '@/lib/shopping'

export type ShoppingStatusPushRef = Awaited<ReturnType<typeof scheduleShoppingOrderStatusPush>>

/**
 * Called INSIDE the locked transaction. `enabled` is false for a transition that does not own the storefront
 * status (a WooCommerce-driven one would only echo): then NO row is written. Returns the job reference, or null.
 * Does no WooCommerce I/O and no pooled query: the link is looked up on the transaction client.
 */
export async function scheduleManualStatusPush(
  tx: Parameters<typeof scheduleShoppingOrderStatusPush>[0],
  input: { orderId: string; target: 'CANCELLED' | 'ON_HOLD'; enabled: boolean; flippedAt?: Date },
): Promise<ShoppingStatusPushRef> {
  if (!input.enabled) return null
  return scheduleShoppingOrderStatusPush(tx, {
    orderId: input.orderId,
    target: input.target,
    flippedAt: input.flippedAt ?? new Date(),
  })
}

/** After the commit: one un-awaited attempt on the job enqueued with the flip. A no-op for a null reference. */
export function attemptShoppingStatusPushAfterCommit(input: { orderId: string; job: ShoppingStatusPushRef }): void {
  if (!input.job) return
  void processShoppingOrderStatusPushes({ idempotencyKeys: [input.job.key] })
    .catch((error) => {
      console.error(error)
      void logActivity({
        entityType: 'SALES_ORDER', entityId: input.orderId, action: 'wc_status_push_attempt_failed',
        tag: 'sync', level: 'WARNING',
        description: `The immediate WooCommerce status push attempt for order ${input.orderId} threw (${error instanceof Error ? error.message : String(error)}); the queued job will be retried`,
        resolveUser: false,
      }).catch(() => {})
    })
}
