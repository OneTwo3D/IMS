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
import { headerAmountsEntry, type FileLineNumbers } from './po-amounts'
import { TAX_RATE_SELECT, effectiveRate, signatureDigest, taxRateSignature, type TaxRateRow } from './tax-profile'
import { ObservationError, type ObservedEntry, type StepObservation } from '../residual'

export const DATABASE_READ_FAILED = 'the database could not be read'

/** The marker fingerprint of a stock pair that has history which is not exactly one opening layer; it never equals a file's fingerprint. */
export const UNCLEAN_STOCK_PAIR = 'UNCLEAN_STOCK_PAIR'
/** The warehouse part of the key of a stock movement that names no warehouse. */
export const NO_WAREHOUSE = '(NO WAREHOUSE)'

/** `ok`, or `mismatch:<names of the columns the importer never sets that are no longer at their defaults>`. Names only, never values. */
function defaultsEntry(checks: Record<string, boolean>): string {
  const bad = Object.entries(checks).filter(([, holds]) => !holds).map(([name]) => name).sort()
  return bad.length === 0 ? 'ok' : `mismatch:${bad.join(',')}`
}

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
      // Columns the importer never sets: they keep their defaults (a default VAT rate, prepaid, a delivery-days override and the accounting contact link are accounting-relevant).
      active: true, prepaid: true, taxRateId: true, manualDeliveryDays: true, accountingContactId: true, accountingContactProvenance: true,
    },
  })
  const columns = FINGERPRINT_SPECS.suppliers.fingerprinted
  return {
    entries: rows.map((row): ObservedEntry => ({
      // The importer matches by lower(trim(name)).
      key: row.name.trim().toLowerCase(),
      collisionKey: row.name.trim().toUpperCase(),
      fingerprint: supplierFingerprint(columns, supplierCellsFromDb(row), defaultsEntry({
        active: row.active === true, prepaid: row.prepaid === false, taxRateId: row.taxRateId === null, manualDeliveryDays: row.manualDeliveryDays === null,
        accountingContact: row.accountingContactId === null && row.accountingContactProvenance === null,
      })),
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
      // Columns the importer never sets (taxCategory drives the sales tax; the rest link the product to the shop, the accountant, customs and replenishment).
      taxCategory: true, hsCode: true, customsDescription: true, externalProductId: true, accountingItemId: true, accountingItemProvenance: true,
      reorderPoint: true, reorderQty: true, safetyStockQty: true, leadTimeDays: true, abcClass: true,
      productComponents: { select: { qty: true, component: { select: { sku: true } } } },
      manufacturingBom: { select: { active: true, items: { select: { qty: true, component: { select: { sku: true } } } } } },
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
        // Planning reads only ACTIVE manufacturing BOMs: an inactive one is the same silent loss as a missing one.
        else if (row.manufacturingBom && !row.manufacturingBom.active) recipe = `BOM_INACTIVE:${components ?? '-'}`
      }
      return { key: row.sku, collisionKey: row.sku.toUpperCase(), fingerprint: productFingerprint(columns, productCellsFromDb(row), 'db', defaultsEntry({
          taxCategory: row.taxCategory === 'STANDARD',
          unlinked: row.externalProductId === null && row.accountingItemId === null && row.accountingItemProvenance === null,
          customs: row.hsCode === null && row.customsDescription === null,
          replenishment: row.reorderPoint === null && row.reorderQty === null && row.safetyStockQty === null && row.leadTimeDays === null && row.abcClass === null,
        })), recipe }
    }),
  }
}

function movementValueMatches(movement: { unitCostBase: { toFixed(): string } | null; totalValueBase: { toFixed(): string } | null }, layer: { receivedQty: { toFixed(): string }; unitCostBase: { toFixed(): string } }): boolean {
  if (movement.unitCostBase === null || movement.totalValueBase === null) return false
  // What buildStockMovementValueFields writes: the unit cost to 6 dp, and quantity x that unit cost to 6 dp (not called here: its production call sites are a pinned census).
  const unit = new D(layer.unitCostBase.toFixed()).toDecimalPlaces(6, D.ROUND_HALF_UP)
  const total = new D(layer.receivedQty.toFixed()).abs().mul(unit).toDecimalPlaces(6, D.ROUND_HALF_UP)
  return new D(movement.unitCostBase.toFixed()).toFixed(6) === unit.toFixed(6) && new D(movement.totalValueBase.toFixed()).toFixed(6) === total.toFixed(6)
}

