import type { Prisma } from '@/app/generated/prisma/client'
import { notify } from '@/lib/notifications'
import {
  EMPTY_WAREHOUSE_SUMMARY, defaultSystemVerdicts,
  type ErasureExternalSystem, type ErasureSystemVerdict, type ErasureTrigger, type ErasureWarehouseSummary,
} from './erasure-record'

/**
 * THE WAREHOUSE'S COPY OF AN ERASED ORDER, enumerated at erasure (IMS only: nothing is written to the warehouse).
 *
 * Mintsoft exposes no erase endpoint, and the only way to change an order is a whole-order replace that IMS refuses unless the order is still new. An erasure
 * therefore never becomes an outbound write (the push guard in lib/domain/wms/order-push-sweep.ts refuses an erased order, create and amend alike). What IMS can
 * do is be honest about what remains: for each of the subject's orders with a warehouse link it records whether the order is
 *   - despatched (shipped or delivered, or a shipment exists): the warehouse has the person's data and cannot be made to erase it;
 *   - open (pushed, not despatched, not cancelled): the person's name and address are still on a live warehouse order. NOT propagated by owner ruling (no write
 *     to the live warehouse): an operator handles each by hand, so each is listed and the operator is told at once;
 *   - cancelled in the warehouse, or never pushed (no warehouse order id): nothing to hand-handle.
 * A link parked MERGED means the warehouse merged the order into another and the data lives on under the combined order; it is counted as well.
 */
const DESPATCHED_ORDER_STATUSES = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

export async function summariseWarehouseOrdersInTx(
  tx: Pick<Prisma.TransactionClient, 'wmsOrderPushLink' | 'salesOrder'>,
  orderIds: string[],
): Promise<ErasureWarehouseSummary> {
  const out: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [] }
  if (orderIds.length === 0) return out
  const links = await tx.wmsOrderPushLink.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, state: true, externalOrderId: true, externalOrderNumber: true },
    orderBy: { orderId: 'asc' },
  })
  if (links.length === 0) return out
  const orders = await tx.salesOrder.findMany({ where: { id: { in: links.map((l) => l.orderId) } }, select: { id: true, status: true, _count: { select: { shipments: true } } } })
  const byId = new Map(orders.map((o) => [o.id, o]))
  for (const link of links) {
    if (!link.externalOrderId) { out.notPushed += 1; continue }
    out.linkedOrders += 1
    if (link.state === 'MERGED') out.merged += 1
    const order = byId.get(link.orderId)
    if (link.state === 'CANCELLED') { out.cancelled += 1; continue }
    if (order && (DESPATCHED_ORDER_STATUSES.has(order.status) || order._count.shipments > 0)) { out.despatched += 1; continue }
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
    warehouse: w.open > 0 ? 'refused' : (w.despatched > 0 || w.cancelled > 0) ? 'not-technically-possible' : 'not-applicable',
  }
}

export const OPEN_WAREHOUSE_ERASURE_NOTICE_TITLE = 'Personal data remains in the warehouse'

/** The operator-readable sentence for a count. Identity-free by construction: it carries a number and a request id. */
export function openWarehouseOrdersWarning(open: number): string {
  return `${open} open warehouse order${open === 1 ? '' : 's'} still hold${open === 1 ? 's' : ''} the erased person's name and address. IMS does not write to the live warehouse, so ${open === 1 ? 'it needs' : 'they need'} handling by hand in Mintsoft (see Settings > Erasure records).`
}

/** After the erasure committed: tell the operators. Never throws (a notification failure must not undo or hide an erasure). */
export async function notifyOpenWarehouseOrders(summary: ErasureWarehouseSummary, requestId: string): Promise<void> {
  if (summary.open === 0) return
  await notify({
    type: 'warning',
    title: OPEN_WAREHOUSE_ERASURE_NOTICE_TITLE,
    message: `${openWarehouseOrdersWarning(summary.open)} Request ${requestId}.`,
    actionUrl: '/settings/erasure',
  })
}
