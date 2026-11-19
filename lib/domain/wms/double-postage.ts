/**
 * DOUBLE-POSTAGE FLAG ON ORDERS ABSORBED BY A MINTSOFT MERGE (o3d-zvec.14).
 *
 * When Mintsoft merges several orders into one, every one of them may have charged the customer postage while the
 * warehouse ships a single parcel. IMS cannot tell whether the customer was over-charged (that is a commercial call),
 * and it NEVER refunds automatically. It raises a flag on the absorbed order's push link, which Sync > Exceptions lists
 * for an IMS operator until the operator clears it.
 *
 * The flag is for IMS operators, not the warehouse: Mintsoft staff do not read notes and no warehouse action is needed,
 * so no Mintsoft comment and no "Raise a warehouse query" task is written. Nothing here calls Mintsoft or WooCommerce.
 *
 * RULE. Called after a link has been re-pointed at the survivor (state MERGED). The merged group is every live link on
 * the same warehouse order id. The flag is raised on THIS link when this order is not cancelled, charged postage
 * (shippingForeign above zero), and at least one OTHER live, non-cancelled order of the group charged it too. It is raised
 * at most once per link (a flag already standing is kept) and is best-effort: a failure is logged, never thrown, so the
 * dispatch and push sweeps are never blocked by it.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

type GroupOrder = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  currency: string
  shippingForeign: unknown
  status: string
}

export type DoublePostageDecision =
  | { raise: false }
  | { raise: true; detail: string }

function label(order: GroupOrder): string {
  return order.externalOrderNumber ?? order.orderNumber ?? order.id
}

/** Pure decision: should the flag be raised for `self`, given every order of the merged group (self included)? */
export function decideDoublePostage(
  self: GroupOrder,
  group: readonly GroupOrder[],
  survivorNumber: string | null,
): DoublePostageDecision {
  const paid = (order: GroupOrder) => order.status !== 'CANCELLED' && toDecimal(order.shippingForeign as DecimalInput).gt(0)
  if (!paid(self)) return { raise: false }
  const charged = group.filter(paid)
  if (charged.length < 2) return { raise: false }
  const amounts = charged.map((order) => `#${label(order)} (${order.currency} ${toDecimal(order.shippingForeign as DecimalInput).toFixed(2)})`).join(', ')
  return {
    raise: true,
    detail:
      `The warehouse merged this order into ${survivorNumber ? `order ${survivorNumber}` : 'another order'}, and ${charged.length} orders in the merge charged the customer postage: ${amounts}. `
      + 'The customer was possibly charged postage twice for one parcel. IMS does not refund automatically: check the orders, refund the extra postage by hand if it is due, then clear this flag.',
  }
}

/** The slice of a Prisma client (the shared one, or a transaction's) the flag needs. */
export type DoublePostageClient = Pick<Prisma.TransactionClient, 'wmsOrderPushLink' | 'salesOrder'>

/**
 * The flag evaluation on the GIVEN client, THROWING on a database error: a caller inside a transaction wants the failure to abort the write, not to
 * be swallowed after the write committed. Returns whether a flag was raised.
 */
export async function raiseDoublePostageForMergedLink(client: DoublePostageClient, linkId: string): Promise<boolean> {
  const link = await client.wmsOrderPushLink.findUnique({
    where: { id: linkId },
    select: { id: true, orderId: true, connector: true, externalOrderId: true, externalOrderNumber: true, doublePostageAt: true },
  })
  if (!link || !link.externalOrderId || link.doublePostageAt) return false
  const siblings = await client.wmsOrderPushLink.findMany({
    where: { connector: link.connector, externalOrderId: link.externalOrderId, state: { in: ['SYNCED', 'MERGED'] } },
    select: { orderId: true },
  })
  const orderIds = [...new Set([link.orderId, ...siblings.map((row) => row.orderId)])]
  const orders = await client.salesOrder.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, orderNumber: true, externalOrderNumber: true, currency: true, shippingForeign: true, status: true },
  })
  const self = orders.find((order) => order.id === link.orderId)
  if (!self) return false
  const decision = decideDoublePostage(self, orders, link.externalOrderNumber)
  if (!decision.raise) return false
  const written = await client.wmsOrderPushLink.updateMany({
    where: { id: link.id, doublePostageAt: null },
    data: { doublePostageAt: new Date(), doublePostageDetail: decision.detail },
  })
  return written.count > 0
}

/** Raise the flag for a link that has just been re-pointed at a merge survivor. Never throws. Returns whether a flag was raised. */
export async function flagDoublePostageForMergedLink(linkId: string): Promise<boolean> {
  try {
    return await raiseDoublePostageForMergedLink(db, linkId)
  } catch (error) {
    console.error(`[wms-double-postage] could not evaluate the double-postage flag for link ${linkId}`, error)
    return false
  }
}
