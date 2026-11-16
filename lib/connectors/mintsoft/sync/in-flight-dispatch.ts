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
 * STALE OR MISSING MEANS HOLD (Codex R1 HIGH). The cached status only proves "not despatched" while it is
 * FRESH. A live allocation on a pushed, unshipped order is therefore held for unless its snapshot is fresh and
 * not despatched. Fresh = fetched at or after the stock reading being acted on (`runStartedAt`), or within
 * `SNAPSHOT_FRESH_WINDOW_MINUTES` of the decision. The window is 45 minutes: the `wms-order-status` cron runs
 * every 15 minutes but only re-reads a snapshot older than the sweep's 30-minute stale threshold
 * (order-status-sweep.ts DEFAULT_STALE_MINUTES), so a healthy snapshot is at most 30 + 15 minutes old. No live
 * Mintsoft read is made here (reads are rate limited); a missing snapshot (cron off, order not yet swept)
 * holds. Hold-only: this can only ever delay an align-down, never apply one.
 */

/** DEFAULT_STALE_MINUTES (30) + the cron interval (15): the oldest a snapshot can be while the sweep is healthy. */
export const SNAPSHOT_FRESH_WINDOW_MINUTES = 45



/** IMS order statuses past which the shipment has been recorded (or the order is gone). */
const RECORDED_ORDER_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] as const

type InFlightClient = Pick<Prisma.TransactionClient, 'orderAllocation'>

export type InFlightDispatchHold = {
  orderId: string
  orderNumber: string
  qty: number
  reason: 'despatched_at_wms' | 'despatch_state_unknown' | 'status_snapshot_missing' | 'status_snapshot_stale'
}

export async function loadInFlightDispatch(
  client: InFlightClient,
  input: { productId: string; warehouseId: string; connector?: string; now: Date; runStartedAt: Date },
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
          wmsOrderStatus: { select: { status: true, fetchedAt: true } },
          wmsOrderPush: { select: { dispatchDeadLetteredAt: true, dispatchUnresolvedAt: true } },
        },
      },
    },
  })

  const freshCutoff = Math.min(
    input.runStartedAt.getTime(),
    input.now.getTime() - SNAPSHOT_FRESH_WINDOW_MINUTES * 60_000,
  )
  let total = toDecimal(0)
  const holds: InFlightDispatchHold[] = []
  for (const row of rows) {
    const snapshot = row.order.wmsOrderStatus
    const cachedStatus = snapshot?.status?.trim().toUpperCase() ?? ''
    let reason: InFlightDispatchHold['reason'] | null = null
    if (MINTSOFT_DISPATCHED_STATUSES.has(cachedStatus)) reason = 'despatched_at_wms'
    else if (row.order.wmsOrderPush?.dispatchDeadLetteredAt != null || row.order.wmsOrderPush?.dispatchUnresolvedAt != null) reason = 'despatch_state_unknown'
    else if (!snapshot || cachedStatus === '') reason = 'status_snapshot_missing'
    else if (snapshot.fetchedAt.getTime() < freshCutoff) reason = 'status_snapshot_stale'
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
