import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { FulfillmentRequirementSnapshotError, parseFulfillmentRequirementSnapshot } from '@/lib/products/fulfillment-requirement-snapshot'

/**
 * THE UNITS THE WAREHOUSE DESPATCHED, AGAINST THE UNITS IMS BOOKS.
 *
 * A warehouse despatch is applied by shipping IMS's OWN shipment rows. Until this check nothing compared those rows with what the warehouse
 * says it sent, so a change IMS could not make at the warehouse (an item amendment refused once the order left NEW, a substitution, an
 * over-pick, a short despatch with no split) left stock on hand wrong with nothing raised. The worked case: SO-5001 ordered 4 x SKU-C, the
 * customer is refunded 1 with no restock, the amendment is refused as NOT_NEW, the warehouse despatches 4. IMS demand net of the refund is 3,
 * the IMS shipment covers 3, the coverage check passes, and IMS relieves 3: on hand is overstated by 1.
 *
 * WHAT THE WAREHOUSE'S NUMBER IS. It is the order line's quantity as the warehouse record holds it (the order item's `Quantity`), NOT a count of
 * the units picked: the warehouse API has no despatched-quantity field on an order item (Quantity, Allocated, Commited, OnBackOrder). So this check
 * catches an order whose lines the warehouse holds differently from IMS's (an amendment IMS could not make once the order left NEW, a refund IMS
 * netted but the warehouse never saw, a line IMS does not book at all). It does NOT see a warehouse over-pick or a substitution made at the bench, and
 * must never be described as if it did. A short despatch that is split carries the part's own quantities, which the split path sums.
 *
 * THE RULE. EXACT, PER SKU, in the warehouse's own line terms: for every SKU the warehouse despatched, IMS must book the same number of units
 * (and book none that the warehouse did not send). A SKU the warehouse sent that IMS books NOTHING of (a substitution, or an order line with no
 * shipment row such as a fully refunded one) is a mismatch of N against 0. The exceptions are lines IMS can never book: NON_INVENTORY and VARIABLE. There is no tolerance: units are whole and countable, and a tolerance would hide exactly the
 * one-unit drift this exists to catch. Only decimal noise (1e-6) is ignored. Any difference, over or under, HOLDS the despatch: nothing is
 * shipped, and a standing refused action names the SKUs with both quantities (see the refusal `despatch_quantity_mismatch`).
 *
 * WHAT THE COMPARISON IS NOT FOR (it says "not comparable" and the despatch applies as it always did):
 *   - the warehouse listed no lines (nothing to compare with);
 *   - the order holds a line whose PINNED fulfilment recipe (the snapshot taken at allocation) expands to anything other than itself (a kit): the
 *     warehouse may list the kit or its components while IMS books components, so the two are not in the same terms. A line with no pin falls back to
 *     the product's current type. The pin is what IMS actually allocated and ships by, so it, not today's product type, decides;
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
  options: { ignoreSkus?: ReadonlySet<string> } = {},
): DespatchQuantityMismatch[] {
  const productBySku = new Map<string, string>()
  for (const row of ims) for (const sku of row.skus) { const key = normaliseSku(sku); if (key) productBySku.set(key, row.productId) }

  const wmsByProduct = new Map<string, { label: string; qty: number }>()
  const unknown = new Map<string, { label: string; qty: number }>()
  for (const item of wms) {
    const key = normaliseSku(item.sku)
    if (!key || !(item.qty > 0)) continue
    // A SKU of a line IMS can never book (a service or a variable parent) and that is NOT also the SKU of a product IMS books on a shipment: nothing in IMS could match it, so it is not evidence of drift.
    if (options.ignoreSkus?.has(key) && !productBySku.has(key)) continue
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

/**
 * Does this order line expand to anything other than itself, by its PINNED fulfilment recipe? A line that carries a pin is judged by the pin alone (the
 * product's current type is not consulted, in either direction); a line with no pin falls back to the product's current type. A pin that cannot be read is
 * "cannot say" and the order is not compared (never a guess).
 */
