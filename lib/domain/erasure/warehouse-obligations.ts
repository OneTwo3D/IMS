import type { Prisma } from '@/app/generated/prisma/client'
import { notify } from '@/lib/notifications'
import {
  EMPTY_WAREHOUSE_SUMMARY, defaultSystemVerdicts,
  type ErasureExternalSystem, type ErasureSystemVerdict, type ErasureTrigger, type ErasureWarehouseSummary,
} from './erasure-record'

/**
 * THE WAREHOUSE'S COPY OF AN ERASED ORDER, enumerated at erasure (IMS only: nothing is written to the warehouse).
 *
 * The warehouse exposes no erase endpoint, and the only way to change an order is a whole-order replace that IMS refuses unless the order is still new. An erasure
 * therefore never becomes an outbound write (the push guard in lib/domain/wms/order-push-sweep.ts refuses an erased order, create and amend alike). What IMS can
 * do is be honest about what remains: for each of the subject's orders with a warehouse link it records whether the order is
 *   - despatched (the order is SHIPPED, COMPLETED or DELIVERED, which IMS reaches only when everything has gone): the warehouse has the person's data and cannot be made to erase it;
 *   - open (pushed, not wholly despatched, not cancelled: a pending shipment or a partial dispatch is still open): the person's name and address are still on a live warehouse order. NOT propagated by owner ruling (no write
 *     to the live warehouse): an operator handles each by hand, so each is listed and the operator is told at once;
 *   - ambiguous (no warehouse order id, but a create was attempted): the order may exist in the warehouse; listed for the operator to verify;
 *   - cancelled in the warehouse, or provably never sent (never claimed, no attempts, or a payload that could not be built): nothing to hand-handle.
 * A link parked MERGED means the warehouse merged the order into another and the data lives on under the combined order; it is counted as well.
 */
const DESPATCHED_ORDER_STATUSES = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

export async function summariseWarehouseOrdersInTx(
  tx: Pick<Prisma.TransactionClient, 'wmsOrderPushLink' | 'salesOrder'>,
  orderIds: string[],
): Promise<ErasureWarehouseSummary> {
  const out: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [], ambiguousOrders: [] }
  if (orderIds.length === 0) return out
  const links = await tx.wmsOrderPushLink.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, state: true, externalOrderId: true, externalOrderNumber: true, attempts: true, lastAttemptAt: true, firstClaimedAt: true },
    orderBy: { orderId: 'asc' },
  })
  if (links.length === 0) return out
  const orders = await tx.salesOrder.findMany({ where: { id: { in: links.map((l) => l.orderId) } }, select: { id: true, status: true } })
  const byId = new Map(orders.map((o) => [o.id, o]))
  for (const link of links) {
    if (!link.externalOrderId) {
      // No warehouse order id is recorded. That is NOT proof nothing is held there: a create is claimed (lastAttemptAt, firstClaimedAt, attempts) immediately before
      // the remote call, and a call that succeeded but whose answer was lost leaves a warehouse order with no id here. Only a link that provably never sent anything
      // (never claimed, no attempts, or a payload that could not even be built) is "not pushed"; the rest is ambiguous and listed for verification.
      const neverSent = link.state === 'VALIDATION_FAILED' && link.attempts === 0
      const attempted = link.state === 'AMBIGUOUS_CREATE' || link.state === 'PENDING_VERIFY' || link.attempts > 0 || link.lastAttemptAt !== null || link.firstClaimedAt !== null
      if (attempted && !neverSent) { out.ambiguous += 1; out.ambiguousOrders.push({ orderId: link.orderId }) } else out.notPushed += 1
      continue
    }
    out.linkedOrders += 1
    if (link.state === 'MERGED') out.merged += 1
    const order = byId.get(link.orderId)
    if (link.state === 'CANCELLED') { out.cancelled += 1; continue }
    // DESPATCHED means the whole order has gone: the order status reaches SHIPPED only when every shipment has (a partial dispatch leaves the order before SHIPPED),
    // so a pending, picking or packed shipment, and a partly shipped order, are still OPEN: the undespatched part is a live warehouse order holding the details.
    if (order && DESPATCHED_ORDER_STATUSES.has(order.status)) { out.despatched += 1; continue }
    out.open += 1
    out.openOrders.push({ orderId: link.orderId, warehouseOrderNumber: link.externalOrderNumber ?? null })
  }
  return out
}

/** The verdict of each external system, from what the erasure found. */
export function decideSystemVerdicts(input: { trigger: ErasureTrigger; warehouse: ErasureWarehouseSummary; accountingTraces: boolean }): Record<ErasureExternalSystem, ErasureSystemVerdict> {
  const base = defaultSystemVerdicts(input.trigger)
  const w = input.warehouse
  return {
    ...base,
    // The Xero contact (name and email) is left as it is by owner ruling, pending the accountant / DPO: its name shows on every historical invoice.
    accounting: input.accountingTraces ? 'refused-pending-legal' : 'not-applicable',
    // An ambiguous link is never read as "nothing held": the order may be live in the warehouse, so it is the same verdict as an open one (not written; verify by hand).
    warehouse: (w.open > 0 || w.ambiguous > 0) ? 'refused' : (w.despatched > 0 || w.cancelled > 0) ? 'not-technically-possible' : 'not-applicable',
  }
}

export const OPEN_WAREHOUSE_ERASURE_NOTICE_TITLE = 'Personal data remains in the warehouse'

/** The operator-readable sentence for a count. Identity-free by construction: it carries a number and a request id. */
export function openWarehouseOrdersWarning(open: number, ambiguous = 0): string {
  const parts: string[] = []
  if (open > 0) parts.push(`${open} open warehouse order${open === 1 ? '' : 's'} still hold${open === 1 ? 's' : ''} the erased person's name and address`)
  if (ambiguous > 0) parts.push(`${ambiguous} warehouse order${ambiguous === 1 ? '' : 's'} may exist there (a create was sent and its outcome was never recorded) and must be checked`)
  return `${parts.join(', and ')}. IMS does not write to the live warehouse, so each needs handling by hand in the warehouse system (see Settings > Erasure records).`
}

/** After the erasure committed: tell the operators. Never throws (a notification failure must not undo or hide an erasure). */
export async function notifyOpenWarehouseOrders(summary: ErasureWarehouseSummary, requestId: string): Promise<void> {
  if (summary.open === 0 && summary.ambiguous === 0) return
  await notify({
    type: 'warning',
    title: OPEN_WAREHOUSE_ERASURE_NOTICE_TITLE,
    message: `${openWarehouseOrdersWarning(summary.open, summary.ambiguous)} Request ${requestId}.`,
    actionUrl: '/settings/erasure',
  })
}