async function observeOpeningStock(): Promise<StepObservation> {
  const [layers, levels, movements] = await Promise.all([
    db.costLayer.findMany({
      select: { productId: true, warehouseId: true, receivedQty: true, remainingQty: true, unitCostBase: true, isOpeningStock: true, adjustmentMovementId: true, poLineId: true, productionOrderId: true, receivedAt: true, product: { select: { sku: true } }, warehouse: { select: { code: true } } },
    }),
    db.stockLevel.findMany({ select: { productId: true, warehouseId: true, quantity: true, reservedQty: true, product: { select: { sku: true } }, warehouse: { select: { code: true } } } }),
    db.stockMovement.findMany({ select: { id: true, type: true, productId: true, toWarehouseId: true, fromWarehouseId: true, qty: true, unitCostBase: true, totalValueBase: true, note: true, referenceType: true, referenceId: true, idempotencyKey: true, shipmentLineId: true, createdAt: true } }),
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
  // A movement with NEITHER warehouse (the application writes these for historical sales imports) belongs to no (product, warehouse) pair, so the pair loop would never see it: it is
  // foreign history of its product, reported under a key of its own.
  const unkeyedProducts = new Set(movements.filter((mv) => mv.toWarehouseId === null && mv.fromWarehouseId === null).map((mv) => mv.productId))
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
  if (unkeyedProducts.size > 0) {
    const skuOf = new Map((await db.product.findMany({ where: { id: { in: [...unkeyedProducts] } }, select: { id: true, sku: true } })).map((p) => [p.id, p.sku]))
    for (const productId of unkeyedProducts) {
      const key = `${(skuOf.get(productId) ?? productId).toUpperCase()}|${NO_WAREHOUSE}`
      foreignHistoryKeys.push(key)
      entries.push({ key, collisionKey: key, fingerprint: UNCLEAN_STOCK_PAIR, recipe: null })
    }
  }
  for (const [id, pair] of pairs) {
    const [productId, warehouseId] = id.split(':')
    const key = `${pair.sku.toUpperCase()}|${pair.code.toUpperCase()}`
    // A pair with nothing at all is absent. A level row alone (even at zero quantity and zero reserved) is NOT: the opening-stock importer treats it as empty and increments it, so a row inserted
    // between attempts would be merged silently, and a crash between the importer's own level and layer writes looks the same. Both are refused as unclean history (recovery: docs, "A lone stock level").
    if (pair.layers.length === 0 && pair.movements.length === 0 && pair.level === null) continue
    const layer = pair.layers.length === 1 ? pair.layers[0] : null
    const movement = pair.movements.length === 1 ? pair.movements[0] : null
    const clean = layer !== null && movement !== null && pair.level !== null
      && layer.isOpeningStock
      && new D(layer.remainingQty.toFixed()).eq(new D(layer.receivedQty.toFixed()))
      && new D(pair.level.quantity.toFixed()).eq(new D(layer.receivedQty.toFixed()))
      && new D(pair.level.reservedQty.toFixed()).isZero()
      && movement.type === 'OPENING_STOCK' && movement.toWarehouseId === warehouseId && movement.fromWarehouseId === null && movement.productId === productId
      && new D(movement.qty.toFixed()).eq(new D(layer.receivedQty.toFixed())) && layer.adjustmentMovementId === movement.id
      // The movement's VALUE is what the opening-stock apply wrote from the layer's quantity and cost (buildStockMovementValueFields), and everything the apply leaves empty is empty.
      && movementValueMatches(movement, layer)
      && movement.note === null && movement.referenceType === null && movement.referenceId === null && movement.idempotencyKey === null && movement.shipmentLineId === null
      && layer.poLineId === null && layer.productionOrderId === null && layer.receivedAt.getTime() === movement.createdAt.getTime()
    if (clean) {
      entries.push({ key, collisionKey: key, fingerprint: openingStockFingerprint(pair.sku, pair.code, new D(layer.receivedQty.toFixed()), new D(layer.unitCostBase.toFixed())), recipe: null })
    } else {
      foreignHistoryKeys.push(key)
      entries.push({ key, collisionKey: key, fingerprint: UNCLEAN_STOCK_PAIR, recipe: null })
    }
  }
  return { entries, foreignHistoryKeys }
}

async function observePurchaseOrders(prepared: PreparedRun): Promise<StepObservation> {
  const facts = await loadFacts()
  const profiles = typeof facts.taxProfiles === 'object' && facts.taxProfiles !== null ? (facts.taxProfiles as Record<string, string>) : null
  const fileFingerprints = new Map((prepared.steps.find((s) => s.step === 'purchase-orders')?.units ?? []).map((u) => [u.key, u.fingerprint]))
  const rows = await db.purchaseOrder.findMany({
    select: {
      id: true, supplierId: true, createdAt: true, reference: true, currency: true, fxRateToBase: true, taxRateName: true, taxRatePercent: true, pricesIncludeVat: true, supplierRef: true,
      expectedDelivery: true, discountAmount: true, notes: true, status: true,
      // Every other accounting column createPurchaseOrder writes or defaults (validated in db/po-amounts.ts).
      type: true, landedCostMethod: true, subtotalForeign: true, subtotalBase: true, taxForeign: true, taxBase: true, totalForeign: true, totalBase: true,
      directFreightForeign: true, directFreightBase: true, discountStr: true, internalNotes: true, skipPreferredSupplierUpdate: true, archived: true,
      trackingNumber: true, shippingProvider: true, receivedAt: true, invoicedAt: true, rfqSentAt: true, poSentAt: true,
      _count: { select: { freightCostLines: true } },
      supplier: { select: { name: true, currency: true } }, destinationWarehouse: { select: { code: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        select: { qty: true, totalForeign: true, taxForeign: true, discountAmount: true, discountStr: true,
          productId: true, sortOrder: true, unitCostForeign: true, unitCostBase: true, totalBase: true, taxBase: true, description: true, purchaseUnitId: true, purchaseUnitQty: true, qtyReceived: true, qtyReturned: true, landedUnitCostBase: true, reorderEvidence: true, product: { select: { sku: true } }, taxRate: { select: { name: true, rate: true, usedFor: true, active: true, accountingTaxType: true, isCompound: true, reverseCharge: true, reportingCategory: true, components: TAX_RATE_SELECT.components } } },
      },
    },
  })
  const columns = FINGERPRINT_SPECS['purchase-orders'].fingerprinted
  // The price cache createPurchaseOrder keeps per (supplier, product): its last unit cost and currency, written by an upsert for every line of every order, in the order the orders were created and,
  // inside an order, in line order. So the cache must hold the net unit cost and currency of the LAST write: the last line (highest position) of the LAST created order.
  // "Last created" is decided by the stored creation time, which has millisecond resolution, so orders of one importer call can tie. A tie is NOT ambiguous and never accepts either value: inside a call the
  // importer creates orders strictly one after the other in the order the file lists them (first appearance of the order key; planImportCalls keeps that order), and the calls of an attempt are made in file order, so
  // among orders created in the same millisecond the one listed later in the prepared file was created later. (Orders of different attempts are seconds apart; docs: not proven for a tie across attempts.)
  const fileIndex = new Map((prepared.steps.find((st) => st.step === 'purchase-orders')?.units ?? []).map((u, i) => [u.key, i]))
  const supplierProducts = await db.supplierProduct.findMany({ select: { supplierId: true, productId: true, lastUnitCost: true, currency: true, supplierSku: true, leadTimeDays: true } })
  const cacheByPair = new Map(supplierProducts.map((sp) => [`${sp.supplierId}:${sp.productId}`, sp]))
  const lastByPair = new Map<string, { at: number; index: number; written: string }>()
  for (const row of rows) {
    const lastInOrder = new Map<string, { sortOrder: number; cost: string }>()
    for (const line of row.lines) {
      const pair = `${row.supplierId}:${line.productId}`
      const seen = lastInOrder.get(pair)
      if (!seen || line.sortOrder >= seen.sortOrder) lastInOrder.set(pair, { sortOrder: line.sortOrder, cost: new D(line.unitCostForeign.toFixed()).toFixed(6) })
    }
    const at = row.createdAt.getTime()
    const index = fileIndex.get(row.reference) ?? Number.MAX_SAFE_INTEGER
    for (const [pair, last] of lastInOrder) {
      // What the upsert left in the cache is the cost AND the currency of that last write.
      const best = lastByPair.get(pair)
      if (!best || at > best.at || (at === best.at && index > best.index)) lastByPair.set(pair, { at, index, written: `${last.cost}|${row.currency}` })
    }
  }
  // Only the LAST write per pair is compared with the cache: an earlier order, in whatever currency, is not (the cache was overwritten by what followed it).
  const supplierProductsOk = (row: (typeof rows)[number]): boolean => row.lines.every((line) => {
    const pair = `${row.supplierId}:${line.productId}`
    const cache = cacheByPair.get(pair)
    // The upsert writes only the cost and currency: the supplier's own SKU and the lead time stay what a create gives them (null), so a value there came from somebody else's row the upsert merged into.
    return cache !== undefined && cache.supplierSku === null && cache.leadTimeDays === null && cache.lastUnitCost !== null && lastByPair.get(pair)?.written === `${new D(cache.lastUnitCost.toFixed()).toFixed(6)}|${cache.currency}`
  })
  // The FILE's numbers for each order, in file order (the importer stores lines in that order): quantity, entered unit cost and line discount (KeyedUnit.poLines).
  const fileLines = new Map<string, FileLineNumbers[]>(
    (prepared.steps.find((st) => st.step === 'purchase-orders')?.units ?? []).filter((u) => u.poLines !== undefined).map((u) => [u.key, u.poLines!]),
  )
  return {
    entries: rows.map((row): ObservedEntry => ({
      key: row.reference,
      collisionKey: row.reference.toUpperCase(),
      fingerprint: purchaseOrderFingerprintFromDb(columns, { ...row, headerAmounts: headerAmountsEntry({ ...row, freightCostLineCount: row._count.freightCostLines, supplierProductsOk: supplierProductsOk(row), lines: row.lines.map((l) => ({ ...l, effectiveRate: l.taxRate ? Number(effectiveRate(l.taxRate)) : Number(row.taxRatePercent?.toFixed() ?? 0) })) }, fileLines.get(row.reference) ?? null), lines: row.lines.map((l) => ({ ...l, taxRate: l.taxRate ? { name: l.taxRate.name, rate: l.taxRate.rate, profileDigest: signatureDigest(taxRateSignature(l.taxRate)) } : null})) }, fileFingerprints.get(row.reference) ?? null, profiles),
      recipe: null,
    })),
  }
}
