/**
 * WC "completed" → IMS shipment workflow.
 *
 * WooCommerce is treated as the dispatch authority for external storefront
 * orders. When an order is marked completed in Woo, the IMS auto-allocates,
 * creates shipment rows, and advances those shipments to SHIPPED with tracking.
 */

import type { WcFullOrder } from './types'
import { extractWcTracking } from './field-mapping'
import { applyExternalFulfillmentUpdate } from '@/lib/fulfillment/external-fulfillment'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

/** Already dispatched: a completion here is real fulfilment evidence catching
 *  up, not something a withdrawal should block. */
const POST_DISPATCH_FOR_WDRAW: ReadonlySet<string> = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

export async function processWcCompletion(orderId: string, wcOrder: WcFullOrder): Promise<void> {
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
    return
  }

  const wcTracking = extractWcTracking(wcOrder)

  await applyExternalFulfillmentUpdate({
    source: 'woocommerce',
    lookup: { orderId },
    targetShipmentStatus: 'SHIPPED',
    tracking: wcTracking.map((row) => ({
      trackingNumber: row.trackingNumber,
      shippingService: row.carrier,
    })),
  })
}
