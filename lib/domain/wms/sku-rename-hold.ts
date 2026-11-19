import type { Prisma } from '@/app/generated/prisma/client'

/**
 * ORDER PUSH HOLDS A LINE WHOSE SKU RENAME THE WAREHOUSE DOES NOT HAVE YET (o3d-zz37l).
 *
 * Product sync refuses to touch a Mintsoft product whose IMS SKU was renamed while the Mintsoft product still carries the old one
 * (an OPEN PRODUCT_SKU_RENAMED discrepancy; lib/connectors/mintsoft/sync/product-sync.ts). Order push used to send the NEW SKU to the LIVE
 * warehouse regardless, for a product it does not know under that SKU. The same discrepancy is now the order push's gate: an order carrying
 * such a line is refused locally, before anything is claimed or sent, exactly like any other payload that cannot be built. It is PARKED
 * VALIDATION_FAILED (a created order) or stays due with a standing refused-action row (an amendment), never dropped, and the revalidation pass
 * re-queues it by itself once the discrepancy closes (the warehouse product was renamed, or the IMS SKU was renamed back and product sync
 * re-linked it).
 *
 * The signal is the discrepancy row, not a fresh look at Mintsoft: no network, and one rule for product sync and order push.
 */

export function skuRenameHoldReason(skus: ReadonlyArray<string>): string {
  const list = [...new Set(skus)].join(', ')
  return `Order held: SKU ${list} was renamed in IMS but the warehouse product has not been renamed yet (open "SKU renamed in IMS" discrepancy on the warehouse dashboard), so the warehouse would not know the new SKU. Nothing was sent. rename the product in the warehouse system (or rename the IMS SKU back); the order is then pushed automatically.`
}

type Client = Pick<Prisma.TransactionClient, 'wmsStockDiscrepancy'>

/** The subset of `productIds` that has an OPEN PRODUCT_SKU_RENAMED discrepancy. */
export async function loadSkuRenameHeldProductIds(client: Client, productIds: ReadonlyArray<string>): Promise<Set<string>> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return new Set()
  const rows = await client.wmsStockDiscrepancy.findMany({
    where: { category: 'PRODUCT_SKU_RENAMED', status: 'OPEN', productId: { in: ids } },
    select: { productId: true },
  })
  return new Set(rows.flatMap((row) => (row.productId ? [row.productId] : [])))
}

type OrderWithLines = { lines: ReadonlyArray<{ productId?: string | null }> }

/** Attach `skuRenameHeldProductIds` to each order (a copy), from one query for the whole batch. */
export async function withSkuRenameHolds<T extends OrderWithLines>(client: Client, orders: ReadonlyArray<T>): Promise<Array<T & { skuRenameHeldProductIds: string[] }>> {
  const held = await loadSkuRenameHeldProductIds(client, orders.flatMap((order) => order.lines.flatMap((line) => (line.productId ? [line.productId] : []))))
  return orders.map((order) => ({
    ...order,
    skuRenameHeldProductIds: order.lines.flatMap((line) => (line.productId && held.has(line.productId) ? [line.productId] : [])),
  }))
}
