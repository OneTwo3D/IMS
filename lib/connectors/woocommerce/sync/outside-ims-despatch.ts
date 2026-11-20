/**
 * ORDERS IMS FIRST SEES AFTER THEIR SALE WAS SETTLED OUTSIDE IMS (o3d-hqvrp.92).
 *
 *   despatched  the order was completed (or mapped to SHIPPED / COMPLETED / DELIVERED, or refunded after a completion) AT OR AFTER the instant the
 *               opening stock was taken: the goods left through the incumbent and the opening stock does not reflect it. IMS books the despatch
 *               through the existing external-fulfilment path (stock consumed, FIFO issued, cost posted, order SHIPPED), pushing nothing.
 *   historical  completed BEFORE that instant, or no instant is on record (or the order's own dates are unreadable): the opening stock already reflects
 *               it, so it is recorded with no allocation, movement, cost or reservation. FAIL CLOSED: when in doubt, nothing is consumed.
 *   refunded    the store's `refunded` status: stays refundable (PROCESSING), holds no allocation; the refund sweep records its refunds.
 *
 * Every one carries `outsideImsFulfilmentAt`, which the warehouse create fences and both allocation sweeps respect.
 */
import type { WcFullOrder } from './types'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { readOpeningStockCutoff } from './opening-stock-cutoff'
import { Prisma } from '@/app/generated/prisma/client'
import { openWcCompletionRefusalWhere, openWcCompletionRefusalRowSql, openWcCompletionRefusalIndexPredicateSql } from '@/lib/domain/sales/wc-sync-row-families'
import { parseWcGmtInstant } from './pre-cutover-order-read'
import { readWcOrderStatus } from './status-mapping'
import { recordWcCompletionRefusal, wcEventInstant } from './completion-refusal'

const POST_DISPATCH_IMPORT_STATUSES: ReadonlySet<string> = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

/**
 * Bounds on the retry of a despatch that could not be booked for want of stock. Beyond either the row is terminal (still listed under Sync > Exceptions).
 *
 *   age       14 days from the first refusal. This is the bound that normally binds: with the back-off below the retry makes about 17 checks in 14 days.
 *   attempts  30 real booking attempts, a safety net. A check that finds no stock level changed since the last attempt is NOT an attempt.
 *
 * The retry runs on the 15-minute wc-withdrawal-sweep but each row is only due again after a back-off, so the age bound is reachable.
 */
export const OUTSIDE_IMS_DESPATCH_MAX_ATTEMPTS = 30
export const OUTSIDE_IMS_DESPATCH_MAX_AGE_MS = 14 * 86_400_000
/** The wait after the 1st, 2nd and 3rd check of a row (15 minutes, 1 hour, 4 hours); every later wait is OUTSIDE_IMS_DESPATCH_DAILY_BACKOFF_MS. */
export const OUTSIDE_IMS_DESPATCH_BACKOFF_MS: readonly number[] = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000]
export const OUTSIDE_IMS_DESPATCH_DAILY_BACKOFF_MS = 24 * 60 * 60_000

/** How long to wait after the `checks`-th check (1-based) of a row before it is due again. */
export function outsideImsRetryDelayMs(checks: number): number {
  return OUTSIDE_IMS_DESPATCH_BACKOFF_MS[checks - 1] ?? OUTSIDE_IMS_DESPATCH_DAILY_BACKOFF_MS
}

/** On-hand per stocked line product of the order, as one comparable string: what an attempt could only change if a stock level moved. Reservations are excluded on purpose (an attempt itself moves them). */
async function readStockSignature(orderId: string): Promise<string> {
  const lines = await db.salesOrderLine.findMany({ where: { orderId, productId: { not: null } }, select: { productId: true } })
  const productIds = [...new Set(lines.map((line) => line.productId as string))]
  if (productIds.length === 0) return ''
  const levels = await db.stockLevel.findMany({ where: { productId: { in: productIds } }, select: { productId: true, warehouseId: true, quantity: true } })
  return levels.map((level) => `${level.productId}:${level.warehouseId}:${level.quantity.toString()}`).sort().join('|')
}

/** The store statuses in which an order is genuinely back to an unfulfilled, live state (it can still be sent from the warehouse). Cancelled and refunded are not. */
const UNFULFILLED_LIVE_STATUSES: ReadonlySet<string> = new Set(['PROCESSING', 'ON_HOLD', 'PENDING_PAYMENT'])

