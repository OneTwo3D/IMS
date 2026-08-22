import { Prisma } from '@/app/generated/prisma/client'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

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

// ---------------------------------------------------------------------------
// o3d-y14 — the payload snapshot, not just the queue row
// ---------------------------------------------------------------------------

/**
 * Sync types whose payload carries the order-level discount and therefore has to agree with the
 * live `SalesOrder.discountAmount`. Both are built by reading that column
 * (`queueSalesInvoiceForOrder` in app/actions/sales.ts, and the WooCommerce importer).
 */
export const ORDER_DISCOUNT_FENCED_SYNC_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

export type StaleOrderDiscount = {
  /** The order-level discount the caller's payload was built from. */
  payloadDiscount: number
  /** What the column says now, read under the order lock. */
  liveDiscount: number
}

/** The convention both payload builders use for this field: the order's own currency, 2 dp. */
function payloadRounded(value: unknown): number | null {
  if (value === undefined || value === null) return 0
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return null
  return roundQuantity(toDecimal(numeric), 2).toNumber()
}

/**
 * Is this payload's order-level discount STILL the order's? Called inside the locked enqueue
 * transaction; returns the mismatch when the payload is stale, or `null` when it is fine or the
 * check does not apply.
 *
 * WHY THIS EXISTS, when the enqueue already takes the order lock (o3d-y14).
 *
 * The lock serialises the INSERT of the queue row. It does not serialise the CONSTRUCTION of the
 * payload, and the payload is what gets posted. `queueSalesInvoiceForOrder` reads
 * `SalesOrder.discountAmount` and builds the entire payload BEFORE calling the queue helper, and
 * only the helper takes the lock. So this interleaving is legal and the lock cannot see it:
 *
 *   1. a producer reads discountAmount = 10 and builds a payload containing 10;
 *   2. the o3d-y14 backfill takes the lock, counts ZERO live invoice jobs — true, none exists yet —
 *      corrects the column to 0 and permanently stamps the order as corrected;
 *   3. the producer takes the now-free lock and inserts its payload containing 10;
 *   4. a worker posts 10 to the ledger, from an order that says 0, marked as already fixed.
 *
 * Nothing downstream can detect that, which is the whole reason the backfill is fenced at all. The
 * fix is that the payload has to be validated against the live row inside the SAME lock that
 * decides the ordering — a snapshot older than the lock is refused rather than queued.
 *
 * SCOPE, stated honestly: this fences the ONE field the backfill mutates. It is not a general
 * payload-freshness check, and it is not a substitute for building the payload under the lock —
 * which remains the stronger fix, and the one to reach for if any other order column ever becomes
 * correctable in flight. What it guarantees is the property the correction depends on: no queued
 * SALES_INVOICE can carry an order-level discount the order does not currently have.
 */
export async function findStaleOrderLevelDiscount(
  tx: Prisma.TransactionClient,
  params: { type: string; referenceType: string; orderId: string; payload: Record<string, unknown> },
): Promise<StaleOrderDiscount | null> {
  if (!(ORDER_DISCOUNT_FENCED_SYNC_TYPES as readonly string[]).includes(params.type)) return null
  // These types are always keyed on the order itself; a Shipment-keyed row of this type would mean
  // the payload was built from something other than the order, so fencing it would be a guess.
  if (params.referenceType !== 'SalesOrder') return null

  const order = await tx.salesOrder.findUnique({
    where: { id: params.orderId },
    select: { discountAmount: true },
  })
  // A missing order is the caller's other guard's business (lockOrderForAccountingEnqueue already
  // refused it); nothing to compare here.
  if (!order) return null

  const payloadDiscount = payloadRounded(params.payload.discountAmount)
  const liveDiscount = roundQuantity(toDecimal(order.discountAmount ?? 0), 2).toNumber()
  // A non-numeric discount is not "no discount": it is a payload this fence cannot read, so it
  // fails CLOSED rather than waving it through.
  if (payloadDiscount === null) return { payloadDiscount: Number.NaN, liveDiscount }
  if (payloadDiscount === liveDiscount) return null

  return { payloadDiscount, liveDiscount }
}

/** ActivityLog action written when an enqueue is refused for carrying a superseded discount. */
export const STALE_ORDER_DISCOUNT_ENQUEUE_ACTION = 'accounting_enqueue_stale_order_discount'

/**
 * Report a refused enqueue. LOUD on purpose: the document was NOT queued, so an operator has to
 * re-trigger it, and a silent skip would look identical to a disabled connector.
 */
export async function logStaleOrderDiscountEnqueue(
  connector: string,
  params: { type: string; referenceType: string; referenceId: string },
  stale: StaleOrderDiscount,
  deps?: { logActivity?: (input: Record<string, unknown>) => Promise<unknown> },
): Promise<void> {
  const log = deps?.logActivity ?? (await import('@/lib/activity-log')).logActivity
  await log({
    entityType: 'SALES_ORDER',
    entityId: params.referenceId,
    action: STALE_ORDER_DISCOUNT_ENQUEUE_ACTION,
    tag: 'accounting',
    level: 'ERROR',
    description:
      `Refused to queue a ${connector} ${params.type} for this order: the payload was built from an ` +
      `order-level discount of ${stale.payloadDiscount}, but the order now says ${stale.liveDiscount}. ` +
      'Something corrected the order between the payload being built and this enqueue (o3d-y14), so ' +
      'posting it would put a figure in the ledger that the order contradicts. NOTHING WAS QUEUED — ' +
      're-trigger the invoice for this order to send the current figures.',
    metadata: {
      connector,
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      payloadDiscount: Number.isFinite(stale.payloadDiscount) ? stale.payloadDiscount : null,
      liveDiscount: stale.liveDiscount,
    },
  })
}
