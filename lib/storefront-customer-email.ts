/**
 * Customer e-mail for STOREFRONT orders, queued by IMS (o3d-zvec.24): order confirmation, partial shipment and delivered. (The "dispatched" e-mail is
 * `lib/dispatch-email.ts`, which now also covers a storefront order when the switch is on.) The rules, the switch and the single-send contract are in
 * `lib/domain/storefront-customer-email/constants.ts`; this file is the database side. NOT 'use server': it cannot be called from the client.
 *
 * Every function here NEVER THROWS (the order import, the shipment despatch and the status change that call it must not fail because a courtesy e-mail could
 * not be queued) and reads the switch FIRST, so with the switch off (the default) none of them touches anything else.
 *
 * Queued under the order row lock: the existence check (any status of the same kind) and the insert are one transaction, so concurrent despatch retries
 * (the screen and the WMS sweep) cannot both queue, while a retry after a crashed enqueue heals. A second undelivered row is also refused by the
 * database (`email_outbox_undelivered_reference_uq`); that collision is reported as `already_queued`, not as an error.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { isUndeliveredEmailCollision } from '@/lib/email-outbox'
import { isStorefrontCustomerEmailEnabled } from '@/lib/domain/storefront-customer-email/switch'
import {
  STOREFRONT_CONFIRMATION_KIND,
  STOREFRONT_DELIVERED_KIND,
  evaluateStorefrontEmailEligibility,
  storefrontPartialKind,
  type StorefrontEmailKindName,
} from '@/lib/domain/storefront-customer-email/constants'

type QueueResult = { queued: boolean; reason?: string }

const SUBJECT: Record<StorefrontEmailKindName, (ref: string) => string> = {
  confirmation: (ref) => `Order Confirmation ${ref}`,
  partial: (ref) => `Part of your order ${ref} has been dispatched`,
  delivered: (ref) => `Your order ${ref} has been delivered`,
}

async function queueStorefrontEmail(params: { name: StorefrontEmailKindName; kind: string; orderId: string; shipmentId?: string }): Promise<QueueResult> {
  const { name, kind, orderId } = params
  try {
    if (!(await isStorefrontCustomerEmailEnabled())) return { queued: false, reason: 'disabled' }

    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      const order = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          isQuote: true,
          erasedAt: true,
          customer: { select: { gdprAnonymisedAt: true } },
          customerEmail: true,
          orderNumber: true,
          externalOrderNumber: true,
          externalCreatedAt: true,
          shippedAt: true,
          createdAt: true,
          _count: { select: { shoppingLinks: true } },
        },
      })
      // Read under the order lock just taken: an erased order, or one whose customer is erased, gets no e-mail.
      if (order?.erasedAt || order?.customer?.gdprAnonymisedAt) return { queued: false as const, reason: 'recipient_erased' }
      const shipment = params.shipmentId
        ? await tx.shipment.findUnique({ where: { id: params.shipmentId }, select: { status: true, shippedAt: true, orderId: true } })
        : null
      // ANY status of this kind counts: a FAILED row (an unknown outcome included) is not queued again automatically. A person re-sends it.
      const existing = await tx.emailOutbox.findFirst({ where: { kind, referenceType: 'SalesOrder', referenceId: orderId }, select: { id: true } })
      const eligibility = evaluateStorefrontEmailEligibility({
        kind: name,
        settingValue: 'true',
        now: new Date(),
        orderId,
        order: order
          ? {
            status: order.status,
            isQuote: order.isQuote,
            customerEmail: order.customerEmail,
            shoppingLinkCount: order._count.shoppingLinks,
            placedAt: order.externalCreatedAt ?? order.createdAt,
            shippedAt: order.shippedAt,
          }
          : null,
        shipment,
        alreadyQueued: existing !== null,
      })
      if (!eligibility.eligible) return { queued: false as const, reason: eligibility.reason }

      const ref = order!.orderNumber ?? order!.externalOrderNumber ?? orderId.slice(0, 8)
      await tx.emailOutbox.create({
        data: {
          kind,
          toEmail: order!.customerEmail!.trim().toLowerCase(),
          subject: SUBJECT[name](ref),
          html: 'queued',
          referenceType: 'SalesOrder',
          referenceId: orderId,
        },
      })
      return { queued: true as const, ref }
    })
    if (!outcome.queued) return outcome

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'storefront_customer_email_queued',
      tag: 'sales',
      level: 'INFO',
      description: `Queued ${name} e-mail for storefront order ${outcome.ref}`,
      metadata: { kind },
      resolveUser: false,
    })
    return { queued: true }
  } catch (error) {
    // The database refused a second undelivered row for this (kind, order): a writer the order lock does not serialise, which is what the index is for.
    if (isUndeliveredEmailCollision(error)) return { queued: false, reason: 'already_queued' }
    console.error(`Failed to queue storefront ${name} e-mail for order ${orderId}`, error)
    return { queued: false, reason: 'error' }
  }
}

/** After the order is imported from the storefront. */
export function queueStorefrontConfirmationIfEligible(orderId: string): Promise<QueueResult> {
  return queueStorefrontEmail({ name: 'confirmation', kind: STOREFRONT_CONFIRMATION_KIND, orderId })
}

/** After one shipment of an order that still owes more has despatched. One e-mail per shipment. */
export async function queueStorefrontPartialShipmentEmailIfEligible(shipmentId: string): Promise<QueueResult> {
  try {
    if (!(await isStorefrontCustomerEmailEnabled())) return { queued: false, reason: 'disabled' }
    const shipment = await db.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true } })
    if (!shipment) return { queued: false, reason: 'shipment_not_found' }
    return await queueStorefrontEmail({ name: 'partial', kind: storefrontPartialKind(shipmentId), orderId: shipment.orderId, shipmentId })
  } catch (error) {
    console.error(`Failed to queue storefront partial-shipment e-mail for shipment ${shipmentId}`, error)
    return { queued: false, reason: 'error' }
  }
}

/** After the order is marked DELIVERED. */
export function queueStorefrontDeliveredEmailIfEligible(orderId: string): Promise<QueueResult> {
  return queueStorefrontEmail({ name: 'delivered', kind: STOREFRONT_DELIVERED_KIND, orderId })
}