type Reading = { slug: string; imsStatus: string | null }
type Dated = Pick<WcFullOrder, 'date_completed_gmt' | 'date_paid_gmt' | 'date_created_gmt'>

/** When the sale was settled: the completion, else the payment, else the creation. Null when none is readable. */
export function wcSaleSettledInstant(order: Partial<Dated>): Date | null {
  return parseWcGmtInstant(order.date_completed_gmt) ?? parseWcGmtInstant(order.date_paid_gmt) ?? parseWcGmtInstant(order.date_created_gmt)
}

function isCandidate(reading: Reading, order: Partial<Dated>): { refunded: boolean; candidate: boolean } {
  const refunded = reading.slug === 'refunded'
  const candidate = (reading.imsStatus !== null && POST_DISPATCH_IMPORT_STATUSES.has(reading.imsStatus)) || (refunded && Boolean(order.date_completed_gmt))
  return { refunded, candidate }
}

/** The opening-stock instant, read only for an order that could need it. */
export async function readOpeningStockCutoffIfNeeded(reading: Reading, order: Partial<Dated>): Promise<Date | null> {
  return isCandidate(reading, order).candidate ? await readOpeningStockCutoff() : null
}

export function firstSeenOutsideIms(
  reading: Reading,
  order: Partial<Dated>,
  openingStockCutoff: Date | null,
): { despatched: boolean; historical: boolean; refunded: boolean; any: boolean; noInstant: boolean } {
  const { refunded, candidate } = isCandidate(reading, order)
  const settled = wcSaleSettledInstant(order)
  const consumes = candidate && openingStockCutoff !== null && settled !== null && settled.getTime() >= openingStockCutoff.getTime()
  const despatched = consumes
  // A refunded order that was not despatched after the cut-off is simply refunded (PROCESSING, no allocation); any other candidate that does not consume is historical.
  const historical = candidate && !consumes && !refunded
  return { despatched, historical, refunded, any: despatched || historical || refunded, noInstant: historical && openingStockCutoff === null }
}

/**
 * Release the partial allocation and the pending shipment an order that can never ship is holding. A FAILED release is never swallowed: it is logged and then
 * THROWN, so the booking fails visibly (the import is retried, the retry job counts it and the cron answers non-2xx) instead of leaving stock reserved for goods that already left.
 * A failed stock-sync enqueue is recorded in the same activity entry (the release itself stands; the daily stock reconcile corrects the storefront level).
 */
async function releaseUnbookedAllocation(orderId: string, why: string): Promise<void> {
  let releaseError: string | null = null
  let stockSyncError: string | null = null
  let released: { allocations: Array<{ productId: string }>; deletedPendingShipmentCount: number } | null = null
  try {
    const { lockSalesOrder, releaseOrderAllocationsForDeallocationInTx } = await import('@/lib/domain/sales/allocation-service')
    released = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      const result = await releaseOrderAllocationsForDeallocationInTx(tx, orderId, { cause: why, userId: null })
      await tx.salesOrder.updateMany({ where: { id: orderId, status: 'ALLOCATED', shipments: { none: { status: { not: 'PENDING' } } } }, data: { status: 'PROCESSING' } })
      return result
    }, { maxWait: 5000, timeout: 20000 })
  } catch (error) {
    releaseError = error instanceof Error ? error.message : String(error)
  }
  if (released) {
    try {
      const { enqueueStockSync } = await import('@/lib/shopping')
      await enqueueStockSync([...new Set(released.allocations.map((row) => row.productId))], 'IMS_CHANGE')
    } catch (error) {
      stockSyncError = error instanceof Error ? error.message : String(error)
    }
  }
  await logActivity({
    entityType: 'SALES_ORDER', entityId: orderId, tag: 'sync', level: 'WARNING', resolveUser: false,
    action: releaseError ? 'wc_import_first_seen_allocation_release_failed' : 'wc_import_first_seen_allocation_released',
    description: releaseError
      ? `Could not release the allocation held by an order whose despatch cannot be booked yet (${why}): ${releaseError}`
      : `Released ${released?.allocations.length ?? 0} allocation(s) and ${released?.deletedPendingShipmentCount ?? 0} pending shipment(s) held by an order whose despatch cannot be booked yet (${why}); it is listed under Sync > Exceptions.`
        + (stockSyncError ? ` The storefront stock sync could not be queued (${stockSyncError}); the stock reconcile will correct it.` : ''),
  })
  if (releaseError) throw new Error(`Could not release the allocation held by order ${orderId}: ${releaseError}`)
}

