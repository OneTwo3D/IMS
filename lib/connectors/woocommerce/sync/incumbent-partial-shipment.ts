/**
 * THE PRE-CUTOVER RECONCILIATION OF A SPLIT ORDER'S PART: DID THE INCUMBENT WRITER ALREADY RECORD IT AT THE STOREFRONT?
 *
 * A part the WMS despatched BEFORE the WooCommerce live-from instant belongs to the writer that owned the store then (the
 * earlier warehouse-sync plugin): the producer-side hold shadows IMS's partial-shipment push for it for ever, by design
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
 *   - the LATEST stored, processed order delivery for THAT id (by receipt time, then id) was received at or after the LATEST
 *     despatch among the order's despatched parts (the caller passes that instant). A later delivery that is not `completed`
 *     (the order was re-opened after completion) therefore wins and keeps the order pending;
 *   - its status is `completed`, and nothing else. The earlier writer completing the order means every part is on the
 *     storefront. `partial-shipped` is NOT accepted: it only says SOME part was recorded, and a delivery could reflect the first
 *     part and not the second. `processing`, `on-hold`, `cancelled`, a withdrawal status and an unreadable one are not evidence;
 *   - AND WooCommerce's OWN completion instant, read from that stored payload, is at or after the latest despatch. Receipt time
 *     alone is not enough: a delayed delivery (a retry, a replay) can carry a completion from BEFORE the latest part was despatched,
 *     and that completion cannot have covered the part. The instant is `date_completed_gmt` (WooCommerce states it in GMT without
 *     an offset; it is read as UTC) or, only if that is absent, `date_completed` provided it carries an explicit offset. Missing,
 *     unparseable or earlier than the latest despatch: not verified.
 * Anything else is `verified: false`, and the sweep keeps the order pending exactly as it did before this module existed.
 *
 * The evidence is order-level, not part-level: a stored delivery does not carry the incumbent's per-part table. Per-part proof
 * would need the plugin's per-part meta in the payload, or an operator verification; neither exists and neither is built here.
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { normaliseWcOrderStatus } from '../order-status-filter'
import { WC_WEBHOOK_EVENT_STATUS, WOOCOMMERCE_CONNECTOR } from '@/lib/connectors/shopping-webhook-inbox'

/** The only storefront status that shows EVERY part recorded: the earlier writer completed the order. */
export const INCUMBENT_PART_RECORDED_STATUSES: ReadonlySet<string> = new Set(['completed'])

export type IncumbentPartialShipmentVerdict = { verified: boolean; detail: string }

const GMT_NO_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/
const EXPLICIT_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/

/**
 * WooCommerce's completion instant from a stored order payload, or null when it cannot be read as one instant.
 * `date_completed_gmt` is GMT without an offset (read as UTC); `date_completed` is the store's local time and is used only
 * when it carries an explicit offset. Never throws.
 */
export function wcCompletionInstant(payload: { date_completed_gmt?: unknown; date_completed?: unknown } | null | undefined): Date | null {
  const gmt = payload?.date_completed_gmt
  if (typeof gmt === 'string' && gmt.trim() !== '') {
    const text = gmt.trim()
    const at = GMT_NO_OFFSET.test(text) ? new Date(`${text.replace(' ', 'T')}Z`) : EXPLICIT_OFFSET.test(text) ? new Date(text.replace(' ', 'T')) : null
    return at && Number.isFinite(at.getTime()) ? at : null
  }
  const local = payload?.date_completed
  if (typeof local === 'string' && EXPLICIT_OFFSET.test(local.trim())) {
    const at = new Date(local.trim().replace(' ', 'T'))
    return Number.isFinite(at.getTime()) ? at : null
  }
  return null
}

/** The pure decision over the latest stored delivery. Never throws. */
export function classifyStoredWcOrderDelivery(
  delivery: { receivedAt: Date; status: unknown; dateCompletedGmt?: unknown; dateCompleted?: unknown } | null,
  despatchedAt: Date | null,
): IncumbentPartialShipmentVerdict {
  if (delivery === null) return { verified: false, detail: 'no stored WooCommerce order delivery for this order' }
  if (despatchedAt !== null && delivery.receivedAt.getTime() < despatchedAt.getTime()) {
    return { verified: false, detail: 'the latest stored WooCommerce order delivery predates the latest part\'s despatch' }
  }
  const slug = normaliseWcOrderStatus(delivery.status)
  if (!INCUMBENT_PART_RECORDED_STATUSES.has(slug)) {
    return { verified: false, detail: `the latest stored WooCommerce status is "${slug || 'unreadable'}", which does not show every part recorded (only completed does)` }
  }
  const completedAt = wcCompletionInstant({ date_completed_gmt: delivery.dateCompletedGmt, date_completed: delivery.dateCompleted })
  if (completedAt === null) {
    return { verified: false, detail: 'the stored delivery carries no readable WooCommerce completion date (date_completed_gmt)' }
  }
  if (despatchedAt !== null && completedAt.getTime() < despatchedAt.getTime()) {
    return { verified: false, detail: 'WooCommerce completed the order before the latest part was despatched, so the completion cannot have covered it' }
  }
  return { verified: true, detail: `the latest stored WooCommerce delivery shows the order completed at ${completedAt.toISOString()}, at or after the latest part's despatch` }
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
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    select: { receivedAt: true, payloadJson: true },
  })
  if (!delivery) return classifyStoredWcOrderDelivery(null, despatchedAt)
  const payload = delivery.payloadJson as { status?: unknown; date_completed_gmt?: unknown; date_completed?: unknown } | null
  return classifyStoredWcOrderDelivery({
    receivedAt: delivery.receivedAt,
    status: payload?.status,
    dateCompletedGmt: payload?.date_completed_gmt,
    dateCompleted: payload?.date_completed,
  }, despatchedAt)
}
