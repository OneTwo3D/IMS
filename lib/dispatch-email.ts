/**
 * Direct-order dispatch email (onetwo3d-ims-q66in.1.6).
 *
 * Storefront orders already get a dispatch email from the storefront itself
 * (pushOrderDeliveryMetadata → WC tracking writeback triggers WooCommerce's
 * own "completed" email). Direct IMS orders (no ShoppingOrderLink) get
 * nothing, so this queues an IMS-native dispatch email for them — opt-in via
 * the `dispatch_email_enabled` setting (default OFF), and queued at most once
 * per order (deduped against the outbox under the order row lock).
 *
 * This file is NOT 'use server' — it cannot be called directly from the client.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'

export const DISPATCH_EMAIL_SETTING_KEY = 'dispatch_email_enabled'
export const DISPATCH_EMAIL_KIND = 'SHIPMENT_DISPATCHED'

export type DispatchEmailEligibilityInput = {
  settingValue: string | null
  order: { status: string; customerEmail: string | null; shoppingLinkCount: number } | null
  alreadyQueued: boolean
}

export type DispatchEmailEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'disabled' | 'order_not_found' | 'order_not_shipped' | 'storefront_order' | 'no_customer_email' | 'already_queued' }

/**
 * Pure decision: should a dispatch email be queued for this order?
 * Storefront-linked orders are excluded so WooCommerce's own dispatch email
 * is never doubled up. Requiring status exactly SHIPPED (not COMPLETED or
 * DELIVERED) bounds the retry-heal window so historic orders reprocessed by
 * a sweep never get a late email.
 */
export function evaluateDispatchEmailEligibility(input: DispatchEmailEligibilityInput): DispatchEmailEligibility {
  if (input.settingValue !== 'true') return { eligible: false, reason: 'disabled' }
  if (!input.order) return { eligible: false, reason: 'order_not_found' }
  if (input.order.status !== 'SHIPPED') return { eligible: false, reason: 'order_not_shipped' }
  if (input.order.shoppingLinkCount > 0) return { eligible: false, reason: 'storefront_order' }
  if (!input.order.customerEmail) return { eligible: false, reason: 'no_customer_email' }
  if (input.alreadyQueued) return { eligible: false, reason: 'already_queued' }
  return { eligible: true }
}

/**
 * Queue the dispatch email if the order is eligible. Never throws — dispatch
 * must not fail because the courtesy email could not be queued.
 *
 * The dedup check and outbox insert run in one transaction holding the order
 * row lock, so concurrent dispatch retries (UI + WMS sweep) cannot both queue,
 * while a retry after a crashed enqueue still heals (order is SHIPPED, no
 * outbox row yet → queues now).
 */
export async function queueDispatchEmailIfEligible(orderId: string): Promise<{ queued: boolean; reason?: string }> {
  try {
    const setting = await db.setting.findUnique({ where: { key: DISPATCH_EMAIL_SETTING_KEY } })
    if (setting?.value !== 'true') return { queued: false, reason: 'disabled' }

    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      const order = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          customerEmail: true,
          orderNumber: true,
          externalOrderNumber: true,
          _count: { select: { shoppingLinks: true } },
        },
      })
      const existing = await tx.emailOutbox.findFirst({
        where: { kind: DISPATCH_EMAIL_KIND, referenceType: 'SalesOrder', referenceId: orderId },
        select: { id: true },
      })

      const eligibility = evaluateDispatchEmailEligibility({
        settingValue: setting.value,
        order: order
          ? { status: order.status, customerEmail: order.customerEmail, shoppingLinkCount: order._count.shoppingLinks }
          : null,
        alreadyQueued: existing !== null,
      })
      if (!eligibility.eligible) return { queued: false as const, reason: eligibility.reason }

      const ref = order!.orderNumber ?? order!.externalOrderNumber ?? orderId.slice(0, 8)
      await tx.emailOutbox.create({
        data: {
          kind: DISPATCH_EMAIL_KIND,
          toEmail: order!.customerEmail!.trim().toLowerCase(),
          subject: `Your order ${ref} has been dispatched`,
          html: 'queued',
          referenceType: 'SalesOrder',
          referenceId: orderId,
        },
      })
      return { queued: true as const, ref }
    })
    if (!outcome.queued) return outcome

    const ref = outcome.ref
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'dispatch_email_queued',
      tag: 'sales',
      level: 'INFO',
      description: `Queued dispatch email for order ${ref}`,
      resolveUser: false,
    })
    return { queued: true }
  } catch (error) {
    console.error(`Failed to queue dispatch email for order ${orderId}`, error)
    return { queued: false, reason: String(error) }
  }
}
