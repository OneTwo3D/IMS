/**
 * OBSERVE: what the database holds for one step, reduced to the runner's key and fingerprint strings.
 *
 * Every entry is built by turning a database row back into the CELLS the importer read to write it (`*CellsFromDb` in normal-form.ts) and
 * running those through the same functions the file side uses, so "present and matching" is a string comparison and no formatting rule lives here.
 *
 * FAIL CLOSED. A read that fails is an ObservationError (the core turns it into a refusal or a resumable STEP_FAILED); it is never an empty
 * observation, because an empty observation reads as "nothing is loaded yet" and would send every row to the importers.
 */
import { db } from '@/lib/db'
import { D } from '../../money'
import type { ApplyStepId } from '../constants'
import { FINGERPRINT_SPECS } from '../keys'
import {
  openingStockFingerprint, productCellsFromDb, productFingerprint, purchaseOrderFingerprintFromDb, recipeFromDb, supplierCellsFromDb, supplierFingerprint,
} from '../normal-form'
import type { PreparedRun } from '../prepared'
import { loadFacts } from './journal'
import { TAX_RATE_SELECT, effectiveRate, signatureDigest, taxRateSignature, type TaxRateRow } from './tax-profile'
import { ObservationError, type ObservedEntry, type StepObservation } from '../residual'

export const DATABASE_READ_FAILED = 'the database could not be read'

/** The marker fingerprint of a stock pair that has history which is not exactly one opening layer; it never equals a file's fingerprint. */
export const UNCLEAN_STOCK_PAIR = 'UNCLEAN_STOCK_PAIR'

export async function observeStep(prepared: PreparedRun, step: ApplyStepId): Promise<StepObservation> {
  try {
    switch (step) {
      case 'suppliers': return await observeSuppliers()
      case 'products': return await observeProducts()
      case 'opening-stock': return await observeOpeningStock()
      case 'purchase-orders': return await observePurchaseOrders(prepared)
    }
  } catch (error) {
    if (error instanceof ObservationError) throw error
    // The driver's message can carry a connection string or a value; only the fact survives.
    throw new ObservationError(DATABASE_READ_FAILED)
  }
}

async function observeSuppliers(): Promise<StepObservation> {
  const rows = await db.supplier.findMany({
    select: {
      name: true, contactName: true, email: true, phone: true, currency: true, vatNumber: true, accountNumber: true, paymentTermsDays: true,
      addressLine1: true, addressLine2: true, city: true, county: true, postcode: true, country: true, notes: true,
    },
  })
  const columns = FINGERPRINT_SPECS.suppliers.fingerprinted
  return {
    entries: rows.map((row): ObservedEntry => ({
      // The importer matches by lower(trim(name)).
      key: row.name.trim().toLowerCase(),
      collisionKey: row.name.trim().toUpperCase(),
      fingerprint: supplierFingerprint(columns, supplierCellsFromDb(row)),
      recipe: null,
    })),
  }
}

async function observeProducts(): Promise<StepObservation> {
  const rows = await db.product.findMany({
    select: {
      sku: true, name: true, description: true, type: true, parent: { select: { sku: true } }, barcode: true, mpn: true, countryOfOrigin: true,
      preferredSupplier: { select: { name: true } }, preferredSupplierLocked: true, weight: true, widthCm: true, heightCm: true, depthCm: true,
      salesPriceBase: true, salePriceBase: true, salesPriceTaxInclusive: true, stockUnit: true, oversellAllowed: true, imageUrl: true, active: true,
      lifecycleStatus: true, category: { select: { nameNormalized: true } },
      productComponents: { select: { qty: true, component: { select: { sku: true } } } },
      manufacturingBom: { select: { items: { select: { qty: true, component: { select: { sku: true } } } } } },
    },
  })
  const columns = FINGERPRINT_SPECS.products.fingerprinted
  return {
    entries: rows.map((row): ObservedEntry => {
      const components = recipeFromDb(row.productComponents.map((c) => ({ sku: c.component.sku, qty: c.qty })))
      let recipe = components
      if (row.type === 'BOM') {
        // A BOM has TWO representations of its recipe (the component list and the manufacturing BOM). One without the other is the silent loss
        // the runner exists to catch, so a BOM is "matching" only when both say the same thing.
        const bom = recipeFromDb((row.manufacturingBom?.items ?? []).map((i) => ({ sku: i.component.sku, qty: i.qty })))
        if (bom !== components) recipe = `BOM_REPRESENTATIONS_DIFFER:${components ?? '-'}|${bom ?? '-'}`
      }
      return { key: row.sku, collisionKey: row.sku.toUpperCase(), fingerprint: productFingerprint(columns, productCellsFromDb(row), 'db'), recipe }
    }),
  }
}