export type OutsideImsBookingOutcome = 'booked' | 'owed' | 'refused'

/**
 * Book the despatch of an order the incumbent already sent, through `processWcCompletion` -> `applyExternalFulfillmentUpdate` (allocate, build the
 * shipment, ship it: stock, FIFO, cost, order promoted). Pushes nothing.
 *
 *   booked   shipped.
 *   owed     refused for want of physical stock (or another retryable reason): recorded DURABLY as the order's open completion-refusal row (visible under
 *            Sync > Exceptions), and retried by `retryOwedOutsideImsDespatches`, which is bounded. The caller acknowledges the delivery.
 *   refused  refused for good (the lines cannot cover the order): the completion flow has recorded the row; the partial allocation and pending shipment
 *            are released, so nothing stays reserved for goods that already left.
 */
export async function bookOutsideImsDespatch(orderId: string, wcOrder: WcFullOrder): Promise<OutsideImsBookingOutcome> {
  const { processWcCompletion } = await import('./completion-flow')
  const outcome = await processWcCompletion(orderId, wcOrder)
  if (outcome.kind === 'fulfilled') {
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_import_first_seen_despatched', tag: 'sync', level: 'INFO', resolveUser: false,
      description: `WooCommerce order ${wcOrder.number} was first seen already ${wcOrder.status}: its stock was consumed and its cost posted as a despatch made outside IMS. Nothing was sent to a warehouse.`,
      metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status },
    })
    return 'booked'
  }
  if (outcome.kind === 'refused' && !outcome.permanent) {
    await recordWcCompletionRefusal({
      orderId, externalOrderId: wcOrder.id, wcStatus: wcOrder.status, refusal: outcome.refusal,
      error: `${outcome.error} IMS will retry this despatch automatically (it was first seen already ${wcOrder.status}); the order is not sent to a warehouse.`,
      eventAt: wcEventInstant(wcOrder),
    })
    return 'owed'
  }
  if (outcome.kind === 'refused' && outcome.refusal === 'coverage_shortfall') {
    // For an order IMS built only to book a despatch that already happened, the shipment lines come from IMS's own allocation, so a shortfall means IMS has
    // stock for only PART of it. That is owed, not permanent: release what was reserved (nothing may stay held for goods that already left) and retry as
    // stock is received, under the same attempt and age caps. A first partial receipt must not make the order permanent.
    await releaseUnbookedAllocation(orderId, 'IMS has stock for only part of the order')
    await recordWcCompletionRefusal({
      orderId, externalOrderId: wcOrder.id, wcStatus: wcOrder.status, refusal: 'insufficient_physical_stock',
      error: `IMS has physical stock for only part of this order (it was first seen already ${wcOrder.status}), so the despatch could not be booked yet. IMS will retry automatically as stock is received; the order is not sent to a warehouse.`,
      eventAt: wcEventInstant(wcOrder),
      // processWcCompletion already recorded this refusal (its permanent branch): refresh the row, do not count the same attempt twice.
      countOccurrence: false,
    })
    return 'owed'
  }
  return 'refused'
}

/** Whether the order has an open completion-refusal row (a booking already owed, or refused for good). */
async function hasOpenRefusal(orderId: string): Promise<boolean> {
  return (await db.shoppingSyncLog.count({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId } })) > 0
}

/**
 * Runs AFTER the whole import. An order that carries `outsideImsFulfilmentAt`, still sits in PROCESSING / ALLOCATED, was completed at or after the
 * opening-stock instant and has no open refusal row (an owed or refused booking is the retry job's, not every delivery's) is booked here. Always
 * answers as the import did, so an owed booking never holds the order sweep's cursor.
 */
