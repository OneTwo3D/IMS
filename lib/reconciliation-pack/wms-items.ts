/**
 * ITEM R1: IMS STOCK AGAINST THE WAREHOUSE SYSTEM, PER (SKU, BOUND WAREHOUSE), EXACT.
 *
 * Behind the same opt-in as the other vendor items: without --vendor-reads-only the item is inconclusive VENDOR_READS_OFF, no port is
 * touched, no credential is read and no request is made. The module is total: it returns an item and never throws.
 *
 * WHAT IS COMPARED. IMS `stock_levels.quantity` (physical ON HAND; reservations are `reservedQty`, apart) against the warehouse system's
 * ON-HAND figure (owner decision U1: the connector's strict stock reader carries it as `onHand`; `available` is never compared), for
 * each (warehouse, SKU), by value, exactly (the catalogue's 0.0001, and an IMS quantity that is not a whole number cannot be equal to
 * the warehouse system's whole number, so it is BAD_VALUE rather than silently within the tolerance).
 *
 * THE POPULATION, decided in the SAME IMS snapshot as the stock and the links (F5):
 *   WAREHOUSES. Every binding of the warehouse system. In the population: active, stock sync not DISABLED, and alignment UNCONFIRMED
 *   (NOTIFICATION_ONLY always; ALIGN_TO_WMS while it has no confirmation stamp). Out, with a closed reason, its IMS stock listed and never
 *   compared: an inactive or DISABLED binding (BINDING_NOT_ACTIVE) and a confirmed alignment (ALIGNMENT_CONFIRMED: the sync keeps IMS
 *   equal by construction, so the claim says nothing there). A warehouse with no binding is not part of this claim and is not listed.
 *   A binding whose stored mode is not one of the three, or whose flags are not booleans, makes the whole item unreadable. After the
 *   vendor reads the bindings are read AGAIN in a second snapshot and must be unchanged (BASIS_MOVED): a warehouse confirmed or
 *   re-pointed while the vendor was being read is not judged on the earlier reading.
 *   PRODUCTS. By SKU (the identity the stock sync itself matches on). An IMS product of type SIMPLE, VARIANT or BOM is compared. It is
 *   in the population when it is LINKED to the warehouse system (a product link row), or, unlinked, when the product census lists its
 *   SKU (so a missing link cannot hide stock the warehouse system holds). An unlinked product the census does not list is out (NO_WMS_LINK),
 *   listed with its IMS figure and never compared. An IMS product with no stock row in a warehouse holds 0 there (as the sync reads it).
 *   KIT: its stock is derived from components, so it is out (KIT_DERIVED_STOCK), and so is a warehouse-system row flagged as a bundle;
 *   a KIT whose SKU the warehouse system lists as a plain product, or a plain IMS product it lists as a bundle, is IDENTITY_CONFLICT
 *   (no guess about which side is right). NON_INVENTORY and VARIABLE products are not stock-tracked and take no part.
 *   WAREHOUSE-SYSTEM ROWS with no compared IMS counterpart (no IMS product of a comparable type carries the SKU): a positive on-hand is
 *   a finding (onlyVendor: the warehouse system holds stock IMS does not hold for that SKU); a zero is out (WMS_ZERO_NO_IMS_PRODUCT).
 *
 * IDENTITY. A linked product's recorded vendor product id must be the id the stock row carries for that SKU and the id the census holds for
 * it; an id under another SKU, or a SKU under another id, is IDENTITY_CONFLICT for the whole item (a swap is never read as two quantities).
 *
 * ABSENCE. A product that IMS links and the vendor does not list at all (no stock row, not in the census) is onlyIms. A product the census
 * lists but whose warehouse stock list has no row for it cannot be told from a zero: READ_INCOMPLETE for the whole item (never a zero).
 *
 * R1 SETTLES (owner decision D7), like R9: stock moves between the IMS snapshot and the vendor read, so a difference first seen is
 * UNSETTLED (inconclusive UNSETTLED_PENDING) and fails only when it is still there after two LATER successful runs of the stock sync
 * stream (compare.ts advanceDifference, settling.ts).
 *
 * EMPTY. Nothing compared passes only on a named proof: `alignment-confirmed` (at least one binding is confirmed and none is unconfirmed:
 * the vendor is not asked, and the pass names only the IMS source) or `vendor-total-zero` (the vendor's stock lists and census are empty
 * in both sweeps and both scans). No binding at all, or only disabled or inactive ones, is NO_POPULATION_RECORD.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { compareItem, outcomeOfComparison, parseDecimalStrict, type CompareResult, type SettlingInput, type SideRow } from '@/lib/reconciliation-pack/compare'
import { PACK_WMS_CONNECTOR_ID, getPackItem, isVendorSource, type PackReasonCode, type PackSourceCode } from '@/lib/reconciliation-pack/constants'
import { canonicalKey, isKey, type KeyPart } from '@/lib/reconciliation-pack/identity'
import { alignmentState, type ImsRead, type ImsReadOptions, type ProductRow, type StockPair, type WmsBindingRow, type WmsProductLinkRow } from '@/lib/reconciliation-pack/ims-readers'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import { readWms, type WmsReadPort, type WmsSourceOptions, type WmsStockRow } from '@/lib/reconciliation-pack/wms-source'

export type WmsItemContext = {
  /** The opt-in. Anything but the boolean true is off. */
  vendorReads?: boolean
  wms?: WmsReadPort
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  wmsOptions?: WmsSourceOptions
  settling?: SettlingInput
}

