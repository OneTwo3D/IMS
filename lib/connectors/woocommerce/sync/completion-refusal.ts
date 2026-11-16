/**
 * THE DURABLE ROW FOR A PERMANENTLY REFUSED WOOCOMMERCE COMPLETION (o3d-ymgc).
 *
 * o3d-xnwu made a refused completion visible to its caller and wrote a passive activity row, but a PERMANENT
 * refusal (a coverage shortfall) is acknowledged: the delivery is retired and nothing brings the order back, so
 * somebody had to go and look. This gives it a `shopping_sync_logs` row on the ORDER that Sync > Exceptions lists:
 *
 *   - QUARANTINED while open (status {@link WC_COMPLETION_REFUSAL_OPEN_STATUS}), one per order;
 *   - SYNCED once the order is fulfilled, completed or cancelled, or the store no longer says completed;
 *   - kept by the retention sweep while open (openWcCompletionRefusalRowSql).
 *
 * The payload carries order ids, the refusal code and the refusal sentence only: no customer data.
 * Nothing here calls the storefront or the warehouse.
 */

import { db } from '@/lib/db'
import { parseWcGmtInstant } from './pre-cutover-order-read'
import {
  WC_COMPLETION_REFUSAL_OPEN_STATUS,
  WC_COMPLETION_REFUSAL_RECORD_KIND,
  WC_COMPLETION_REFUSAL_SETTLED_ORDER_STATUSES,
  openWcCompletionRefusalWhere,
} from '@/lib/domain/sales/wc-sync-row-families'

export type WcCompletionRefusalInput = {
  orderId: string
  externalOrderId: number | string
  wcStatus: string
  refusal: string
  error: string
  /** The refusing delivery's `date_modified_gmt` (parsed), or null when it carried none. Fences later settlement by a stale event. */
  eventAt?: Date | null
}

/** The instant of a WooCommerce delivery (`date_modified_gmt`, else `date_modified`), or null when unreadable. */
export function wcEventInstant(order: { date_modified_gmt?: string; date_modified?: string }): Date | null {
  return parseWcGmtInstant(order.date_modified_gmt) ?? parseWcGmtInstant(order.date_modified)
}

/**
 * Raise (or refresh) the open row for an order. One open row per order: a second refusal updates the first
 * (count and last-seen), so a redelivered webhook does not stack rows. The order row is locked first so two
 * concurrent deliveries cannot both insert.
 */