export async function bookOutsideImsDespatchIfOwed<T extends { success: boolean; orderId?: string; error?: string }>(result: T, wcOrder: WcFullOrder): Promise<T | { success: false; orderId: string; error: string }> {
  if (!result.success || !result.orderId) return result
  const orderId = result.orderId
  try {
    const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true, outsideImsFulfilmentAt: true } })
    if (!order?.outsideImsFulfilmentAt || (order.status !== 'PROCESSING' && order.status !== 'ALLOCATED')) return result
    const reading = await readWcOrderStatus(wcOrder.status)
    if (!firstSeenOutsideIms(reading, wcOrder, await readOpeningStockCutoffIfNeeded(reading, wcOrder)).despatched) return result
    if (await hasOpenRefusal(orderId)) return result
    await bookOutsideImsDespatch(orderId, wcOrder)
    return result
  } catch (error) {
    return { success: false, orderId, error: `Order #${wcOrder.number} is imported but its despatch could not be booked: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export type OwedDespatchRetryResult = { scanned: number; booked: number; stillOwed: number; terminal: number; failed: number; resolved: number; skipped: number; reopened: number }

type RetryPayload = {
  terminal?: boolean; occurrences?: number; firstRefusedAt?: string; refusal?: string
  retryChecks?: number; retryAttempts?: number; lastAttemptAt?: string; nextAttemptAt?: string; stockSignature?: string
}

/**
 * The bounded driver for despatches owed for want of stock. Runs off the open completion-refusal rows of orders that carry the marker.
 *
 *   BACK-OFF   a row is due when its `nextAttemptAt` has passed. Every check of a row (booked, still owed or skipped) schedules the next one: 15 minutes,
 *              1 hour, 4 hours, then daily. So the 14-day age bound is the one that binds, not the attempt count.
 *   ATTEMPT    counted ONCE, here, in `retryAttempts` (the row's `occurrences` is the refusal counter shown to operators and no longer bounds anything).
 *   UNCHANGED  when no on-hand level of the order's stocked products has changed since the last attempt, nothing could differ: the booking is skipped
 *              (no reserve, release, stock sync or activity row) and is not counted as an attempt.
 *   TERMINAL   past `OUTSIDE_IMS_DESPATCH_MAX_ATTEMPTS` attempts or `OUTSIDE_IMS_DESPATCH_MAX_AGE_MS` the row is marked terminal (it stays open under Sync > Exceptions, says so, and is no longer retried).
 *   REOPENED   a store order that is no longer despatched closes the row; when it is back in an unfulfilled live state the outside-IMS fence is cleared too.
 */
export async function retryOwedOutsideImsDespatches(
  limit = 20,
  readLive?: (externalOrderId: string) => Promise<{ order: WcFullOrder } | { gone: true } | { failed: true }>,
  now: Date = new Date(),
): Promise<OwedDespatchRetryResult> {
  const result: OwedDespatchRetryResult = { scanned: 0, booked: 0, stillOwed: 0, terminal: 0, failed: 0, resolved: 0, skipped: 0, reopened: 0 }
  // FILTERED IN SQL: only OWED rows of orders that carry the marker and are still unshipped, never a terminal row, only those DUE (back-off), least recently attempted first.
  // Filtering a page of the oldest open refusals in memory would let terminal and ordinary refusals starve every newer owed despatch.
  const rows = await db.$queryRaw<Array<{ id: string; orderId: string; externalId: string | null; payload: unknown }>>(Prisma.sql`
    SELECT "shopping_sync_logs".id, "shopping_sync_logs"."entityId" AS "orderId", "shopping_sync_logs"."externalId" AS "externalId", "shopping_sync_logs".payload AS payload
      FROM "shopping_sync_logs"
      JOIN "sales_orders" so ON so.id = "shopping_sync_logs"."entityId"
     WHERE ${openWcCompletionRefusalRowSql()}
       AND ${Prisma.raw(openWcCompletionRefusalIndexPredicateSql('"shopping_sync_logs"'))}
       AND so.outside_ims_fulfilment_at IS NOT NULL
       AND so.status::text IN ('PROCESSING', 'ALLOCATED')
       AND COALESCE("shopping_sync_logs".payload->>'terminal', '') <> 'true'
       AND COALESCE("shopping_sync_logs".payload->>'nextAttemptAt', '') <= ${now.toISOString()}
     ORDER BY COALESCE("shopping_sync_logs".payload->>'lastAttemptAt', "shopping_sync_logs".payload->>'lastRefusedAt', '') ASC, "shopping_sync_logs"."createdAt" ASC
     LIMIT ${limit}`)
  const read = readLive ?? (await import('./order-admission')).readLiveWcOrder
  for (const row of rows) {
    const payload = (row.payload ?? {}) as RetryPayload
    const orderId = row.orderId
    result.scanned++
    const ageMs = payload.firstRefusedAt ? now.getTime() - Date.parse(payload.firstRefusedAt) : 0
    const attempts = payload.retryAttempts ?? 0
    if (attempts >= OUTSIDE_IMS_DESPATCH_MAX_ATTEMPTS || ageMs > OUTSIDE_IMS_DESPATCH_MAX_AGE_MS) {
      await db.shoppingSyncLog.update({
        where: { id: row.id },
        data: {
          payload: { ...payload, terminal: true } as never,
          errorMessage: `Gave up retrying this despatch after ${attempts} attempt(s) / ${Math.round(ageMs / 86_400_000)} day(s): IMS still has no stock to consume for an order that was first seen already completed. Receive the stock and ship the order by hand, or cancel it.`,
        },
      })
      await logActivity({ entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_import_first_seen_despatch_gave_up', tag: 'sync', level: 'WARNING', resolveUser: false, description: 'IMS gave up retrying the despatch of an order first seen already completed; it stays listed under Sync > Exceptions.' })
      result.terminal++
      continue
    }
    const live = await read(String(row.externalId ?? ''))
    if (!('order' in live)) { result.failed++; continue }
    try {
      // The store may have moved on since the refusal (back to processing, refunded, cancelled): book only what it STILL says was despatched at or after the cut-off.
      const reading = await readWcOrderStatus(live.order.status)
      if (!firstSeenOutsideIms(reading, live.order, await readOpeningStockCutoffIfNeeded(reading, live.order)).despatched) {
        const clearFence = reading.slug !== 'refunded' && reading.imsStatus !== null && UNFULFILLED_LIVE_STATUSES.has(reading.imsStatus)
        // ONE transaction: the row closes and (for a genuinely reopened order) the fence comes off, so neither can stand without the other.
        const cleared = await db.$transaction(async (tx) => {
          await tx.shoppingSyncLog.update({ where: { id: row.id }, data: { status: 'SYNCED', syncedAt: now, errorMessage: `Closed without booking: the store order is now "${String(live.order.status)}", no longer a despatch IMS owes.` } })
          if (!clearFence) return false
          const updated = await tx.salesOrder.updateMany({ where: { id: orderId, outsideImsFulfilmentAt: { not: null }, status: { in: ['PROCESSING', 'ALLOCATED'] } }, data: { outsideImsFulfilmentAt: null } })
          return updated.count > 0
        })
        if (cleared) {
          await logActivity({
            entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_import_first_seen_outside_ims_fence_cleared', tag: 'sync', level: 'INFO', resolveUser: false,
            description: `The store reports order ${String(live.order.number ?? '')} as "${String(live.order.status)}" again, so it is no longer a despatch made outside IMS: the outside-IMS fence was removed and the order can be allocated and sent from the warehouse as normal.`,
            metadata: { externalOrderId: live.order.id, wcStatus: live.order.status },
          })
          result.reopened++
        }
        result.resolved++
        continue
      }
      const stockSignature = await readStockSignature(orderId)
      const checks = (payload.retryChecks ?? 0) + 1
      const schedule = { retryChecks: checks, lastAttemptAt: now.toISOString(), nextAttemptAt: new Date(now.getTime() + outsideImsRetryDelayMs(checks)).toISOString() }
      if (payload.stockSignature !== undefined && payload.stockSignature === stockSignature) {
        // Nothing an attempt depends on has changed since the last one: no attempt, no churn, no log. Only the schedule moves.
        await persistRetryState(row.id, { ...schedule })
        result.skipped++
        result.stillOwed++
        continue
      }
      await persistRetryState(row.id, { ...schedule, retryAttempts: attempts + 1, stockSignature })
      const outcome = await bookOutsideImsDespatch(orderId, live.order)
      if (outcome === 'booked') result.booked++
      else result.stillOwed++
    } catch {
      // A failed attempt says nothing about stock: forget the signature so the next due check really tries again.
      await persistRetryState(row.id, { stockSignature: undefined }).catch(() => undefined)
      result.failed++
    }
  }
  return result
}

/** Merge retry bookkeeping into the row's payload, touching only the open row (a row the booking just resolved is left alone). */
async function persistRetryState(rowId: string, patch: Partial<RetryPayload>): Promise<void> {
  const current = await db.shoppingSyncLog.findFirst({ where: { id: rowId, ...openWcCompletionRefusalWhere() }, select: { payload: true } })
  if (!current) return
  await db.shoppingSyncLog.updateMany({ where: { id: rowId, ...openWcCompletionRefusalWhere() }, data: { payload: { ...((current.payload ?? {}) as object), ...patch } as never } })
}
