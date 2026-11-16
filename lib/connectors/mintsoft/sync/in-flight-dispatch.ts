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
 */

/** IMS order statuses past which the shipment has been recorded (or the order is gone). */
const RECORDED_ORDER_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] as const

type InFlightClient = Pick<Prisma.TransactionClient, 'orderAllocation'>

export async function loadInFlightDispatchQty(
  client: InFlightClient,
  input: { productId: string; warehouseId: string; connector?: string },
): Promise<number> {
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
          wmsOrderStatus: { select: { status: true } },
          wmsOrderPush: { select: { dispatchDeadLetteredAt: true, dispatchUnresolvedAt: true } },
        },
      },
    },
  })

  let total = toDecimal(0)
  for (const row of rows) {
    const cachedStatus = row.order.wmsOrderStatus?.status?.trim().toUpperCase() ?? ''
    const despatchedAtWms = MINTSOFT_DISPATCHED_STATUSES.has(cachedStatus)
    const despatchStateUnknown = row.order.wmsOrderPush?.dispatchDeadLetteredAt != null
      || row.order.wmsOrderPush?.dispatchUnresolvedAt != null
    if (despatchedAtWms || despatchStateUnknown) total = addMoney(total, row.qty)
  }
  return total.toNumber()
}
