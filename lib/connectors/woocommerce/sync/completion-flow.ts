/**
 * WC "completed" → IMS shipment workflow.
 *
 * WooCommerce is treated as the dispatch authority for external storefront
 * orders. When an order is marked completed in Woo, the IMS auto-allocates,
 * creates shipment rows, and advances those shipments to SHIPPED with tracking.
 */

import type { WcFullOrder } from './types'
import { extractWcTracking } from './field-mapping'
import {
  applyExternalFulfillmentUpdate,
  type ExternalFulfillmentRefusal,
} from '@/lib/fulfillment/external-fulfillment'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

/** Already dispatched: a completion here is real fulfilment evidence catching
 *  up, not something a withdrawal should block. */
const POST_DISPATCH_FOR_WDRAW: ReadonlySet<string> = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

/**
 * What a WooCommerce completion actually did (o3d-xnwu).
 *
 * This function used to return `void`, and its last statement was a bare
 * `await applyExternalFulfillmentUpdate(...)` whose result was thrown away. A call whose return
 * value is discarded cannot fail: `syncWcOrderStatus` returned `{ success: true }` immediately
 * afterwards, the webhook was acknowledged, the order-sync cursor advanced, and an order marked
 * completed in the store that had NOT become an IMS shipment left no trace on the caller at all.
 *
 * Three outcomes, kept apart because their callers must treat them differently:
 *
 *   - `fulfilled` — shipments exist and are SHIPPED.
 *   - `skipped_withdrawn` — deliberately not fulfilled, already logged, and NOT a failure: the
 *     order is exactly where it should be. Acknowledged like a success (this is the behaviour that
 *     was already correct, now stated instead of implied by falling off the end of the function).
 *   - `refused` — the fulfilment did not happen. `permanent` carries the o3d-bx9 / o3d-i0y
 *     distinction straight through from `applyExternalFulfillmentUpdate`, and `refusal` carries
 *     WHICH rule said no — which the WooCommerce webhook needs, because it sweeps the order's
 *     refunds after this runs and a coverage shortfall computed before that sweep is an answer
 *     about a state that is committed but stale (o3d-xnwu r2).
 */
export type WcCompletionOutcome =
  | { kind: 'fulfilled' }
  | { kind: 'skipped_withdrawn' }
  | { kind: 'refused'; error: string; permanent: boolean; refusal: ExternalFulfillmentRefusal }

export async function processWcCompletion(
  orderId: string,
  wcOrder: WcFullOrder,
): Promise<WcCompletionOutcome> {
  // o3d-e1yb [wdraw]: this path bypasses applySalesOrderStatusTransition
  // entirely, so the locked terminal-approval guard there does NOT cover it.
  // A completion worker can read the order before an approval commits, pause,
  // and then allocate, create shipments and consume stock for an order the
  // customer has withdrawn — after which the approval retry sees dispatch
  // evidence and permanently refuses the cancellation, silently converting an
  // approved withdrawal into a return.
  //
  // Re-read under the same row lock the withdrawal handler takes, so the two
  // are mutually exclusive rather than merely racing.
  const approved = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
    if (locked.length === 0) return null
    const so = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { withdrawalApprovedAt: true, status: true },
    })
    return so ?? null
  })
  if (approved?.withdrawalApprovedAt && !POST_DISPATCH_FOR_WDRAW.has(approved.status)) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'wc_completion_refused_withdrawn',
      tag: 'sync',
      level: 'WARNING',
      description:
        'Refused a WooCommerce completion for an order whose EU withdrawal request was approved. '
        + 'Fulfilling it would have allocated stock and created shipments for goods the customer '
        + 'asked to withdraw.',
      metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status, imsStatus: approved.status },
      resolveUser: false,
    })
    return { kind: 'skipped_withdrawn' }
  }

  const wcTracking = extractWcTracking(wcOrder)

  const applied = await applyExternalFulfillmentUpdate({
    source: 'woocommerce',
    lookup: { orderId },
    targetShipmentStatus: 'SHIPPED',
    tracking: wcTracking.map((row) => ({
      trackingNumber: row.trackingNumber,
      shippingService: row.carrier,
    })),
  })
  if (applied.success) return { kind: 'fulfilled' }

  // The WooCommerce twin of the WMS dispatch sweep's failure counter. That path increments
  // WmsOrderPushLink.dispatchFailureCount, dead-letters at DISPATCH_MAX_CONSECUTIVE_FAILURES and
  // notifies admins; this path has no link row to count on, so the record is an activity row on the
  // ORDER — where an operator investigating "the store says shipped, IMS does not" is looking —
  // plus the outcome returned to the caller, which is what makes the webhook behave differently.
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'wc_completion_fulfillment_refused',
    tag: 'sync',
    level: 'WARNING',
    description: `A WooCommerce order marked completed did not become an IMS shipment (${applied.refusal}): `
      + `${applied.error}`,
    metadata: {
      externalOrderId: wcOrder.id,
      wcStatus: wcOrder.status,
      refusal: applied.refusal,
      permanent: applied.permanent,
      error: applied.error,
    },
    resolveUser: false,
  })

  return { kind: 'refused', error: applied.error, permanent: applied.permanent, refusal: applied.refusal }
}
