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
 * by a rename; WooCommerce binds it to the product case-insensitively, so it may differ in case or spacing from the product's SKU). The discrepancy's
 * `wmsValue` is the SKU the warehouse HOLDS. A line of a product with an open rename row is held unless its SKU, trimmed, EQUALS `wmsValue` (case-SENSITIVE,
 * like product sync's own link check; Mintsoft's matching cannot be verified, so a case variant is held): that keeps an order placed before the rename (old
 * SKU) pushing, and holds every other snapshot (the new SKU, and the middle SKU B of a rename A->B->C, which the warehouse never had). The row's
 * `imsValue` is deliberately not compared.
 *
 * AFTER THE EPISODE ENDS (no open row), a NEW order (create paths only) whose line carries an older snapshot is not pushed with it: when product sync has
 * confirmed that the warehouse holds the product's CURRENT IMS SKU (the SKU in the link's saved Mintsoft record equals it, see confirmedWarehouseSku), the line
 * is sent with that SKU (`skuRemap`). Chosen over holding every line whose SKU differs from the warehouse's current one because it needs no operator exit
 * (no row to ignore), cannot strand an order on stale data, and sends only a SKU the warehouse was last seen to hold. Amendments are never remapped: the
 * warehouse order exists under its recorded SKUs and a remap would read as a line change. When the warehouse's current SKU is not confirmed (no link, never
 * read, or the SKU was renamed again before sync noticed), the open-row hold (if any) decides and otherwise the snapshot is sent as before.
 *
 * SCOPE. The hold applies only to the discrepancy of the warehouse the order is actually sent to: the link's push warehouse for a mixed-warehouse
 * amendment whose push warehouse is mapped (an unmapped one is sent to the ship-from warehouse and held against that), else the order's ship-from warehouse (an order with none recorded matches any). Operators
 * can end a hold that product sync never closes (a product that became ineligible, a warehouse that left scope) by ignoring the discrepancy
 * (`ignoreMintsoftSkuRenameHoldAction`: sync permission, fresh sign-in, actor and note recorded); product sync does not reopen an ignored row
 * for the same pair of SKUs and never closes any other open row because of it; the ignore ends with the rename episode, so a later genuine rename holds again. Archiving a product does NOT release the hold.
 */

export function skuRenameHoldReason(skus: ReadonlyArray<string>): string {
  const list = [...new Set(skus)].join(', ')
  return `Order held: SKU ${list} was renamed in IMS but the warehouse product has not been renamed yet (open "SKU renamed in IMS" discrepancy on the warehouse dashboard), so the warehouse would not know the new SKU. Nothing was sent. Rename the product in the warehouse system (or rename the IMS SKU back); the order is then pushed automatically. If the product no longer syncs, ignore the discrepancy on the warehouse dashboard.`
}

export const SKU_RENAME_HOLD_REASON_PREFIX = 'Order held: SKU '

type Client = Pick<Prisma.TransactionClient, 'wmsStockDiscrepancy'> & Partial<Pick<Prisma.TransactionClient, 'wmsProductLink' | 'product'>>

/** One open rename row that applies to an order: the product and the SKU the warehouse holds for it. */
export type SkuRenameHold = { productId: string; wmsValue: string | null }

/**
 * The comparison key of a SKU: TRIMMED ONLY, case-SENSITIVE. Product sync's own link check is exact (`linked.sku === product.sku`) and nothing here can
 * verify whether Mintsoft resolves order-item SKUs case-insensitively, so a line whose SKU differs from the warehouse's only in case counts as a SKU the
 * warehouse may not hold: it is held (while a rename row is open) or remapped to the warehouse's own spelling (see skuRemap). Erring to holding.
 */
export function normaliseSkuForHold(sku: string | null | undefined): string {
  return (sku ?? '').trim()
}

/** Does this line's SKU differ from the SKU the warehouse holds (so sending it would send a SKU the warehouse does not have)? */
export function lineSkuMissingAtWarehouse(lineSku: string | null | undefined, hold: Pick<SkuRenameHold, 'wmsValue'>): boolean {
  return hold.wmsValue === null || hold.wmsValue.trim() === '' || normaliseSkuForHold(lineSku) !== normaliseSkuForHold(hold.wmsValue)
}

type OrderWithLines = { shipFromWarehouseId?: string | null; lines: ReadonlyArray<{ productId?: string | null }> }

/**
 * The SKU the Mintsoft warehouse holds for a product, as last READ from Mintsoft by product sync (the SKU in the link's saved Mintsoft record), but only
 * when it is exactly the product's CURRENT IMS SKU: that is the proof the rename episode (if any) is over and the warehouse holds the current SKU.
 * Otherwise null (no link, never read, or the warehouse still on another SKU: then the open-rename-row hold, if any, decides).
 */
