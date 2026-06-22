import type { PrismaClient } from '@/app/generated/prisma/client'
import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { extractUnearnedReversalDebit } from './revenue-recognition'

/** Both the live transaction client and the top-level db client satisfy this. */
type DeferredReversalClient = Pick<PrismaClient, 'salesOrderRefund' | 'accountingSyncLog'>

type FullShipClient = Pick<PrismaClient, 'salesOrderLine' | 'shipmentLine' | 'salesOrderRefundLine'>

// Engine-scale qty tolerance (matches the 6dp FIFO engine) so fractional rounding on a
// fully-shipped line isn't mistaken for a remaining unshipped sliver.
const FULL_SHIP_QTY_TOLERANCE = 1e-6

/**
 * scjz.68: order IDs whose every SHIPPABLE product line is fully shipped once
 * refunded-while-unshipped units are excluded — i.e. nothing more will ship, so the
 * remaining deferred revenue (incl. the order-level shipping share) is safe to true up.
 *
 * Not used for SHIPPED/COMPLETED/DELIVERED orders (their status already guarantees this);
 * it lets PARTIALLY_REFUNDED orders — which can sit at that status while genuinely fully
 * shipped — qualify for the final true-up without the residual-threshold heuristic, which
 * couldn't tell unshipped product value apart from unrecognized shipping.
 *
 * Per line: shipped qty (all shipments) + refunded-while-UNSHIPPED qty must cover the
 * ordered qty. A refund counts as unshipped only when its cost snapshot reversed an
 * allocation (no `shipment`-source entry) — a return of a shipped unit does not reduce the
 * ship obligation, and a refund with no snapshot is treated conservatively as not-unshipped.
 * Non-shippable lines (no product, or NON_INVENTORY service/fee) never ship and are ignored.
 */
export async function loadFullyShippedNetOfRefundsOrderIds(
  client: FullShipClient,
  orderIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>()
  if (orderIds.length === 0) return result

  const [orderLines, shipmentLines, refundLines] = await Promise.all([
    client.salesOrderLine.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true, orderId: true, qty: true, productId: true, product: { select: { type: true } } },
    }),
    client.shipmentLine.findMany({
      where: { shipment: { orderId: { in: orderIds } } },
      select: { lineId: true, qty: true },
    }),
    client.salesOrderRefundLine.findMany({
      where: { refund: { orderId: { in: orderIds } } },
      select: { salesOrderLineId: true, qty: true, costLayerSnapshot: true },
    }),
  ])

  const shippedByLine = new Map<string, number>()
  for (const sl of shipmentLines) {
    shippedByLine.set(sl.lineId, (shippedByLine.get(sl.lineId) ?? 0) + Number(sl.qty))
  }
  const refundedUnshippedByLine = new Map<string, number>()
  for (const rl of refundLines) {
    if (!rl.salesOrderLineId) continue
    const entries = parseCostLayerSnapshot(rl.costLayerSnapshot)
    const refundedWhileUnshipped = entries.length > 0 && !entries.some((entry) => entry.source === 'shipment')
    if (!refundedWhileUnshipped) continue
    refundedUnshippedByLine.set(rl.salesOrderLineId, (refundedUnshippedByLine.get(rl.salesOrderLineId) ?? 0) + Number(rl.qty))
  }

  const linesByOrder = new Map<string, Array<{ id: string; qty: number; shippable: boolean }>>()
  for (const line of orderLines) {
    const shippable = !!line.productId && line.product?.type !== 'NON_INVENTORY'
    const arr = linesByOrder.get(line.orderId) ?? []
    arr.push({ id: line.id, qty: Number(line.qty), shippable })
    linesByOrder.set(line.orderId, arr)
  }
  for (const [orderId, lines] of linesByOrder) {
    const fullyShipped = lines.every((line) => (
      !line.shippable ||
      (shippedByLine.get(line.id) ?? 0) + (refundedUnshippedByLine.get(line.id) ?? 0) + FULL_SHIP_QTY_TOLERANCE >= line.qty
    ))
    if (fullyShipped) result.add(orderId)
  }
  return result
}

/**
 * scjz.68: sum the already-posted UNEARNED_REV_REVERSAL (refund-of-unshipped-lines
 * deferral reversal) per order, so the daily-batch deferred-revenue true-up — and its
 * preview — can be reversal-aware and never re-recognize what a refund already reversed.
 * Shared by the Xero + QuickBooks daily syncs and the Xero daily-batch preview so all
 * three agree on the remaining deferred balance.
 */
export async function loadPostedUnearnedReversalByOrder(
  client: DeferredReversalClient,
  opts: { orderIds: string[]; connector: string; unearnedAccountCode: string },
): Promise<Map<string, number>> {
  const byOrder = new Map<string, number>()
  if (opts.orderIds.length === 0) return byOrder

  const refunds = await client.salesOrderRefund.findMany({
    where: { orderId: { in: opts.orderIds } },
    select: { id: true, orderId: true },
  })
  if (refunds.length === 0) return byOrder

  const refundIdToOrderId = new Map(refunds.map((refund) => [refund.id, refund.orderId]))
  const logs = await client.accountingSyncLog.findMany({
    where: {
      connector: opts.connector,
      type: 'UNEARNED_REV_REVERSAL',
      referenceType: 'SalesOrderRefund',
      referenceId: { in: refunds.map((refund) => refund.id) },
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
    select: { referenceId: true, payload: true },
  })
  for (const log of logs) {
    const orderId = refundIdToOrderId.get(log.referenceId)
    if (!orderId) continue
    byOrder.set(
      orderId,
      (byOrder.get(orderId) ?? 0) + extractUnearnedReversalDebit(log.payload, opts.unearnedAccountCode),
    )
  }
  return byOrder
}
