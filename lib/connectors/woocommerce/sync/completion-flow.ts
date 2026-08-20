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
/**
 * Was the admin bell for this refusal actually delivered?
 *
 * o3d-xnwu round 3, Codex finding 4. `notify` SWALLOWS its errors — that is its
 * documented job — so a failed bell used to be indistinguishable from a
 * delivered one. The dedupe then made it permanent: the exception row existed
 * (its transaction had already committed), so every later refusal of the same
 * order took the "already told them" branch and nobody was ever told. A
 * notification that failed was treated as delivered, forever, and nothing said
 * so anywhere.
 *
 * Delivery is therefore recorded ON the row, not inferred from the row's
 * existence. An unnotified row is retried by the next refusal of that order, and
 * the failure itself is reported at ERROR in the meantime.
 */
function wasAdminBellDelivered(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  return (payload as { adminNotified?: unknown }).adminNotified === true
}

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
  // Read the open row BEFORE replacing it, because the one thing that must
  // survive the replacement is whether its bell was ever delivered. `deleteMany`
  // reports a count and not the rows, and a count cannot answer that question.
  const open = await db.shoppingSyncLog.findFirst({
    where: buildExternalFulfillmentRefusalWhere(orderId),
    select: { payload: true },
  })
  const alreadyBelled = wasAdminBellDelivered(open?.payload)

  const [, created] = await db.$transaction([
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
        payload: JSON.parse(JSON.stringify({
          wcStatus: wcOrder.status,
          wcOrderNumber: wcOrder.number ?? null,
          // Carried forward, so a re-refusal of an order whose bell DID land does
          // not ring it again, and one whose bell did not gets another go.
          adminNotified: alreadyBelled,
        })),
      },
    }),
  ])

  // Bell the admins the FIRST time an order is refused, exactly as the WMS
  // dispatch dead-letter does for the same underlying cause, and pointing at the
  // same page. Once only: a further refusal of an order already on the list adds
  // nothing an operator has not been told, and a bell per redelivery would train
  // them to ignore it.
  //
  // "Once" now means once DELIVERED rather than once attempted.
  //
  // Individually, never broadcast (userId null): the message names a customer
  // order, which READONLY/SUPPLIER users must not be shown.
  if (alreadyBelled) return

  const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
  // allSettled, not all: one admin's failed insert must not discard the others'
  // successes, and a rejection here must not throw out of a function whose
  // caller reads a throw as "the exception row could not be filed".
  const results = await Promise.allSettled(admins.map((admin) => notify({
    userId: admin.id,
    type: 'error',
    title: 'WooCommerce order completed but not fulfilled',
    message:
      `WooCommerce marked order ${wcOrder.number ?? wcOrder.id} as completed, but IMS refused to record the dispatch: `
      + `${error}. No shipment exists and no stock has moved. It needs attention in the sync exception inbox.`,
    actionUrl: '/sync/exceptions',
  })))

  const delivered = results.filter((row) => row.status === 'fulfilled' && row.value === true).length
  // An empty admin list is a FAILED bell, not a satisfied one: `Promise.all([])`
  // resolving is not the same as somebody having been told, and an install with
  // no active admin is exactly where an unfulfilled order goes unnoticed.
  if (delivered === admins.length && admins.length > 0) {
    await db.shoppingSyncLog.update({
      where: { id: created.id },
      data: {
        payload: JSON.parse(JSON.stringify({
          wcStatus: wcOrder.status,
          wcOrderNumber: wcOrder.number ?? null,
          adminNotified: true,
        })),
      },
    // The bell WAS rung; failing to write that down must not undo it or fail the
    // filing. The cost of losing this write is one duplicate bell next time,
    // which is the right direction to err.
    }).catch(() => {})
    return
  }

  // Reported, and retried. The row stays marked unnotified, so the next refusal
  // of this order rings again — and an operator is told now rather than finding
  // out from a customer.
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'wc_completion_refusal_unnotified',
    tag: 'sync',
    level: 'ERROR',
    description:
      `Filed the exception row for a refused WooCommerce completion of order ${orderId}, but could not tell the admins:`
      + ` ${delivered} of ${admins.length} notification(s) were written`
      + `${admins.length === 0 ? ' — there is no active ADMIN user to notify' : ''}.`
      + ' The refusal is on /sync/exceptions and the bell will be retried the next time this order is refused.'
      + ` The refusal itself was: ${error}`,
    metadata: {
      externalOrderId: wcOrder.id,
      adminCount: admins.length,
      notificationsDelivered: delivered,
    },
    resolveUser: false,
  }).catch(() => {})
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
