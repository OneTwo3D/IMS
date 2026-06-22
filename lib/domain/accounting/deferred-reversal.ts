import type { PrismaClient } from '@/app/generated/prisma/client'
import { extractUnearnedReversalDebit } from './revenue-recognition'

/** Both the live transaction client and the top-level db client satisfy this. */
type DeferredReversalClient = Pick<PrismaClient, 'salesOrderRefund' | 'accountingSyncLog'>

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
