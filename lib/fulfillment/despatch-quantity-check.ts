import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

/**
 * THE UNITS THE WAREHOUSE DESPATCHED, AGAINST THE UNITS IMS BOOKS.
 *
 * A warehouse despatch is applied by shipping IMS's OWN shipment rows. Until this check nothing compared those rows with what the warehouse
 * says it sent, so a change IMS could not make at the warehouse (an item amendment refused once the order left NEW, a substitution, an
 * over-pick, a short despatch with no split) left stock on hand wrong with nothing raised. The worked case: SO-5001 ordered 4 x SKU-C, the
 * customer is refunded 1 with no restock, the amendment is refused as NOT_NEW, the warehouse despatches 4. IMS demand net of the refund is 3,
 * the IMS shipment covers 3, the coverage check passes, and IMS relieves 3: on hand is overstated by 1.
 *
 * THE RULE. EXACT, PER SKU, in the warehouse's own line terms: for every SKU the warehouse despatched, IMS must book the same number of units
 * (and book none that the warehouse did not send). There is no tolerance: units are whole and countable, and a tolerance would hide exactly the
 * one-unit drift this exists to catch. Only decimal noise (1e-6) is ignored. Any difference, over or under, HOLDS the despatch: nothing is
 * shipped, and a standing refused action names the SKUs with both quantities (see the refusal `despatch_quantity_mismatch`).
 *
 * WHAT THE COMPARISON IS NOT FOR (it says "not comparable" and the despatch applies as it always did):
 *   - the warehouse listed no lines (nothing to compare with);
 *   - the order holds a KIT line: the warehouse may list the kit or its components while IMS books components, so the two are not in the same
 *     terms (the earlier attempt raised a false mismatch on every kit order);
 *   - a MERGED warehouse order: its lines mix several storefront orders;
 *   - every shipment IMS holds in the warehouse's warehouse is already SHIPPED (by hand): there is nothing left to apply, and this is the
 *     way out of a standing mismatch (ship the shipments in IMS by hand, then the despatch records itself).
 * Shipments in other warehouses are never counted: a warehouse despatch is evidence about its own warehouse only.
 *
 * NO EXTRA READS. The warehouse's quantities come from the order record the sweep already holds (the item rows of the status read, or the
 * part items the split path already fetches); the IMS side is read from the database.
 */

export type DespatchQuantity = { sku: string; qty: number }
export type DespatchQuantityMismatch = { sku: string; wmsQty: number; imsQty: number }

export type DespatchQuantityVerdict =
  | { status: 'MATCH' }
  | { status: 'NOT_COMPARABLE'; reason: string }
  | { status: 'MISMATCH'; mismatches: DespatchQuantityMismatch[] }

const EPSILON = 0.000001

const normaliseSku = (sku: string | null | undefined): string => (sku ?? '').trim().toLowerCase()

/** The pure comparison. `ims` is one row per product with every SKU the product is known by on this order (aliases) and its booked units. */
export function compareDespatchQuantities(
  wms: ReadonlyArray<DespatchQuantity>,
  ims: ReadonlyArray<{ productId: string; skus: ReadonlyArray<string>; qty: number }>,
): DespatchQuantityMismatch[] {
  const productBySku = new Map<string, string>()
  for (const row of ims) for (const sku of row.skus) { const key = normaliseSku(sku); if (key) productBySku.set(key, row.productId) }

  const wmsByProduct = new Map<string, { label: string; qty: number }>()
  const unknown = new Map<string, { label: string; qty: number }>()
  for (const item of wms) {
    const key = normaliseSku(item.sku)
    if (!key || !(item.qty > 0)) continue
    const productId = productBySku.get(key)
    const bucket = productId ? wmsByProduct : unknown
    const bucketKey = productId ?? key
    const current = bucket.get(bucketKey)
    bucket.set(bucketKey, { label: current?.label ?? item.sku.trim(), qty: (current?.qty ?? 0) + item.qty })
  }

  const mismatches: DespatchQuantityMismatch[] = []
  for (const row of ims) {
    const imsQty = row.qty
    const sent = wmsByProduct.get(row.productId)
    const wmsQty = sent?.qty ?? 0
    if (Math.abs(wmsQty - imsQty) > EPSILON) mismatches.push({ sku: sent?.label ?? row.skus[0] ?? row.productId, wmsQty, imsQty })
  }
  for (const [, entry] of unknown) mismatches.push({ sku: entry.label, wmsQty: entry.qty, imsQty: 0 })
  return mismatches.sort((a, b) => a.sku.localeCompare(b.sku))
}