export function lineExpandsBeyondItself(line: { id?: string; productId: string | null; fulfillmentRequirements?: unknown; product?: { type?: string | null } | null }): boolean {
  const snapshot = parseFulfillmentRequirementSnapshot(line.fulfillmentRequirements, line.id ?? null)
  if (snapshot && snapshot.productId === line.productId) {
    return !(snapshot.requirements.length === 1 && snapshot.requirements[0].productId === line.productId && snapshot.requirements[0].factor.eq(1))
  }
  return line.product?.type === 'KIT'
}

/**
 * What an operator does about a standing mismatch, per direction, in fixed wording (used by the refusal text, the standing row and the help text).
 *   - MORE units despatched than IMS books: IMS cannot book a unit past the order's demand, so the only exit is to ship the shipment by hand once it
 *     is right, and then post a stock adjustment (a removal) for the extra units that left. Shipping by hand alone books the demand and leaves exactly
 *     the drift this check exists to catch.
 *   - FEWER units despatched than IMS books (or a SKU that was not sent): ship the shipment by hand at what really left (reduce its line first); the
 *     despatch then records itself. Units that never left stay in stock.
 */
export function describeDespatchQuantityExit(mismatches: ReadonlyArray<DespatchQuantityMismatch>): string {
  const over = mismatches.some((entry) => entry.wmsQty > entry.imsQty)
  const under = mismatches.some((entry) => entry.wmsQty < entry.imsQty)
  const parts: string[] = []
  if (over) parts.push('If the warehouse sent MORE than IMS books: IMS cannot book units past the order\'s demand, so ship the shipment by hand once it is right and then post a stock adjustment (a removal) for the extra units that left')
  if (under) parts.push('If the warehouse sent FEWER than IMS books (or did not send a SKU): reduce the shipment\'s line to what really left, then ship it by hand; the units that did not leave stay in stock')
  return parts.join('. ') + (parts.length > 0 ? '.' : '')
}

/** A stable key for the mismatches, so "has anything changed since the standing row was written" is a string comparison (the stored JSON reorders keys). */
export function despatchQuantityMismatchKey(mismatches: ReadonlyArray<DespatchQuantityMismatch>): string {
  return [...mismatches].map((entry) => `${entry.sku}|${entry.wmsQty}|${entry.imsQty}`).sort().join(';')
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
      select: { id: true, productId: true, sku: true, fulfillmentRequirements: true, product: { select: { type: true, sku: true } } },
    }),
  ])
  if (shipments.length === 0) return { status: 'NOT_COMPARABLE', reason: 'IMS holds no shipment in the warehouse yet' }
  if (shipments.every((shipment) => shipment.status === 'SHIPPED')) return { status: 'NOT_COMPARABLE', reason: 'every shipment is already shipped' }
  try {
    if (orderLines.some((line) => lineExpandsBeyondItself(line))) return { status: 'NOT_COMPARABLE', reason: 'the order holds a kit line (the warehouse and IMS list kits in different terms)' }
  } catch (error) {
    if (error instanceof FulfillmentRequirementSnapshotError) return { status: 'NOT_COMPARABLE', reason: 'a line\'s pinned fulfilment recipe cannot be read, so the units cannot be compared' }
    throw error
  }

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

  // Lines IMS can never book. Excluded by SKU (the line's own, and the product's), so a service line the warehouse lists is not a standing mismatch.
  const ignoreSkus = new Set<string>()
  for (const line of orderLines) {
    if (line.product?.type === 'NON_INVENTORY' || line.product?.type === 'VARIABLE') {
      for (const sku of [line.sku, line.product?.sku]) {
        const key = normaliseSku(sku)
        if (key) ignoreSkus.add(key)
      }
    }
  }
  const mismatches = compareDespatchQuantities(wms, ims, { ignoreSkus })
  return mismatches.length === 0 ? { status: 'MATCH' } : { status: 'MISMATCH', mismatches }
}
