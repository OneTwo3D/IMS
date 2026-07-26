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
 *
 * SCOPE — this covers `queueXeroSync` / `queueQuickBooksSync`, which open their OWN transaction.
 * It does NOT cover `queueAccountingSyncTx`, which writes inside a CALLER's transaction and is
 * used for order-scoped documents too (`referenceType: 'Shipment'` from cost-layers.ts, and the
 * refund COGS reversal from app/actions/sales.ts). Guarding that variant is not a matter of
 * calling this helper from it: those callers may already hold stock-level locks, and
 * allocation-service establishes the ordering as sales-order FIRST, then stock levels — so taking
 * the order lock late, inside such a transaction, would invert it and can deadlock against the
 * allocation path. Closing that half needs the lock taken at the START of each caller's
 * transaction, which is a per-caller change. Tracked as o3d-3zgy.
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
/**
 * Which sales order — if any — an accounting sync row belongs to, WITHOUT taking any lock (o3d-3zgy).
 *
 * The lock-taking sibling below is for enqueue paths that own their transaction.
 * queueAccountingSyncTx writes inside a caller's transaction and must NOT take the order lock
 * itself: it would take it after stock-level locks are already held, inverting the
 * lockSalesOrder-then-lockStockLevels order and risking a deadlock. It needs only to know the scope
 * so it can assert the caller hoisted the lock.
 *
 *   'none'    — not order-scoped (PurchaseOrder, ProductionOrder, …); nothing to check.
 *   'order'   — order-scoped and the order exists; `orderId` names it.
 *   'deleted' — order-scoped but the order (or the shipment's order) is gone.
 *
 * The three are kept distinct because conflating 'none' with 'deleted' would either skip a legitimate
 * purchase-order enqueue or write an orphaned row for a deleted sales order.
 */
export async function resolveAccountingEnqueueOrderScope(
  tx: Prisma.TransactionClient,
  params: { referenceType: string; referenceId: string },
): Promise<{ scope: 'none' } | { scope: 'order'; orderId: string } | { scope: 'deleted' }> {
  if (!ORDER_SCOPED_REFERENCE_TYPES.has(params.referenceType)) return { scope: 'none' }

  let orderId = params.referenceId
  if (params.referenceType === 'Shipment') {
    const shipment = await tx.shipment.findUnique({
      where: { id: params.referenceId },
      select: { orderId: true },
    })
    if (!shipment) return { scope: 'deleted' }
    orderId = shipment.orderId
  }

  const order = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { id: true } })
  if (!order) return { scope: 'deleted' }

  return { scope: 'order', orderId }
}

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