const IMS: PackSourceCode = 'ims-database'
/** The vendor source the catalogue lists for R1 (the connector's literal lives in the constants, not here). */
const WMS: PackSourceCode = getPackItem('R1').sources.find(isVendorSource)!

const inconclusive = (sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id: 'R1', outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

const COMPARED_TYPES: ReadonlySet<string> = new Set(['SIMPLE', 'VARIANT', 'BOM'])
const KNOWN_TYPES: ReadonlySet<string> = new Set(['SIMPLE', 'VARIANT', 'BOM', 'KIT', 'VARIABLE', 'NON_INVENTORY'])
const MODES: readonly string[] = ['DISABLED', 'NOTIFICATION_ONLY', 'ALIGN_TO_WMS']

const keyOf = (warehouseCode: string, sku: string): KeyPart[] => [{ kind: 'warehouse', raw: warehouseCode }, { kind: 'sku', raw: sku }]

type Classified = { inPopulation: WmsBindingRow[]; confirmed: WmsBindingRow[]; notActive: WmsBindingRow[] }

/** The bindings of the warehouse system, split by the population rule. null = a binding that cannot be read exactly (fail closed). */
export function classifyWmsBindings(bindings: readonly WmsBindingRow[]): Classified | null {
  const out: Classified = { inPopulation: [], confirmed: [], notActive: [] }
  for (const binding of bindings) {
    if (binding.connector !== PACK_WMS_CONNECTOR_ID) continue
    if (typeof binding.active !== 'boolean' || typeof binding.alignmentConfirmed !== 'boolean' || !MODES.includes(binding.stockSyncMode)) return null
    if (typeof binding.warehouseId !== 'string' || typeof binding.warehouseCode !== 'string' || typeof binding.externalWarehouseId !== 'string') return null
    if (!binding.active) { out.notActive.push(binding); continue }
    const state = alignmentState(binding)
    if (state === 'disabled') out.notActive.push(binding)
    else if (state === 'confirmed') out.confirmed.push(binding)
    else if (state === 'unconfirmed') out.inPopulation.push(binding)
    else return null
  }
  return out
}

/** What the population depends on, as one text: compared before and after the vendor reads. */
export function bindingSignature(bindings: readonly WmsBindingRow[]): string {
  return JSON.stringify(bindings.filter((b) => b.connector === PACK_WMS_CONNECTOR_ID).map((b) => [b.warehouseId, b.warehouseCode, b.externalWarehouseId, b.active, b.stockSyncMode, b.alignmentConfirmed]).sort())
}

function fromComparison(result: CompareResult, sources: readonly PackSourceCode[]): ItemInput {
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  return { id: 'R1', outcome: verdict.outcome, reasons: verdict.reasons, proof, sources: [...sources], entries: result.status === 'compared' ? result.buckets : undefined }
}

/** An IMS quantity as the whole number text the vendor's figure is compared with, or null when it is not a whole number. */
function wholeQuantity(value: string): string | null {
  const parsed = parseDecimalStrict(value)
  if (parsed === null || !parsed.isInteger()) return null
  return new Prisma.Decimal(parsed).toFixed(0)
}

type Sides = { ims: SideRow[]; vendor: SideRow[]; population: Set<string> }

class Refuse extends Error {
  constructor(readonly reason: PackReasonCode) { super(reason) }
}

/**
 * The IMS side for warehouses that take no part (listed, never compared): every stock-tracked stock row of the warehouse.
 */
function listOutOfPopulation(sides: Sides, warehouseCode: string, pairs: readonly StockPair[]): void {
  for (const pair of pairs) {
    const key = keyOf(warehouseCode, pair.sku)
    if (!isKey(key)) throw new Refuse('BAD_KEY')
    sides.ims.push({ key, value: pair.quantity })
  }
}

type Inputs = {
  products: readonly ProductRow[]
  links: readonly WmsProductLinkRow[]
  tracked: readonly StockPair[]
}

export function buildSides(inputs: Inputs, classified: Classified, stock: ReadonlyMap<string, WmsStockRow[]>, census: ReadonlyArray<{ id: string; sku: string }>): Sides {
  const sides: Sides = { ims: [], vendor: [], population: new Set() }
  const pairsByWarehouse = new Map<string, StockPair[]>()
  for (const pair of inputs.tracked) {
    const list = pairsByWarehouse.get(pair.warehouseId) ?? []
    list.push(pair)
    pairsByWarehouse.set(pair.warehouseId, list)
  }
  for (const binding of [...classified.confirmed, ...classified.notActive]) listOutOfPopulation(sides, binding.warehouseCode, pairsByWarehouse.get(binding.warehouseId) ?? [])

  const linkOfProduct = new Map(inputs.links.filter((link) => link.connector === PACK_WMS_CONNECTOR_ID).map((link) => [link.productId, link.externalProductId] as const))
  const censusById = new Map(census.map((row) => [row.id, row.sku] as const))
  const censusBySku = new Map(census.map((row) => [row.sku, row.id] as const))
  const quantityOf = new Map(inputs.tracked.map((pair) => [`${pair.warehouseId}\u0001${pair.productId}`, pair.quantity] as const))

  for (const binding of classified.inPopulation) {
    const rows = stock.get(binding.externalWarehouseId)
    if (rows === undefined) throw new Refuse('READ_INCOMPLETE')
    const rowBySku = new Map(rows.map((row) => [row.sku, row] as const))
    const matched = new Set<string>()
    const add = (side: SideRow[], sku: string, value: string, inPopulation: boolean): void => {
      const key = keyOf(binding.warehouseCode, sku)
      if (!isKey(key)) throw new Refuse('BAD_KEY')
      side.push({ key, value })
      if (inPopulation) sides.population.add(canonicalKey(key))
    }
    for (const product of inputs.products) {
      if (!KNOWN_TYPES.has(product.type)) throw new Refuse('SOURCE_UNREADABLE')
      const row = rowBySku.get(product.sku)
      const stored = quantityOf.get(`${binding.warehouseId}\u0001${product.id}`)
      if (product.type === 'KIT') {
        // Derived stock on both sides: listed, never compared. A KIT the vendor lists as a plain product is not the same thing on both sides.
        if (row !== undefined && !row.bundle) throw new Refuse('IDENTITY_CONFLICT')
        if (stored !== undefined) add(sides.ims, product.sku, stored, false)
        if (row !== undefined) { add(sides.vendor, product.sku, String(row.onHand), false); matched.add(product.sku) }
        continue
      }
      if (!COMPARED_TYPES.has(product.type)) continue
      const link = linkOfProduct.get(product.id)
      const inCensus = censusBySku.has(product.sku)
      if (row !== undefined && row.bundle) throw new Refuse('IDENTITY_CONFLICT')
      if (link === undefined && !inCensus && row === undefined) {
        // No link and not listed: no identity at the vendor. Listed with its IMS figure, never compared.
        if (stored !== undefined) add(sides.ims, product.sku, stored, false)
        continue
      }
      if (link !== undefined) {
        const idOfSku = censusBySku.get(product.sku)
        const skuOfId = censusById.get(link)
        if (row !== undefined && row.productId !== link) throw new Refuse('IDENTITY_CONFLICT')
        if (skuOfId !== undefined && skuOfId !== product.sku) throw new Refuse('IDENTITY_CONFLICT')
        if (idOfSku !== undefined && idOfSku !== link) throw new Refuse('IDENTITY_CONFLICT')
      }
      const whole = wholeQuantity(stored ?? '0')
      if (whole === null) throw new Refuse('BAD_VALUE')
      if (row !== undefined) {
        add(sides.ims, product.sku, whole, true)
        add(sides.vendor, product.sku, String(row.onHand), true)
        matched.add(product.sku)
        continue
      }
      // No stock row. The census lists the product: the stock list left out a product the vendor knows, which cannot be told from a zero.
      if (inCensus) throw new Refuse('READ_INCOMPLETE')
      add(sides.ims, product.sku, whole, true)
    }
    for (const row of rows) {
      if (matched.has(row.sku)) continue
      if (row.bundle) { add(sides.vendor, row.sku, String(row.onHand), false); continue }
      // Stock the vendor holds for a SKU no comparable IMS product carries: a positive figure is a finding, a zero is not.
      add(sides.vendor, row.sku, String(row.onHand), row.onHand > 0)
    }
  }
  return sides
}

async function runR1(context: WmsItemContext): Promise<ItemInput> {
  const wms = context.wms
  const readIms = context.ims
  if (wms === undefined || readIms === undefined) return inconclusive([], 'SOURCE_UNREADABLE')
  const sections = ['wmsBindings', 'wmsProductLinks', 'products', 'stock'] as const
  const read = await readIms({ sections })
  if (!read.ok) return inconclusive([IMS], read.reason)
  const failed = sections.flatMap((name) => {
    const section = read.sections[name]
    return section === undefined ? ['SOURCE_UNREADABLE' as const] : section.ok ? [] : [section.reason]
  })
  if (failed.length > 0) return inconclusive([IMS], ...failed)
  const bindings = (read.sections.wmsBindings as { ok: true; value: WmsBindingRow[] }).value
  const links = (read.sections.wmsProductLinks as { ok: true; value: WmsProductLinkRow[] }).value
  const products = (read.sections.products as { ok: true; value: ProductRow[] }).value
  const tracked = (read.sections.stock as { ok: true; value: { tracked: StockPair[] } }).value.tracked

  const classified = classifyWmsBindings(bindings)
  if (classified === null) return inconclusive([IMS], 'SOURCE_UNREADABLE')
  const settling: SettlingInput = context.settling ?? { carried: new Map(), usable: false, stamp: null }
  const inputs: Inputs = { products, links, tracked }

  // The claim is retired where every alignment is confirmed: nothing is asked of the vendor.
  if (classified.inPopulation.length === 0) {
    if (classified.confirmed.length === 0) return inconclusive([IMS], 'NO_POPULATION_RECORD')
    const after = await readIms({ sections: ['wmsBindings'] })
    const again = after.ok ? after.sections.wmsBindings : undefined
    if (again === undefined || !again.ok) return inconclusive([IMS], again === undefined ? 'SOURCE_UNREADABLE' : again.reason)
    if (bindingSignature(again.value) !== bindingSignature(bindings)) return inconclusive([IMS], 'BASIS_MOVED')
    const sides = buildSides(inputs, classified, new Map(), [])
    return fromComparison(compareItem('R1', { ims: sides.ims, vendor: sides.vendor, imsComplete: true, vendorComplete: true, population: sides.population, emptyProof: 'alignment-confirmed', settling }), [IMS])
  }

  const walked = await readWms(wms, classified.inPopulation.map((binding) => binding.externalWarehouseId), context.wmsOptions)
  if (!walked.ok) return inconclusive([IMS, WMS], walked.reason)

  // The population was decided in the first snapshot; it must still be the population.
  const after = await readIms({ sections: ['wmsBindings'] })
  const again = after.ok ? after.sections.wmsBindings : undefined
  if (again === undefined || !again.ok) return inconclusive([IMS, WMS], again === undefined ? 'SOURCE_UNREADABLE' : again.reason)
  if (bindingSignature(again.value) !== bindingSignature(bindings)) return inconclusive([IMS, WMS], 'BASIS_MOVED')

  let sides: Sides
  try {
    sides = buildSides(inputs, classified, walked.value.stock, walked.value.census)
  } catch (error) {
    return inconclusive([IMS, WMS], error instanceof Refuse ? error.reason : 'SOURCE_UNREADABLE')
  }
  const result = compareItem('R1', {
    ims: sides.ims, vendor: sides.vendor, imsComplete: true, vendorComplete: true, population: sides.population,
    emptyProof: walked.value.allEmpty ? 'vendor-total-zero' : undefined, settling,
  })
  return fromComparison(result, [IMS, WMS])
}

/** Run R1. With the opt-in absent or anything but true, NOTHING is read. Never throws. */
export async function runWmsItem(context: WmsItemContext): Promise<ItemInput> {
  if (context.vendorReads !== true) return { id: 'R1', outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'] }
  try {
    return await runR1(context)
  } catch (error) {
    return inconclusive([], error instanceof Refuse ? error.reason : 'INTERNAL_ERROR')
  }
}
