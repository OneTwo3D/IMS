/**
 * THE PRE-CUTOVER RECONCILIATION OF A SPLIT ORDER'S PART: DID THE INCUMBENT WRITER ALREADY RECORD IT AT THE STOREFRONT?
 *
 * A part the WMS despatched BEFORE the WooCommerce live-from instant belongs to the writer that owned the store then (the
 * WooCommerce-Mintsoft plugin): the producer-side hold shadows IMS's partial-shipment push for it for ever, by design
 * ("the business event happened before the live-from instant"). Left there, the dispatch sweep read that shadow as a part it
 * could not finish and held the whole order pending for ever, so the IMS shipment never completed.
 *
 * What IMS may do instead is not write the part again but VERIFY that the incumbent already did, from the storefront record it
 * already holds, and then complete the IMS side. This module answers that question, and it answers it with NO network:
 * it reads the WooCommerce order deliveries the webhook inbox already stored (`shopping_webhook_events`, resource `orders`, kept
 * at any age while the legacy order-evidence hold stands) and nothing else.
 *
 * WHAT COUNTS AS VERIFIED, deliberately narrow and failing closed:
 *   - the order's link names a WooCommerce order id;
 *   - a stored, processed order delivery for THAT id exists that was received at or after the part's despatch time (an older
 *     delivery cannot say anything about a shipment made after it);
 *   - its status is one the shipment writeback produces: `partial-shipped` (the incumbent recorded at least one part) or
 *     `completed` (it recorded the shipment in full). Any other status - `processing`, `on-hold`, `cancelled`, a withdrawal
 *     status, an unreadable one - is NOT evidence that a part was recorded.
 * Anything else is `verified: false`, and the sweep keeps the order pending exactly as it did before this module existed.
 *
 * The evidence is order-level, not part-level: a stored delivery does not carry the incumbent's per-part table. That limit is
 * named in the PR as a decision for the owner (whether to require more than the status).
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { normaliseWcOrderStatus } from '../order-status-filter'
import { WC_PARTIAL_SHIPPED_STATUS } from './partial-shipment'
import { WC_WEBHOOK_EVENT_STATUS, WOOCOMMERCE_CONNECTOR } from '@/lib/connectors/shopping-webhook-inbox'

/** The storefront statuses that mean the shipment writeback has recorded a part (or all of them). */
export const INCUMBENT_PART_RECORDED_STATUSES: ReadonlySet<string> = new Set([WC_PARTIAL_SHIPPED_STATUS, 'completed'])

export type IncumbentPartialShipmentVerdict = { verified: boolean; detail: string }

/** The pure decision over one stored delivery. Never throws. */
export function classifyStoredWcOrderDelivery(
  delivery: { receivedAt: Date; status: unknown } | null,
  despatchedAt: Date | null,
): IncumbentPartialShipmentVerdict {
  if (delivery === null) return { verified: false, detail: 'no stored WooCommerce order delivery for this order' }
  if (despatchedAt !== null && delivery.receivedAt.getTime() < despatchedAt.getTime()) {
    return { verified: false, detail: 'the latest stored WooCommerce order delivery predates the part\'s despatch' }
  }
  const slug = normaliseWcOrderStatus(delivery.status)
  if (!INCUMBENT_PART_RECORDED_STATUSES.has(slug)) {
    return { verified: false, detail: `the stored WooCommerce status is "${slug || 'unreadable'}", which does not show a recorded shipment` }
  }
  return { verified: true, detail: `the stored WooCommerce order delivery shows status "${slug}" after the part's despatch` }
}

/** The stored deliveries that can speak for one WooCommerce order since a part's despatch. Exported so the DB tier runs the real statement. */
export function incumbentDeliveryWhere(wcOrderId: number, despatchedAt: Date | null): Prisma.ShoppingWebhookEventWhereInput {
  return {
    connector: WOOCOMMERCE_CONNECTOR,
    resource: 'orders',
    status: WC_WEBHOOK_EVENT_STATUS.processed,
    payloadJson: { path: ['id'], equals: wcOrderId },
    ...(despatchedAt ? { receivedAt: { gte: despatchedAt } } : {}),
  }
}

/** Read the locally stored storefront record for an IMS order and decide. Local reads only. */
export async function verifyIncumbentPartialShipment(
  orderId: string,
  input: { despatchedAt?: Date | null },
): Promise<IncumbentPartialShipmentVerdict> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { order: { id: orderId }, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link?.externalOrderId) return { verified: false, detail: 'the order has no WooCommerce link' }
  const wcId = Number(link.externalOrderId)
  if (!Number.isSafeInteger(wcId)) return { verified: false, detail: 'the WooCommerce order id is not readable' }
  const despatchedAt = input.despatchedAt ?? null
  const delivery = await db.shoppingWebhookEvent.findFirst({
    where: incumbentDeliveryWhere(wcId, despatchedAt),
    orderBy: { receivedAt: 'desc' },
    select: { receivedAt: true, payloadJson: true },
  })
  if (!delivery) return classifyStoredWcOrderDelivery(null, despatchedAt)
  const payload = delivery.payloadJson as { status?: unknown } | null
  return classifyStoredWcOrderDelivery({ receivedAt: delivery.receivedAt, status: payload?.status }, despatchedAt)
}
