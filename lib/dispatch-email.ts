/**
 * Direct-order dispatch email (onetwo3d-ims-q66in.1.6).
 *
 * Storefront orders get their dispatch email from the storefront itself
 * (pushOrderDeliveryMetadata → WC tracking writeback triggers WooCommerce's
 * own "completed" email) until switchover step W. Direct IMS orders (no
 * ShoppingOrderLink) get nothing, so this queues an IMS-native dispatch email
 * for them — opt-in via the `dispatch_email_enabled` setting (default OFF),
 * and queued at most once per order (deduped against the outbox under the
 * order row lock).
 *
 * STOREFRONT ORDERS (o3d-zvec.24): governed by their OWN switch,
 * `storefront_customer_email_enabled` (default OFF; see
 * lib/domain/storefront-customer-email/constants.ts). With it off a storefront
 * order is skipped (`storefront_order`) exactly as before, so WooCommerce's own
 * e-mail is never doubled. With it on, IMS queues the same single dispatch
 * email for the storefront order and WooCommerce's native e-mail must be off
 * (writers:check P2-W reads both).
 *
 * This file is NOT 'use server' — it cannot be called directly from the client.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { isUndeliveredEmailCollision } from '@/lib/email-outbox'
import {
  STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY,
  STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY,
  STOREFRONT_DISPATCHED_MAX_AGE_MS,
  parseStorefrontEmailEnabledAt,
} from '@/lib/domain/storefront-customer-email/constants'

export const DISPATCH_EMAIL_SETTING_KEY = 'dispatch_email_enabled'
export const DISPATCH_EMAIL_KIND = 'SHIPMENT_DISPATCHED'

export type DispatchEmailEligibilityInput = {
  settingValue: string | null
  /** `storefront_customer_email_enabled`: the switch for a storefront-linked order. Absent reads as off. */
  storefrontSettingValue?: string | null
  /** `storefront_customer_email_enabled_at`: when the storefront switch was turned on. Null/absent = unknown: a storefront order is not e-mailed. */
  storefrontEnabledAt?: Date | null
  now?: Date
  /** `shippedAt`: when the order was despatched; read for a storefront order only (the history guards). */
  order: { status: string; customerEmail: string | null; shoppingLinkCount: number; shippedAt?: Date | null } | null
  alreadyQueued: boolean
}

export type DispatchEmailEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'disabled' | 'order_not_found' | 'order_not_shipped' | 'storefront_order' | 'storefront_before_switch_on' | 'storefront_too_old' | 'no_customer_email' | 'already_queued' }

/**
 * Pure decision: should a dispatch email be queued for this order?
 * Storefront-linked orders are excluded unless the storefront switch is on, so
 * WooCommerce's own dispatch email is never doubled up. Requiring status exactly SHIPPED (not COMPLETED or
 * DELIVERED) bounds the retry-heal window so historic orders reprocessed by
 * a sweep never get a late email.
 */
export function evaluateDispatchEmailEligibility(input: DispatchEmailEligibilityInput): DispatchEmailEligibility {
  const storefront = input.order !== null && input.order.shoppingLinkCount > 0
  // A storefront-linked order is governed by the storefront switch ALONE; any other order by `dispatch_email_enabled`.
  if (storefront) {
    if (input.storefrontSettingValue !== 'true') return { eligible: false, reason: 'storefront_order' }
  } else if (input.settingValue !== 'true') return { eligible: false, reason: 'disabled' }
  if (!input.order) return { eligible: false, reason: 'order_not_found' }
  if (input.order.status !== 'SHIPPED') return { eligible: false, reason: 'order_not_shipped' }
  if (!input.order.customerEmail) return { eligible: false, reason: 'no_customer_email' }
  if (storefront) {
    // HISTORY IS NOT RE-ANNOUNCED for a storefront order: WooCommerce's "completed" e-mail went out for anything despatched before IMS took over, and a SHIPPED
    // order is re-run by any later status call. The despatch must be AFTER the switch-on instant and recent.
    const shippedAt = input.order.shippedAt ?? null
    const enabledAt = input.storefrontEnabledAt ?? null
    if (shippedAt === null || enabledAt === null || shippedAt.getTime() < enabledAt.getTime()) return { eligible: false, reason: 'storefront_before_switch_on' }
    if ((input.now ?? new Date()).getTime() - shippedAt.getTime() > STOREFRONT_DISPATCHED_MAX_AGE_MS) return { eligible: false, reason: 'storefront_too_old' }
  }
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
    const settings = await db.setting.findMany({ where: { key: { in: [DISPATCH_EMAIL_SETTING_KEY, STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY, STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY] } }, select: { key: true, value: true } })
    const settingValue = settings.find((row) => row.key === DISPATCH_EMAIL_SETTING_KEY)?.value ?? null
    const storefrontSettingValue = settings.find((row) => row.key === STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY)?.value ?? null
    const storefrontEnabledAt = parseStorefrontEmailEnabledAt(settings.find((row) => row.key === STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY)?.value)
    if (settingValue !== 'true' && storefrontSettingValue !== 'true') return { queued: false, reason: 'disabled' }

    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      const order = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          erasedAt: true,
          customer: { select: { gdprAnonymisedAt: true } },
          customerEmail: true,
          orderNumber: true,
          externalOrderNumber: true,
          shippedAt: true,
          _count: { select: { shoppingLinks: true } },
        },
      })
      // Read under the order lock just taken: an erased order, or one whose customer is erased, gets no email.
      if (order?.erasedAt || order?.customer?.gdprAnonymisedAt) return { queued: false as const, reason: 'recipient_erased' as const }
      const existing = await tx.emailOutbox.findFirst({
        where: { kind: DISPATCH_EMAIL_KIND, referenceType: 'SalesOrder', referenceId: orderId },
        select: { id: true },
      })

      const eligibility = evaluateDispatchEmailEligibility({
        settingValue,
        storefrontSettingValue,
        storefrontEnabledAt,
        now: new Date(),
        order: order
          ? { status: order.status, customerEmail: order.customerEmail, shoppingLinkCount: order._count.shoppingLinks, shippedAt: order.shippedAt }
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
    // o3d-alnk: `email_outbox_undelivered_reference_uq` refuses a second undelivered row for
    // this (kind, SalesOrder, orderId). The findFirst above already covers the same-order case
    // because it runs under the order row lock, so reaching here means a writer this lock does
    // not serialise — which is exactly what the index exists to catch. Caught OUT HERE and not
    // inside the transaction on purpose: a P2002 swallowed inside an interactive transaction
    // leaves it aborted (Postgres 25P02, see lib/db/prisma-unique-violation.ts), so the
    // transaction must be allowed to roll back first.
    if (isUndeliveredEmailCollision(error)) return { queued: false, reason: 'already_queued' }
    console.error(`Failed to queue dispatch email for order ${orderId}`, error)
    return { queued: false, reason: String(error) }
  }
}
