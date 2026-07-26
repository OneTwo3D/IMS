import { Prisma } from '@/app/generated/prisma/client'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'

/**
 * Joining accounting enqueue to the sales-order delete protocol (o3d-hrak).
 *
 * o3d-5r8 made the hard delete lock the order, check for live accounting/WMS work, and only then
 * delete. That is only half a protocol: the side that WRITES never took part.
 *
 * `queueXeroSync` / `queueQuickBooksSync` create their `AccountingSyncLog` row in their own
 * transaction, with no order lock and no existence check — and `AccountingSyncLog` has no foreign
 * key to `SalesOrder`, so nothing at the database level objects either. A poster can therefore
 * hold a payload snapshot taken before the delete, insert its PENDING row AFTER the delete guard
 * has looked, and commit after the order is gone. The worker then posts a real accounting document
 * for an order that no longer exists — an irreversible remote write against a deleted local entity.
 *
 * The fix is symmetric with the delete side: take the SAME row lock, in the SAME transaction that
 * creates the sync row, and re-read the order. Then the two serialise — whichever gets the lock
 * first wins, and the loser sees the other's committed outcome instead of a stale snapshot.
 */

/** Reference types whose `referenceId` resolves to a sales order. */
const ORDER_SCOPED_REFERENCE_TYPES = new Set(['SalesOrder', 'Shipment'])

/**
 * Resolve the sales order an accounting sync row belongs to, LOCK it, and confirm it still exists.
 *
 * Returns the order id when the enqueue may proceed, or `null` when the order has been deleted —
 * in which case the caller must NOT create the sync row.
 *
 * Reference types that are not order-scoped (`DailyBatch`, `PurchaseOrder`, `Product`, …) return
 * `undefined`: there is no order to lock and nothing to check, and treating "not applicable" the
 * same as "deleted" would silently stop every non-order document from ever being queued.
 */
export async function lockOrderForAccountingEnqueue(
  tx: Prisma.TransactionClient,
  params: { referenceType: string; referenceId: string },
): Promise<string | null | undefined> {
  if (!ORDER_SCOPED_REFERENCE_TYPES.has(params.referenceType)) return undefined

  let orderId = params.referenceId

  if (params.referenceType === 'Shipment') {
    // Resolved BEFORE the lock on purpose: locking needs an order id, and a shipment whose order
    // is already gone tells us the same thing a missing order would.
    const shipment = await tx.shipment.findUnique({
      where: { id: params.referenceId },
      select: { orderId: true },
    })
    if (!shipment) return null
    orderId = shipment.orderId
  }

  // The same `SELECT ... FOR UPDATE` the delete path takes, so the two contend on one row.
  await lockSalesOrder(tx, orderId)

  const order = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { id: true } })
  if (!order) return null

  return orderId
}
