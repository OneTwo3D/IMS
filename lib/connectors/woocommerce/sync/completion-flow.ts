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
import {
  EXTERNAL_FULFILLMENT_REFUSAL_ENTITY_TYPE,
  buildExternalFulfillmentRefusalWhere,
  isPermanentExternalFulfillmentRefusal,
} from '@/lib/fulfillment/external-fulfillment-refusal'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'

/** Already dispatched: a completion here is real fulfilment evidence catching
 *  up, not something a withdrawal should block. */
const POST_DISPATCH_FOR_WDRAW: ReadonlySet<string> = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

/**
 * o3d-xnwu. `permanent: true` means a stable business rule refused the
 * completion, so re-delivering the identical webhook re-hits the identical rule:
 * the caller acknowledges it and the refusal is carried by the exception inbox
 * row written below, not by a retry ladder that ends in a dead letter nobody
 * connected to this order.
 */
export type WcCompletionResult = { success: boolean; error?: string; permanent?: boolean }

/**
 * Park a refusal where an operator is already looking (/sync/exceptions).
 *
 * ONE open row per order: a refusal that recurs (the daily reconcile, another
 * store edit) must not turn one unfulfillable order into a growing pile of
 * identical rows, which is the same dedupe rule the product structure conflicts
 * follow. Deleting and re-creating rather than updating deliberately re-stamps
 * `createdAt`, so the timestamp reads as "last refused", which is what an
 * operator triaging the list needs.
 */
async function recordWcCompletionRefusal(orderId: string, wcOrder: WcFullOrder, error: string): Promise<void> {
  const [cleared] = await db.$transaction([
    db.shoppingSyncLog.deleteMany({ where: buildExternalFulfillmentRefusalWhere(orderId) }),
    db.shoppingSyncLog.create({
      data: {
        connector: 'woocommerce',
        direction: 'FROM_CONNECTOR',
        status: 'QUARANTINED',
        entityType: EXTERNAL_FULFILLMENT_REFUSAL_ENTITY_TYPE,
        entityId: orderId,
        externalId: String(wcOrder.id),
        errorMessage: error,
        payload: JSON.parse(JSON.stringify({ wcStatus: wcOrder.status, wcOrderNumber: wcOrder.number ?? null })),
      },
    }),
  ])

  // Bell the admins the FIRST time an order is refused, exactly as the WMS
  // dispatch dead-letter does for the same underlying cause, and pointing at the
  // same page. Once only: a further refusal of an order already on the list adds
  // nothing an operator has not been told, and a bell per redelivery would train
  // them to ignore it.
  //
  // Individually, never broadcast (userId null): the message names a customer
  // order, which READONLY/SUPPLIER users must not be shown.
  if (cleared.count === 0) {
    const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
    await Promise.all(admins.map((admin) => notify({
      userId: admin.id,
      type: 'error',
      title: 'WooCommerce order completed but not fulfilled',
      message:
        `WooCommerce marked order ${wcOrder.number ?? wcOrder.id} as completed, but IMS refused to record the dispatch: `
        + `${error}. No shipment exists and no stock has moved. It needs attention in the sync exception inbox.`,
      actionUrl: '/sync/exceptions',
    })))
  }
}

/** A completion that succeeded answers the open refusal — the row is a live state, not a log. */
async function clearWcCompletionRefusal(orderId: string): Promise<void> {
  await db.shoppingSyncLog.deleteMany({ where: buildExternalFulfillmentRefusalWhere(orderId) })
}

export async function processWcCompletion(orderId: string, wcOrder: WcFullOrder): Promise<WcCompletionResult> {
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
    // Reported as a SUCCESSFUL outcome deliberately: this refusal is the
    // intended end state (the customer withdrew; nothing should ship), it
    // already writes its own WARNING row naming the order, and there is nothing
    // for an operator to unblock. Everything below is the opposite case — an
    // order that SHOULD have shipped and did not.
    return { success: true }
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

  // o3d-xnwu: this result used to be DISCARDED. The store showed the order as
  // completed, IMS never created the shipment, and nobody — not the caller, not
  // the webhook, not an operator — was told.
  if (!applied.success) {
    const error = applied.error ?? 'External fulfillment update failed'
    const permanent = isPermanentExternalFulfillmentRefusal(applied.reason)
    let filed = true
    if (permanent) {
      // A retry cannot clear this one, so it goes where it can be seen and acted
      // on.
      try {
        await recordWcCompletionRefusal(orderId, wcOrder, error)
      } catch (recordError) {
        filed = false
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: orderId,
          action: 'wc_completion_refusal_unrecorded',
          tag: 'sync',
          level: 'ERROR',
          description:
            `Could not file the exception row for a refused WooCommerce completion of order ${orderId}: `
            + `${recordError instanceof Error ? recordError.message : String(recordError)}. The refusal itself was: ${error}`,
          metadata: { externalOrderId: wcOrder.id },
          resolveUser: false,
        }).catch(() => {})
      }
    }
    // Acknowledging a permanent refusal is only safe BECAUSE it has been filed
    // somewhere an operator will find it. If that write failed, do not close the
    // delivery over it — the failed write is itself retryable, and a refusal
    // nobody can see is not a refusal.
    return { success: false, error, permanent: permanent && filed }
  }

  await clearWcCompletionRefusal(orderId)
  return { success: true }
}
