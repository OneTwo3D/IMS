/**
 * The stock correction a storefront refund owes the store.
 *
 * WooCommerce raises its own stock for a refunded line inside the refund request, before IMS hears of it. IMS is the
 * stock master: with refund-returns-in-transit on, the units are not back yet, so the level the store shows is wrong
 * until they arrive. The correction is a forced push of IMS's ABSOLUTE stock level for the refunded products.
 *
 * ONE DURABLE MECHANISM. The refund row carries the obligation (`stockCorrectionRequired`, written true in the refund's
 * own transaction when it returns quantity) and its discharge (`stockCorrectionQueuedAt`, set once the stock job is
 * durably recorded). Everything that can queue a correction reads the ROW, never the outcome of the call that created
 * the refund, so none of these can lose it:
 *   - a lookup or queue failure leaves the obligation open and the next attempt queues it;
 *   - a refund that committed but whose later steps failed is `already-applied` on the next sweep, and still owes it;
 *   - two refunds on one product while the first job is processing: any enqueue onto a processing job makes it take another pass.
 * Callers: the order webhook's refund sweep (every committed refund of that order, applied or already-applied) and the
 * stock reconcile (every open obligation, any order).
 *
 * Only refunds that returned quantity owe anything (a money-only refund restocks nothing on the store). The push
 * itself is the ordinary stock job, behind the producer seam and the outbound hold: a shadowed push is a recorded
 * shadow and discharges the obligation, as it does for every other stock producer.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { enqueueAndProcessImmediateWcStockSync } from './stock-sync-jobs'

export type RefundStockCorrectionDeps = {
  enqueue: typeof enqueueAndProcessImmediateWcStockSync
}

export type RefundStockCorrectionResult = {
  /** Open obligations found. */
  open: number
  /** Obligations whose stock job was durably recorded in this call. */
  queued: number
  /** Obligations left open because recording the job failed. They are retried. */
  failed: number
}

const DEFAULT_LIMIT = 50

export async function queueRefundStockCorrections(
  scope: { externalOrderId?: number; limit?: number } = {},
  deps: RefundStockCorrectionDeps = { enqueue: enqueueAndProcessImmediateWcStockSync },
): Promise<RefundStockCorrectionResult> {
  const refunds = await db.salesOrderRefund.findMany({
    where: {
      stockCorrectionRequired: true,
      stockCorrectionQueuedAt: null,
      ...(scope.externalOrderId !== undefined
        ? { order: { shoppingLinks: { some: { connector: 'woocommerce', externalOrderId: String(scope.externalOrderId) } } } }
        : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: scope.limit ?? DEFAULT_LIMIT,
    select: {
      id: true,
      orderId: true,
      lines: { where: { qty: { gt: 0 }, productId: { not: null } }, select: { productId: true } },
    },
  })

  const result: RefundStockCorrectionResult = { open: refunds.length, queued: 0, failed: 0 }
  for (const refund of refunds) {
    const productIds = [...new Set(refund.lines.flatMap((line) => (line.productId ? [line.productId] : [])))]
    try {
      const discharge = async () => {
        await db.salesOrderRefund.updateMany({
          where: { id: refund.id, stockCorrectionQueuedAt: null },
          data: { stockCorrectionQueuedAt: new Date() },
        })
      }
      if (productIds.length === 0) {
        // Required but no line names a product any more: nothing can be pushed, and leaving it open would retry for ever.
        await discharge()
      } else {
        // Forced (the lastPushedQty dedupe must not swallow it). A job a worker is processing right now takes another pass whatever its
        // payload (stock-sync-jobs.ts). The obligation is discharged the moment the job is recorded,
        // BEFORE it is processed: processing is retried by the job itself.
        await deps.enqueue(productIds, 'IMS_CHANGE', { force: true, onEnqueued: discharge })
      }
      result.queued++
    } catch (error) {
      result.failed++
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: refund.orderId,
        action: 'wc_refund_stock_correction',
        tag: 'sync',
        level: 'WARNING',
        description: 'Could not record the stock correction a WooCommerce refund owes the store; it stays open and is retried',
        metadata: { refundId: refund.id, error: error instanceof Error ? error.message : String(error) },
        resolveUser: false,
      }).catch(() => { /* logging must never change the outcome */ })
    }
  }
  return result
}
