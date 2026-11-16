import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/app/generated/prisma/client'
import { WC_BOUNDARY_GENERATION_KEY } from './stock-held-orders'

/**
 * Invalidate the WooCommerce covered-history boundary (see THE COVERED-HISTORY BOUNDARY in stock-held-orders.ts) by replacing its generation
 * token. Call it INSIDE the transaction that deletes an order or releases / reduces an allocation, never after it.
 *
 * Why those writes and not others: the boundary lets a later stock guard omit an old completed order because IMS holds its allocation. Delete
 * the order or release the allocation and the guard still omits it while a stock push now offers the freed units, restoring what WooCommerce
 * already sold. Shipping is different: dispatch consumes the reservation through the shipment (the stock itself leaves), so available stock does
 * not rise and nothing is invalidated. The token is replaced rather than incremented, so concurrent releases need no read-modify-write; the
 * row lock on the setting serialises them for the rest of their transactions.
 */
export async function invalidateWcCoveredHistoryBoundary(tx: Prisma.TransactionClient): Promise<void> {
  const value = randomUUID()
  await tx.setting.upsert({
    where: { key: WC_BOUNDARY_GENERATION_KEY },
    create: { key: WC_BOUNDARY_GENERATION_KEY, value },
    update: { value },
  })
}