/** One fixed-wording sentence naming each SKU with both quantities. SKUs and numbers only: never remote free text. */
export function describeDespatchQuantityMismatch(mismatches: ReadonlyArray<DespatchQuantityMismatch>): string {
  return mismatches.map((entry) => `${entry.sku}: warehouse despatched ${entry.wmsQty}, IMS books ${entry.imsQty}`).join('; ')
}

type CheckInput = {
  orderId: string
  /** The warehouse the warehouse-order was sent for; null when unknown (every shipment of the order then counts). */
  wmsWarehouseId: string | null
  /** The warehouse's despatched units per SKU, or undefined when the connector could not say. */
  wmsQuantities: ReadonlyArray<DespatchQuantity> | undefined
}

export async function findDespatchQuantityMismatch(input: CheckInput, client: Pick<typeof db, 'shipment' | 'salesOrderLine'> = db): Promise<DespatchQuantityVerdict> {
  const wms = (input.wmsQuantities ?? []).filter((item) => item.qty > 0 && normaliseSku(item.sku) !== '')
  if (wms.length === 0) return { status: 'NOT_COMPARABLE', reason: 'the warehouse listed no despatched lines' }

  const [shipments, orderLines] = await Promise.all([
    client.shipment.findMany({
      where: { orderId: input.orderId, ...(input.wmsWarehouseId ? { warehouseId: input.wmsWarehouseId } : {}) },
      select: { status: true, lines: { select: { lineId: true, productId: true, qty: true, product: { select: { sku: true } } } } },
    }),
    client.salesOrderLine.findMany({
      where: { orderId: input.orderId },
      select: { productId: true, sku: true, product: { select: { type: true } } },
    }),
  ])
  if (shipments.length === 0) return { status: 'NOT_COMPARABLE', reason: 'IMS holds no shipment in the warehouse yet' }
  if (shipments.every((shipment) => shipment.status === 'SHIPPED')) return { status: 'NOT_COMPARABLE', reason: 'every shipment is already shipped' }
  if (orderLines.some((line) => line.product?.type === 'KIT')) return { status: 'NOT_COMPARABLE', reason: 'the order holds a kit line (the warehouse and IMS list kits in different terms)' }

  const skusByProduct = new Map<string, Set<string>>()
  const add = (productId: string | null | undefined, sku: string | null | undefined) => {
    if (!productId || !sku) return
    const set = skusByProduct.get(productId) ?? new Set<string>()
    set.add(sku)
    skusByProduct.set(productId, set)
  }
  for (const line of orderLines) add(line.productId, line.sku)
  const qtyByProduct = new Map<string, Prisma.Decimal>()
  for (const shipment of shipments) {
    for (const line of shipment.lines) {
      add(line.productId, line.product?.sku)
      qtyByProduct.set(line.productId, (qtyByProduct.get(line.productId) ?? new Prisma.Decimal(0)).add(line.qty))
    }
  }
  const ims = [...qtyByProduct].map(([productId, qty]) => ({ productId, skus: [...(skusByProduct.get(productId) ?? [])], qty: qty.toNumber() }))

  const mismatches = compareDespatchQuantities(wms, ims)
  return mismatches.length === 0 ? { status: 'MATCH' } : { status: 'MISMATCH', mismatches }
}
