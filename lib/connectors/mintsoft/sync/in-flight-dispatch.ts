import type { Prisma } from '@/app/generated/prisma/client'
import { addMoney, toDecimal } from '@/lib/domain/math/decimal'
import { MINTSOFT_DISPATCHED_STATUSES } from '@/lib/connectors/mintsoft/api/orders'

/**
 * UNITS THE WAREHOUSE HAS DESPATCHED THAT IMS HAS NOT YET RECORDED AS SHIPPED (o3d-hqvrp.118).
 *
 * WHY IT EXISTS. Mintsoft takes a unit off `TotalStockLevel` when it despatches. IMS takes it off on-hand
 * only when the dispatch sweep applies the shipment, so for as long as the despatch is unrecorded the stock
 * sync sees "Mintsoft has fewer than IMS" by exactly those units. Aligning down in that window writes them
 * off, and the despatch then decrements stock a second time. The `reservedQty` gate cannot see it: it only
 * stops on-hand going BELOW the reservation, never on-hand being reduced BY the reserved units themselves.
 *
 * THE SOURCE. The units are still `order_allocations` rows (the reservation) on an order that is not yet
 * past SHIPPED in IMS. Two independent facts say the warehouse may already have despatched them:
 *   1. the cached WMS order status (`wms_order_status_snapshots`, written by the order-status sweep, a read
 *      of the WMS that does not depend on the dispatch sweep) is one of Mintsoft's despatched statuses; or
 *   2. the dispatch sweep has given up on the order (`dispatchDeadLetteredAt` / `dispatchUnresolvedAt`): its
 *      despatch state is UNKNOWN, which is not evidence that it has not shipped, so it holds the same way.
 *
 * Orders the warehouse has not despatched are NOT counted: their units are still on Mintsoft's shelves, so a
 * lower Mintsoft balance is not explained by them and the other gates still apply.
 *
 * A STATUS READ MUST POST-DATE THE STOCK READ (o3d-hqvrp.368, Codex R3 HIGH). A "not despatched" status proves nothing about
 * a stock figure read AFTER it: the order can despatch in between (false at 10:00, despatch 10:05, stock read 10:06), and
 * then the lower Mintsoft balance IS the despatched units. So an allocation is released only when its snapshot was fetched
 * strictly after `stockReadAt`, the moment the Mintsoft stock being aligned was read; an older (or equal) read holds as
 * `status_predates_stock_read`. Holding is the safe default: the next status-sweep cycle re-reads the order and a later
 * align-down run re-evaluates. Both the planning check and the in-transaction re-check pass the same `stockReadAt`.
 *
 * A FAILED REFRESH IS NOT A READ. The status sweep stamps `fetchedAt = now` and `lastError` on a failed lookup but keeps
 * the old `status`, so `lastError` set means `fetchedAt` is a failure time and the cached status is held against.
 *
 * THE CONNECTOR'S DECISION, NOT THE NAME. The sweep persists the connector's `dispatched` decision (vendor status
 * grouping or a despatch date, which a name set cannot see; for a split order an aggregate over every part) with each
 * successful snapshot. Release needs a successful read, after the stock read, with `dispatched === false`; true, null
 * (absent or unresolved), a predating read and a failed read all hold. The planning check and the in-transaction
 * re-check both go through this function.
 *
 * No live Mintsoft read is made here (reads are rate limited); a missing snapshot (cron off, order not yet swept)
 * holds. Hold-only: this can only ever delay an align-down, never apply one.
 */

/** IMS order statuses past which the shipment has been recorded (or the order is gone). */
const RECORDED_ORDER_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] as const

type InFlightClient = Pick<Prisma.TransactionClient, 'orderAllocation'>

export type InFlightDispatchHold = {
  orderId: string
  orderNumber: string
  qty: number
  reason: 'despatched_at_wms' | 'despatch_state_unknown' | 'status_lookup_failed' | 'status_snapshot_missing' | 'status_predates_stock_read' | 'status_dispatch_unknown'
}

export async function loadInFlightDispatch(
  client: InFlightClient,
  input: { productId: string; warehouseId: string; connector?: string; stockReadAt: Date },
): Promise<{ qty: number; holds: InFlightDispatchHold[] }> {
  const connector = input.connector ?? 'mintsoft'
  const rows = await client.orderAllocation.findMany({
    where: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      order: {
        status: { notIn: [...RECORDED_ORDER_STATUSES] },
        wmsOrderPush: {
          is: {
            connector,
            externalOrderId: { not: null },
            state: { not: 'CANCELLED' },
          },
        },
      },
    },
    select: {
      qty: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          wmsOrderStatus: { select: { status: true, dispatched: true, fetchedAt: true, lastError: true } },
          wmsOrderPush: { select: { dispatchDeadLetteredAt: true, dispatchUnresolvedAt: true } },
        },
      },
    },
  })

  let total = toDecimal(0)
  const holds: InFlightDispatchHold[] = []
  for (const row of rows) {
    const snapshot = row.order.wmsOrderStatus
    const cachedStatus = snapshot?.status?.trim().toUpperCase() ?? ''
    let reason: InFlightDispatchHold['reason'] | null = null
    // The connector's persisted decision outranks the name set (vendor grouping or a despatch date can say
    // "despatched" for a name the set does not know). The name set stays as a second hold-only signal.
    if (snapshot?.dispatched === true || MINTSOFT_DISPATCHED_STATUSES.has(cachedStatus)) reason = 'despatched_at_wms'
    else if (row.order.wmsOrderPush?.dispatchDeadLetteredAt != null || row.order.wmsOrderPush?.dispatchUnresolvedAt != null) reason = 'despatch_state_unknown'
    // A FAILED REFRESH IS NOT A FRESH READ (Codex R2 HIGH). When a lookup throws, or cannot resolve the
    // order, the status sweep writes `fetchedAt = now` and `lastError` but KEEPS the old `status`
    // (order-status-sweep.ts, the two `update: { fetchedAt: new Date(), lastError }` writes), and a
    // successful read always writes `lastError: null`. So `lastError` set means the latest lookup is not
    // the last successful read, and `fetchedAt` is then the time of a FAILURE: the cached status is held
    // against, however recent that stamp is. When `lastError` is null `fetchedAt` is the successful read.
    else if (snapshot?.lastError != null) reason = 'status_lookup_failed'
    else if (!snapshot || cachedStatus === '') reason = 'status_snapshot_missing'
    else if (snapshot.fetchedAt.getTime() <= input.stockReadAt.getTime()) reason = 'status_predates_stock_read'
    // An explicit `false` is the only release. Null is a row from before the column existed or a read that
    // recorded no decision: the connector never said "not despatched", so it holds.
    else if (snapshot.dispatched !== false) reason = 'status_dispatch_unknown'
    if (reason) {
      total = addMoney(total, row.qty)
      holds.push({ orderId: row.order.id, orderNumber: row.order.orderNumber ?? row.order.id, qty: toDecimal(row.qty).toNumber(), reason })
    }
  }
  return { qty: total.toNumber(), holds }
}

export function describeInFlightHolds(holds: readonly InFlightDispatchHold[]): string {
  return holds.slice(0, 10).map((hold) => `${hold.orderNumber} (${hold.qty}, ${hold.reason})`).join('; ')
    + (holds.length > 10 ? `; and ${holds.length - 10} more` : '')
}
