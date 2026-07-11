/**
 * Direct-order dispatch email (onetwo3d-ims-q66in.1.6).
 *
 * Storefront orders already get a dispatch email from the storefront itself
 * (pushOrderDeliveryMetadata → WC tracking writeback triggers WooCommerce's
 * own "completed" email). Direct IMS orders (no ShoppingOrderLink) get
 * nothing, so this queues an IMS-native dispatch email for them — opt-in via
 * the `dispatch_email_enabled` setting (default OFF), enqueued only by the
 * call that actually flipped the order to SHIPPED, and deduped against the
 * outbox so it is sent at most once per order.
 *
 * This file is NOT 'use server' — it cannot be called directly from the client.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { queueEmail } from '@/lib/email-outbox'

export const DISPATCH_EMAIL_SETTING_KEY = 'dispatch_email_enabled'
export const DISPATCH_EMAIL_KIND = 'SHIPMENT_DISPATCHED'

export type DispatchEmailEligibilityInput = {
  settingValue: string | null
  order: { customerEmail: string | null; shoppingLinkCount: number } | null
  alreadyQueued: boolean
}

export type DispatchEmailEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'disabled' | 'order_not_found' | 'storefront_order' | 'no_customer_email' | 'already_queued' }

/**
 * Pure decision: should a dispatch email be queued for this order?
 * Storefront-linked orders are excluded so WooCommerce's own dispatch email
 * is never doubled up.
 */
export function evaluateDispatchEmailEligibility(input: DispatchEmailEligibilityInput): DispatchEmailEligibility {
  if (input.settingValue !== 'true') return { eligible: false, reason: 'disabled' }
  if (!input.order) return { eligible: false, reason: 'order_not_found' }
  if (input.order.shoppingLinkCount > 0) return { eligible: false, reason: 'storefront_order' }
  if (!input.order.customerEmail) return { eligible: false, reason: 'no_customer_email' }
  if (input.alreadyQueued) return { eligible: false, reason: 'already_queued' }
  return { eligible: true }
}

/**
 * Queue the dispatch email if the order is eligible. Never throws — dispatch
 * must not fail because the courtesy email could not be queued.
 */
export async function queueDispatchEmailIfEligible(orderId: string): Promise<{ queued: boolean; reason?: string }> {
  try {
    const [setting, order, existing] = await Promise.all([
      db.setting.findUnique({ where: { key: DISPATCH_EMAIL_SETTING_KEY } }),
      db.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          customerEmail: true,
          orderNumber: true,
          externalOrderNumber: true,
          _count: { select: { shoppingLinks: true } },
        },
      }),
      db.emailOutbox.findFirst({
        where: { kind: DISPATCH_EMAIL_KIND, referenceType: 'SalesOrder', referenceId: orderId },
        select: { id: true },
      }),
    ])

    const eligibility = evaluateDispatchEmailEligibility({
      settingValue: setting?.value ?? null,
      order: order ? { customerEmail: order.customerEmail, shoppingLinkCount: order._count.shoppingLinks } : null,
      alreadyQueued: existing !== null,
    })
    if (!eligibility.eligible) return { queued: false, reason: eligibility.reason }

    const ref = order!.orderNumber ?? order!.externalOrderNumber ?? orderId.slice(0, 8)
    await queueEmail({
      kind: DISPATCH_EMAIL_KIND,
      to: order!.customerEmail!,
      subject: `Your order ${ref} has been dispatched`,
      html: 'queued',
      referenceType: 'SalesOrder',
      referenceId: orderId,
    })
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