async function observeOpeningStock(): Promise<StepObservation> {
  const [layers, levels, movements] = await Promise.all([
    db.costLayer.findMany({
      select: { productId: true, warehouseId: true, receivedQty: true, remainingQty: true, unitCostBase: true, isOpeningStock: true, adjustmentMovementId: true, product: { select: { sku: true } }, warehouse: { select: { code: true } } },
    }),
    db.stockLevel.findMany({ select: { productId: true, warehouseId: true, quantity: true, reservedQty: true, product: { select: { sku: true } }, warehouse: { select: { code: true } } } }),
    db.stockMovement.findMany({ select: { id: true, type: true, productId: true, toWarehouseId: true, fromWarehouseId: true, qty: true } }),
  ])

  interface Pair { sku: string; code: string; layers: typeof layers; level: (typeof levels)[number] | null; movements: typeof movements }
  const pairs = new Map<string, Pair>()
  const pairOf = (productId: string, warehouseId: string, sku: string | null, code: string | null): Pair => {
    const id = `${productId}:${warehouseId}`
    let pair = pairs.get(id)
    if (!pair) { pair = { sku: sku ?? '', code: code ?? '', layers: [], level: null, movements: [] }; pairs.set(id, pair) }
    if (sku !== null) pair.sku = sku
    if (code !== null) pair.code = code
    return pair
  }
  for (const layer of layers) pairOf(layer.productId, layer.warehouseId, layer.product.sku, layer.warehouse.code).layers.push(layer)
  for (const level of levels) pairOf(level.productId, level.warehouseId, level.product.sku, level.warehouse.code).level = level
  // A movement names the warehouse it moved stock into or out of; its SKU and code are filled in by the layer or level of the same pair, or looked up below.
  const missing = new Set<string>()
  for (const movement of movements) {
    for (const warehouseId of [movement.toWarehouseId, movement.fromWarehouseId]) {
      if (warehouseId === null) continue
      const pair = pairOf(movement.productId, warehouseId, null, null)
      pair.movements.push(movement)
      if (pair.sku === '' || pair.code === '') missing.add(`${movement.productId}:${warehouseId}`)
    }
  }
  if (missing.size > 0) {
    const [products, warehouses] = await Promise.all([
      db.product.findMany({ select: { id: true, sku: true } }),
      db.warehouse.findMany({ select: { id: true, code: true } }),
    ])
    const skuById = new Map(products.map((p) => [p.id, p.sku]))
    const codeById = new Map(warehouses.map((w) => [w.id, w.code]))
    for (const id of missing) {
      const [productId, warehouseId] = id.split(':')
      const pair = pairs.get(id)!
      pair.sku = skuById.get(productId) ?? productId
      pair.code = codeById.get(warehouseId) ?? warehouseId
    }
  }

  const entries: ObservedEntry[] = []
  const foreignHistoryKeys: string[] = []
  for (const [id, pair] of pairs) {
    const [productId, warehouseId] = id.split(':')
    const key = `${pair.sku.toUpperCase()}|${pair.code.toUpperCase()}`
    const emptyLevel = pair.level !== null && new D(pair.level.quantity.toFixed()).isZero() && new D(pair.level.reservedQty.toFixed()).isZero()
    if (pair.layers.length === 0 && pair.movements.length === 0 && (pair.level === null || emptyLevel)) continue // nothing there: an empty level row is not history
    const layer = pair.layers.length === 1 ? pair.layers[0] : null
    const movement = pair.movements.length === 1 ? pair.movements[0] : null
    const clean = layer !== null && movement !== null && pair.level !== null
      && layer.isOpeningStock
      && new D(layer.remainingQty.toFixed()).eq(new D(layer.receivedQty.toFixed()))
      && new D(pair.level.quantity.toFixed()).eq(new D(layer.receivedQty.toFixed()))
      && new D(pair.level.reservedQty.toFixed()).isZero()
      && movement.type === 'OPENING_STOCK' && movement.toWarehouseId === warehouseId && movement.fromWarehouseId === null && movement.productId === productId
      && new D(movement.qty.toFixed()).eq(new D(layer.receivedQty.toFixed())) && layer.adjustmentMovementId === movement.id
    if (clean) {
      entries.push({ key, collisionKey: key, fingerprint: openingStockFingerprint(pair.sku, pair.code, new D(layer.receivedQty.toFixed()), new D(layer.unitCostBase.toFixed())), recipe: null })
    } else {
      foreignHistoryKeys.push(key)
      entries.push({ key, collisionKey: key, fingerprint: UNCLEAN_STOCK_PAIR, recipe: null })
    }
  }
  return { entries, foreignHistoryKeys }
}

