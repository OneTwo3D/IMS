import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE DIRTY-ORDER RECORD. The covered-history boundary (stock-held-orders.ts) lets the stock guard omit an old completed order because IMS
 * holds its allocation. When IMS then deletes the order or releases/reduces its allocation, a stock push offers the freed units and restores
 * what WooCommerce already sold. Rotating the boundary would force an exhaustive completed read, which on a store past the walk ceiling can
 * never complete, so instead the released ORDER is recorded here, in the same transaction as the release, and the guard re-fetches exactly
 * those orders by id on every run (the boundary keeps bounding the bulk read). Shipping is not recorded: dispatch consumes the reservation
 * through the shipment, available stock does not rise.
 *
 * Call it INSIDE the releasing transaction; for a delete, BEFORE the order (and its link) is removed, which is where the WooCommerce order id
 * is captured. An order with no WooCommerce link is not recorded: WooCommerce holds nothing for it.
 */
export async function markWcOrderDirtyForStockGuard(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const link = await tx.shoppingOrderLink.findFirst({
    where: { orderId, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link) return
  const token = randomUUID()
  await tx.wcStockDirtyOrder.upsert({
    where: { wcOrderId: link.externalOrderId },
    create: { wcOrderId: link.externalOrderId, orderId, token },
    update: { orderId, token, releasedAt: new Date() },
  })
}
