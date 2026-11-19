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
 * The signal is the discrepancy row, not a fresh look at Mintsoft: no network, and one rule for product sync and order push. The hold therefore
 * applies once product sync has DETECTED the rename: an order pushed between the rename and the next product sync still carries the new SKU.
 *
 * WHAT IS HELD IS EXACTLY WHAT GOES ON THE WIRE. buildLines sends the line's own SKU (a snapshot taken when the order was placed, never rewritten
 * by a rename). The discrepancy records both SKUs: `imsValue` is the new IMS SKU, `wmsValue` the SKU the warehouse still holds. Only a line whose
 * SKU equals `imsValue` is held; an order placed before the rename still carries the old SKU the warehouse knows, and pushes as before.
 *
 * SCOPE. The hold applies only to the discrepancy of the order's own ship-from warehouse (an order with none recorded matches any). Operators
 * can end a hold that product sync never closes (a product that became ineligible, a warehouse that left scope) by ignoring the discrepancy
 * (`ignoreMintsoftSkuRenameHoldAction`: sync permission, fresh sign-in, actor and note recorded); product sync does not reopen an ignored row
 * for the same pair of SKUs.
 */

export function skuRenameHoldReason(skus: ReadonlyArray<string>): string {
  const list = [...new Set(skus)].join(', ')
  return `Order held: SKU ${list} was renamed in IMS but the warehouse product has not been renamed yet (open "SKU renamed in IMS" discrepancy on the warehouse dashboard), so the warehouse would not know the new SKU. Nothing was sent. Rename the product in the warehouse system (or rename the IMS SKU back); the order is then pushed automatically. If the product no longer syncs, ignore the discrepancy on the warehouse dashboard.`
}

export const SKU_RENAME_HOLD_REASON_PREFIX = 'Order held: SKU '

type Client = Pick<Prisma.TransactionClient, 'wmsStockDiscrepancy'>

type OrderWithLines = { shipFromWarehouseId?: string | null; lines: ReadonlyArray<{ productId?: string | null }> }

/** Attach `skuRenameHeldSkus` (the new IMS SKUs the warehouse does not have yet) to each order (a copy), from one query for the whole batch. */
export async function withSkuRenameHolds<T extends OrderWithLines>(client: Client, orders: ReadonlyArray<T>): Promise<Array<T & { skuRenameHeldSkus: string[] }>> {
  const productIds = [...new Set(orders.flatMap((order) => order.lines.flatMap((line) => (line.productId ? [line.productId] : []))))]
  const rows = productIds.length === 0 ? [] : await client.wmsStockDiscrepancy.findMany({
    where: { category: 'PRODUCT_SKU_RENAMED', status: 'OPEN', productId: { in: productIds } },
    select: { productId: true, warehouseId: true, imsValue: true },
  })
  return orders.map((order) => {
    const own = new Set(order.lines.flatMap((line) => (line.productId ? [line.productId] : [])))
    const skus = rows.flatMap((row) => (
      row.productId && row.imsValue && own.has(row.productId) && (!order.shipFromWarehouseId || row.warehouseId === order.shipFromWarehouseId) ? [row.imsValue] : []
    ))
    return { ...order, skuRenameHeldSkus: [...new Set(skus)] }
  })
}
