import { Prisma, type AccountingSyncStatus, type AccountingSyncType } from '@/app/generated/prisma/client'
import { normalizeOrderDiscountBase } from '@/lib/sales-currency'
import { roundToGlPrecisionNumber } from '@/lib/domain/math/precision-policy'
import { POSTABLE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/accounting/postable-sync-statuses'

/**
 * o3d-y14 r2 finding 1 — the DAILY BATCH is the other producer of a discount-derived snapshot.
 *
 * WHY A SECOND FENCE EXISTS AT ALL. `findStaleOrderLevelDiscount` (enqueue-order-guard.ts) closed
 * this for the invoice queue, and the argument there was stated in terms of "the payload builder":
 * the sales-order row lock serialises the INSERT of a queue row, never the CONSTRUCTION of its
 * payload, so a snapshot taken before the lock can still be inserted after it. That argument was
 * never specific to invoices — it applies to ANY producer that reads
 * `SalesOrder.discountAmount` outside the transaction that persists what it derived. Group A1 of
 * the daily batch is exactly such a producer, and it was missed:
 *
 *   1. A1 reads N orders — `discountAmount` among them — with NO transaction and NO lock;
 *   2. it derives `orderDeferrals[]` (subtotal + shipping − the normalised discount);
 *   3. the o3d-y14 backfill takes the order lock, counts zero live SALES_INVOICE jobs (true) and
 *      zero live batch rows (also true — A1 has not inserted one yet), corrects the column and
 *      permanently stamps the order as corrected;
 *   4. A1 opens its transaction and persists the pre-correction figure TWICE: into a PENDING
 *      DAILY_BATCH_REVENUE_DEFERRAL payload that a worker will post as a GL journal, and into
 *      `SalesOrder.unearnedRevenueAmount`, which revenue recognition and the refund service read
 *      later as the authoritative deferred amount.
 *
 * Step 4 is worse than the invoice case it mirrors, because the stamp is a LOCAL write: even if
 * nobody ever posts the journal, the order now carries a deferral derived from a discount the same
 * order contradicts, and `revenueDeferredDate` being set means A1 will never look at it again.
 *
 * WHY IT REFUSES THE WHOLE GROUP rather than dropping the offending orders. The journal lines, the
 * batch total, the per-order invariant check and the reference-id hash (o3d-0qoo) are all computed
 * from the full order set before the transaction opens. Removing a member inside the transaction
 * would mean re-deriving every one of those from a different set — which is the same "recompute
 * silently and carry on" move this whole workstream exists to refuse. A1 stamps nothing on refusal,
 * so the orders stay eligible and the NEXT run reads the corrected column and defers the right
 * amount. Deferring a batch by one run is recoverable; a GL journal that disagrees with its own
 * orders is not.
 *
 * In practice this can only fire while the one-shot backfill is running, because
 * `SalesOrder.discountAmount` has no other in-flight writer (see classifyWcCouponProvenance).
 */

/** One order's contribution to a Group A1 revenue-deferral batch. */
export type RevenueDeferral = { orderId: string; amount: number }

/** An order whose recomputed deferral no longer matches the one the batch derived. */
export type StaleRevenueDeferral = {
  orderId: string
  /** What the batch computed, before the transaction opened. */
  batchAmount: number
  /** What the same arithmetic produces from the row as read under the lock. */
  liveAmount: number | null
}

/**
 * Thrown INSIDE the batch transaction, so nothing is written. The connectors' existing
 * `catch` records it on the run result; `logStaleDailyBatchDeferral` makes it visible in the
 * activity log as well, because a silently skipped daily batch looks exactly like a quiet day.
 */
export class StaleDailyBatchDeferralError extends Error {
  readonly stale: StaleRevenueDeferral[]

  constructor(stale: StaleRevenueDeferral[]) {
    super(
      `Group A1 revenue deferral refused: ${stale.length} order(s) changed between the batch read and ` +
        'the batch write, so the derived deferral no longer matches the order (o3d-y14). NOTHING was ' +
        'staged or stamped; the next run will recompute from the corrected figures. ' +
        stale
          .map((row) => `${row.orderId}: batch ${row.batchAmount}, live ${row.liveAmount ?? 'order gone'}`)
          .join('; '),
    )
    this.name = 'StaleDailyBatchDeferralError'
    this.stale = stale
  }
}

/** The columns the A1 deferral arithmetic reads. Selected identically by both connectors. */
const DEFERRAL_INPUT_SELECT = {
  id: true,
  fxRateToBase: true,
  subtotalBase: true,
  shippingBase: true,
  discountAmount: true,
  pricesIncludeVat: true,
  taxRatePercent: true,
  shoppingLinks: { select: { connector: true } },
  lines: { select: { totalBase: true, taxRate: { select: { rate: true } } } },
} as const

type DeferralInputs = {
  id: string
  fxRateToBase: Prisma.Decimal | number | null
  subtotalBase: Prisma.Decimal | number | null
  shippingBase: Prisma.Decimal | number | null
  discountAmount: Prisma.Decimal | number | null
  pricesIncludeVat: boolean
  taxRatePercent: Prisma.Decimal | number | null
  shoppingLinks: Array<{ connector: string }>
  lines: Array<{ totalBase: Prisma.Decimal | number | null; taxRate?: { rate: Prisma.Decimal | number | null } | null }>
}

/**
 * How many ids go into one Prisma `{ in: [...] }` re-read (o3d-y14 r3 finding 4).
 *
 * The same 500 the backfill's own id lookups use (`WC_COUPON_ID_CHUNK_SIZE`), and for the same
 * reason: Prisma spends one bind parameter per member, and PostgreSQL's protocol caps a statement
 * at 65535 of them. Not imported from there — the fence must not depend on a one-shot corrective
 * script — but deliberately the same number, so the two behave alike under the same pressure.
 */
export const DEFERRAL_ID_CHUNK_SIZE = 500

/** Split ids into `{ in: [...] }`-sized batches. Empty in, empty out — never one empty batch. */
export function chunkOrderIds(ids: readonly string[], size = DEFERRAL_ID_CHUNK_SIZE): string[][] {
  if (size <= 0) throw new Error('chunkOrderIds needs a positive size')
  const batches: string[][] = []
  for (let index = 0; index < ids.length; index += size) {
    batches.push([...ids.slice(index, index + size)])
  }
  return batches
}

/**
 * The A1 per-order amount. ONE implementation, called by the fence and (via the connectors) by the
 * batch itself, so "what the deferral is" cannot mean two different things on the two sides of the
 * comparison — a fence that re-derives with slightly different arithmetic reports drift that is not
 * there, and misses drift that is.
 */
export function revenueDeferralAmount(order: DeferralInputs): number {
  return roundToGlPrecisionNumber(
    Number(order.subtotalBase) + Number(order.shippingBase ?? 0) - normalizeOrderDiscountBase(order, order.lines),
  )
}

/**
 * LOCK every member order and re-derive its deferral; throw if any disagrees with what the batch
 * computed outside the transaction.
 *
 * THE LOCK IS THE POINT, not the re-read. A re-read alone under READ COMMITTED proves only that the
 * row was unchanged at the instant it was read: the backfill could still commit its correction
 * afterwards and this transaction would go on to persist the superseded figure. Holding
 * `FOR UPDATE` on the same rows the backfill locks means the two SERIALISE — either the backfill
 * committed first and this comparison sees it, or it waits behind this transaction and then sees a
 * live DAILY_BATCH_REVENUE_DEFERRAL row and declines. There is no interleaving left.
 *
 * Rows are locked in ONE statement ordered by id — the same shape as `lockCostLayers` in both
 * connectors' daily syncs — so two connectors' batches running concurrently take them in the same
 * order and cannot deadlock against each other.
 *
 * THE ID LIST IS ONE BIND PARAMETER, NOT ONE PER ORDER (o3d-y14 r3 finding 4). The first revision
 * expanded the ids with `Prisma.join`, which spends a bind parameter per member. Group A1 selects
 * every eligible order with no `take`, and QuickBooks — unlike Xero — has no bounded window through
 * which a backlog can drain, so past PostgreSQL's 65535-parameter ceiling the fence itself would
 * throw and the batch would fail before staging anything. A batch that cannot run is not a safe
 * batch; it is the same outage the fence exists to avoid, arriving through the fence.
 *
 * `id = ANY($1::text[])` binds the whole set as ONE array parameter, which is already the house
 * shape for bulk `FOR UPDATE` locks here (`cost_layers` in both daily syncs, `wms_asn_line_maps` in
 * the WMS booked-in and stock-sync paths). Chunking the LOCK was the other option and is worse:
 * with N chunked statements the set becomes locked progressively rather than in one statement, so
 * between chunk k and chunk k+1 a writer can still commit against a row in a later chunk — the
 * re-read below would catch that as drift and refuse, but only by turning a fence into a
 * false-refusal generator on a busy instance. One statement keeps "the whole member set is locked
 * before anything is compared" literally true, which is the property the comparison rests on.
 *
 * IT DOES NOT REGISTER IN `ordersLockedByTx`. That registry is `lockSalesOrder`'s, and only the
 * single-row helper writes to it — the bulk lockers (`lockStockLevels`, the refund service's cost
 * layers) do not either. The lock itself is real; what is missing is the in-process bookkeeping
 * `queueAccountingSyncTx` asserts on (o3d-3zgy). Nothing inside Group A1 enqueues an order-scoped
 * document today — it stages its journal through `createPendingSyncLog` — so nothing asserts. A
 * future A1 that did would be refused as "lock not hoisted" while holding the lock; the fix then is
 * to register these ids, NOT to drop the assertion.
 */
export async function assertRevenueDeferralsUnchanged(
  tx: Prisma.TransactionClient,
  deferrals: readonly RevenueDeferral[],
): Promise<void> {
  if (deferrals.length === 0) return

  const orderIds = [...new Set(deferrals.map((deferral) => deferral.orderId))].sort()
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "sales_orders" WHERE id = ANY(${orderIds}::text[]) ORDER BY id FOR UPDATE`,
  )

  // The RE-READ is chunked, and only the re-read. Prisma expands `{ in: [...] }` into one bind
  // parameter per id, so an unbounded batch would hit the same ceiling here that the lock above no
  // longer hits — one statement over 65535+ orders is an error, not a slow query.
  //
  // CHUNKING IT COSTS THE LOCKING GUARANTEE NOTHING, because the lock is not what is chunked. Every
  // member row is already held `FOR UPDATE` by the statement above before the first chunk is read,
  // and those locks are held until this transaction ends — so no row can change between chunk 1 and
  // chunk N, and the values read across chunks are as consistent as a single statement's would be.
  // The reason the lock itself must stay one statement is the opposite of this: locks acquired
  // progressively leave a window, reads taken under locks already held do not.
  const liveById = new Map<string, DeferralInputs>()
  for (const batch of chunkOrderIds(orderIds)) {
    const live = await tx.salesOrder.findMany({
      where: { id: { in: batch } },
      select: DEFERRAL_INPUT_SELECT,
    })
    for (const order of live) liveById.set(order.id, order as DeferralInputs)
  }

  const stale: StaleRevenueDeferral[] = []
  for (const deferral of deferrals) {
    const order = liveById.get(deferral.orderId)
    if (!order) {
      // Deleted between the batch read and here. Staging a deferral for an order that no longer
      // exists is the o3d-hrak failure in a different producer, so it is refused the same way.
      stale.push({ orderId: deferral.orderId, batchAmount: deferral.amount, liveAmount: null })
      continue
    }
    const liveAmount = revenueDeferralAmount(order)
    if (liveAmount !== deferral.amount) {
      stale.push({ orderId: deferral.orderId, batchAmount: deferral.amount, liveAmount })
    }
  }

  if (stale.length > 0) throw new StaleDailyBatchDeferralError(stale)
}

/** ActivityLog action written when a daily batch refuses to stage a superseded deferral. */
export const STALE_DAILY_BATCH_DEFERRAL_ACTION = 'accounting_daily_batch_stale_order_discount'

/**
 * Report the refusal OUTSIDE the aborted transaction. Loud on purpose, and for the same reason the
 * enqueue fence is loud: no journal was staged and no order was stamped, so from the outside a
 * refused Group A1 is indistinguishable from a day with nothing to defer.
 */
export async function logStaleDailyBatchDeferral(
  connector: string,
  error: StaleDailyBatchDeferralError,
  deps?: { logActivity?: (input: Record<string, unknown>) => Promise<unknown> },
): Promise<void> {
  const log = deps?.logActivity ?? (await import('@/lib/activity-log')).logActivity
  await log({
    entityType: 'SYSTEM',
    action: STALE_DAILY_BATCH_DEFERRAL_ACTION,
    tag: 'accounting',
    level: 'ERROR',
    description:
      `Refused to stage the ${connector} daily revenue deferral (Group A1): ${error.stale.length} of its ` +
      'order(s) changed between the batch read and the batch write, so the deferral it derived no longer ' +
      'matches the order. Something corrected those orders in flight (o3d-y14). NOTHING WAS STAGED OR ' +
      'STAMPED — the orders remain eligible and the next daily batch will defer the corrected amounts.',
    metadata: {
      connector,
      group: 'A1',
      staleOrderCount: error.stale.length,
      stale: error.stale,
    },
  })
}

/**
 * The `AccountingSyncLog` predicate for "a daily revenue-deferral batch that can still post".
 *
 * SHARED, not restated, for the same reason `POSTABLE_ACCOUNTING_SYNC_STATUSES` is: the o3d-y14
 * backfill declines an order whose batch is live, and that decision is only as good as the two
 * sides asking the same question. Batch rows are keyed `referenceType: 'DailyBatch'` on the batch's
 * own reference id, NOT on the order — which is why the backfill has to read
 * `SalesOrder.revenueDeferredBatchRef` to find them at all.
 */
export function liveDailyBatchDeferralWhere(batchRefs: readonly string[]): {
  referenceType: 'DailyBatch'
  referenceId: { in: string[] }
  type: AccountingSyncType
  status: { in: AccountingSyncStatus[] }
} {
  return {
    referenceType: 'DailyBatch',
    referenceId: { in: [...batchRefs] },
    type: 'DAILY_BATCH_REVENUE_DEFERRAL' as AccountingSyncType,
    status: { in: [...POSTABLE_ACCOUNTING_SYNC_STATUSES] as AccountingSyncStatus[] },
  }
}