export function confirmedWarehouseSku(productSku: string | null | undefined, linkMetadata: unknown): string | null {
  if (!linkMetadata || typeof linkMetadata !== 'object' || Array.isArray(linkMetadata)) return null
  const raw = (linkMetadata as Record<string, unknown>).SKU
  if (typeof raw !== 'string') return null
  const warehouseSku = normaliseSkuForHold(raw)
  if (warehouseSku === '' || warehouseSku !== normaliseSkuForHold(productSku)) return null
  return warehouseSku
}

/** One product's remap: the SKU the warehouse holds now, and the earlier IMS/warehouse SKUs of the product a line snapshot may still carry. */
export type SkuRemapEntry = { sku: string; earlier: string[] }
export type SkuRemap = Readonly<Record<string, SkuRemapEntry>>

/**
 * THE ONE PLACE a line's SKU on the wire is decided (create, amendment, the amendment comparisons and the warehouse query text all go through it, so
 * they can never disagree about a line). A line is sent as the warehouse's current SKU only when it is bound to a product with a remap entry AND its
 * snapshot SKU (trimmed, exact) is a KNOWN earlier SKU of that product (from the product's rename history). A case variant, a `wc-<id>` fallback or a
 * Woo SKU IMS has never known for the product is never remapped. With no remap (the setting is off) it returns the line's own SKU.
 */
export function sentSkuForLine(line: { sku?: string | null; productId?: string | null }, remap: SkuRemap | undefined): string {
  const own = line.sku ?? ''
  const entry = line.productId && remap ? remap[line.productId] : undefined
  if (!entry) return own
  const snapshot = normaliseSkuForHold(own)
  return snapshot !== entry.sku && entry.earlier.includes(snapshot) ? entry.sku : own
}

/**
 * Attach `skuRenameHolds` to each order (a copy), from one query for the whole batch. `warehouseOf` names the warehouse the order is actually sent
 * to when that is not its ship-from warehouse (a mixed-warehouse amendment's push warehouse). With `options.remapForConnector` (the
 * `wms_sku_rename_remap_enabled` setting is on) the order also carries `skuRemap`; see sentSkuForLine.
 */
export async function withSkuRenameHolds<T extends OrderWithLines>(
  client: Client,
  orders: ReadonlyArray<T>,
  warehouseOf: (order: T) => string | null | undefined = (order) => order.shipFromWarehouseId,
  options: { remapForConnector?: string } = {},
): Promise<Array<T & { skuRenameHolds: SkuRenameHold[]; skuRemap?: SkuRemap }>> {
  const productIds = [...new Set(orders.flatMap((order) => order.lines.flatMap((line) => (line.productId ? [line.productId] : []))))]
  const rows = productIds.length === 0 ? [] : await client.wmsStockDiscrepancy.findMany({
    where: { category: 'PRODUCT_SKU_RENAMED', status: 'OPEN', productId: { in: productIds } },
    select: { productId: true, warehouseId: true, wmsValue: true },
  })
  // Remap inputs: the warehouse SKU product sync confirmed, and the product's rename history (rows of any status).
  const warehouseSkuByProduct = new Map<string, string>()
  let history: Array<{ productId: string | null; warehouseId: string; imsValue: string | null; wmsValue: string | null }> = []
  if (options.remapForConnector && productIds.length > 0 && client.wmsProductLink && client.product) {
    const [links, products, past] = await Promise.all([
      client.wmsProductLink.findMany({ where: { connector: options.remapForConnector, productId: { in: productIds } }, select: { productId: true, metadata: true } }),
      client.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } }),
      client.wmsStockDiscrepancy.findMany({ where: { category: 'PRODUCT_SKU_RENAMED', productId: { in: productIds } }, select: { productId: true, warehouseId: true, imsValue: true, wmsValue: true } }),
    ])
    history = past
    const skuOf = new Map(products.map((product) => [product.id, product.sku]))
    for (const link of links) {
      const confirmed = confirmedWarehouseSku(skuOf.get(link.productId), link.metadata)
      if (confirmed) warehouseSkuByProduct.set(link.productId, confirmed)
    }
  }
  return orders.map((order) => {
    const own = new Set(order.lines.flatMap((line) => (line.productId ? [line.productId] : [])))
    const warehouseId = warehouseOf(order)
    const skuRenameHolds = rows.flatMap((row) => (
      row.productId && own.has(row.productId) && (!warehouseId || row.warehouseId === warehouseId) ? [{ productId: row.productId, wmsValue: row.wmsValue }] : []
    ))
    if (!options.remapForConnector) return { ...order, skuRenameHolds }
    const skuRemap: Record<string, SkuRemapEntry> = {}
    for (const id of own) {
      const sku = warehouseSkuByProduct.get(id)
      if (!sku) continue
      const earlier = new Set(history.flatMap((row) => (
        row.productId === id && (!warehouseId || row.warehouseId === warehouseId) ? [normaliseSkuForHold(row.imsValue), normaliseSkuForHold(row.wmsValue)] : []
      )))
      earlier.delete('')
      earlier.delete(sku)
      skuRemap[id] = { sku, earlier: [...earlier] }
    }
    return { ...order, skuRenameHolds, skuRemap }
  })
}