export async function recordWcCompletionRefusal(input: WcCompletionRefusalInput): Promise<void> {
  const now = new Date()
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${input.orderId} FOR UPDATE`
    const existing = await tx.shoppingSyncLog.findFirst({
      where: { ...openWcCompletionRefusalWhere(), entityId: input.orderId },
      select: { id: true, payload: true },
    })
    const previous = existing?.payload as { firstRefusedAt?: string; occurrences?: number; refusedEventAt?: string | null } | null
    // The fence keeps the NEWEST refusing event seen: a late redelivery of an older refusal must not move it back.
    const priorEvent = previous?.refusedEventAt ? new Date(previous.refusedEventAt) : null
    const eventAt = input.eventAt && (!priorEvent || input.eventAt > priorEvent) ? input.eventAt : priorEvent
    const payload = {
      externalOrderId: String(input.externalOrderId),
      wcStatus: input.wcStatus,
      refusal: input.refusal,
      error: input.error,
      firstRefusedAt: previous?.firstRefusedAt ?? now.toISOString(),
      lastRefusedAt: now.toISOString(),
      refusedEventAt: eventAt ? eventAt.toISOString() : null,
      occurrences: (previous?.occurrences ?? 0) + 1,
    }
    if (existing) {
      await tx.shoppingSyncLog.update({ where: { id: existing.id }, data: { payload, errorMessage: input.error } })
      return
    }
    await tx.shoppingSyncLog.create({
      data: {
        connector: 'woocommerce',
        direction: 'FROM_CONNECTOR',
        entityType: 'SalesOrder',
        entityId: input.orderId,
        externalId: String(input.externalOrderId),
        recordKind: WC_COMPLETION_REFUSAL_RECORD_KIND,
        status: WC_COMPLETION_REFUSAL_OPEN_STATUS,
        payload,
        errorMessage: input.error,
      },
    })
  })
}

/** Close an order's open refusal row (the order was fulfilled, or the store withdrew the completion). Idempotent. */
export async function resolveWcCompletionRefusal(orderId: string): Promise<number> {
  const result = await db.shoppingSyncLog.updateMany({
    where: { ...openWcCompletionRefusalWhere(), entityId: orderId },
    data: { status: 'SYNCED', syncedAt: new Date() },
  })
  return result.count
}

/**
 * Settle an open refusal because the store sent a NON-completed status. FENCED: only an event STRICTLY NEWER than the refusing one
 * settles it, so a late redelivery of an older `processing` webhook cannot close a refusal the later `completed` event raised. An event
 * with no readable time settles nothing (fail closed); a refusal that recorded no event time is settled by any dated event.
 */
export async function resolveWcCompletionRefusalIfNewer(orderId: string, eventAt: Date | null): Promise<number> {
  if (!eventAt) return 0
  const row = await db.shoppingSyncLog.findFirst({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId }, select: { id: true, payload: true } })
  if (!row) return 0
  const refused = (row.payload as { refusedEventAt?: string | null } | null)?.refusedEventAt
  if (refused && !(eventAt > new Date(refused))) return 0
  const result = await db.shoppingSyncLog.updateMany({ where: { id: row.id, ...openWcCompletionRefusalWhere() }, data: { status: 'SYNCED', syncedAt: new Date() } })
  return result.count
}

export type OpenWcCompletionRefusal = {
  id: string
  orderId: string
  orderNumber: string | null
  externalOrderId: string
  refusal: string
  error: string
  occurrences: number
  raisedAt: string
}

/**
 * The open rows an operator should see. A row whose order has meanwhile been dispatched, completed or cancelled
 * (by any route, not only the WooCommerce webhook) or deleted is SETTLED here and dropped, so a resolved shortfall
 * never sits in the inbox: this read is the safety net behind the explicit resolves.
 */
export async function loadOpenWcCompletionRefusals(limit?: number): Promise<OpenWcCompletionRefusal[]> {
  const rows = await db.shoppingSyncLog.findMany({
    where: openWcCompletionRefusalWhere(),
    orderBy: { createdAt: 'desc' },
    select: { id: true, entityId: true, externalId: true, payload: true, errorMessage: true, createdAt: true },
  })
  if (rows.length === 0) return []
  const orders = await db.salesOrder.findMany({
    where: { id: { in: rows.map((row) => row.entityId as string) } },
    select: { id: true, status: true, externalOrderNumber: true, orderNumber: true },
  })
  const byId = new Map(orders.map((order) => [order.id, order]))
  const settled = new Set<string>(WC_COMPLETION_REFUSAL_SETTLED_ORDER_STATUSES)
  const live: OpenWcCompletionRefusal[] = []
  const staleOrderIds: string[] = []
  for (const row of rows) {
    const order = byId.get(row.entityId as string)
    if (!order || settled.has(order.status)) {
      staleOrderIds.push(row.entityId as string)
      continue
    }
    const payload = (row.payload ?? {}) as { refusal?: string; error?: string; occurrences?: number }
    live.push({
      id: row.id,
      orderId: order.id,
      orderNumber: order.externalOrderNumber ?? order.orderNumber ?? null,
      externalOrderId: row.externalId ?? '',
      refusal: payload.refusal ?? '',
      error: payload.error ?? row.errorMessage ?? '',
      occurrences: payload.occurrences ?? 1,
      raisedAt: row.createdAt.toISOString(),
    })
  }
  if (staleOrderIds.length > 0) {
    await db.shoppingSyncLog.updateMany({
      where: { ...openWcCompletionRefusalWhere(), entityId: { in: staleOrderIds } },
      data: { status: 'SYNCED', syncedAt: new Date() },
    })
  }
  return limit ? live.slice(0, limit) : live
}