/**
 * Is the stored line tax what createPurchaseOrder computes from the line's stored total and the rate it holds NOW?
 *   exclusive prices: tax = round4(total x effective rate);
 *   VAT-inclusive prices (and a rate above zero): the total was gross / (1 + rate), so round4((total + tax) / (1 + rate)) is the total;
 * within one unit in the 4th decimal place (the importer computes in floating point). No rate: no tax.
 */
function taxAmountConsistent(pricesIncludeVat: boolean, line: { totalForeign: { toFixed(): string }; taxForeign: { toFixed(): string }; taxRate: (TaxRateRow & { rate: { toFixed(): string } }) | null }): boolean {
  const total = new D(line.totalForeign.toFixed())
  const tax = new D(line.taxForeign.toFixed())
  const rate = line.taxRate === null ? new D(0) : new D(effectiveRate(line.taxRate))
  const tolerance = new D('0.0001')
  if (rate.isZero()) return tax.isZero()
  if (!pricesIncludeVat) return total.mul(rate).toDecimalPlaces(4, D.ROUND_HALF_UP).minus(tax).abs().lte(tolerance)
  return total.plus(tax).div(rate.plus(1)).toDecimalPlaces(4, D.ROUND_HALF_UP).minus(total).abs().lte(tolerance)
}

async function observePurchaseOrders(prepared: PreparedRun): Promise<StepObservation> {
  const facts = await loadFacts()
  const profiles = typeof facts.taxProfiles === 'object' && facts.taxProfiles !== null ? (facts.taxProfiles as Record<string, string>) : null
  const fileFingerprints = new Map((prepared.steps.find((s) => s.step === 'purchase-orders')?.units ?? []).map((u) => [u.key, u.fingerprint]))
  const rows = await db.purchaseOrder.findMany({
    select: {
      reference: true, currency: true, fxRateToBase: true, taxRateName: true, taxRatePercent: true, pricesIncludeVat: true, supplierRef: true,
      expectedDelivery: true, discountAmount: true, notes: true, status: true,
      supplier: { select: { name: true, currency: true } }, destinationWarehouse: { select: { code: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        select: { qty: true, totalForeign: true, taxForeign: true, discountAmount: true, discountStr: true, product: { select: { sku: true } }, taxRate: { select: { name: true, rate: true, usedFor: true, active: true, accountingTaxType: true, isCompound: true, reverseCharge: true, reportingCategory: true, components: TAX_RATE_SELECT.components } } },
      },
    },
  })
  const columns = FINGERPRINT_SPECS['purchase-orders'].fingerprinted
  return {
    entries: rows.map((row): ObservedEntry => ({
      key: row.reference,
      collisionKey: row.reference.toUpperCase(),
      fingerprint: purchaseOrderFingerprintFromDb(columns, { ...row, lines: row.lines.map((l) => ({ ...l, taxRate: l.taxRate ? { name: l.taxRate.name, rate: l.taxRate.rate, profileDigest: signatureDigest(taxRateSignature(l.taxRate)) } : null, taxAmountConsistent: taxAmountConsistent(row.pricesIncludeVat, l) })) }, fileFingerprints.get(row.reference) ?? null, profiles),
      recipe: null,
    })),
  }
}
