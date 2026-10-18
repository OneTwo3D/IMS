/**
 * NATURAL KEYS AND FINGERPRINTS: how the runner tells one prepared row from another, and one database row from a prepared row.
 *
 * Pure functions over parsed CSV rows. The database slice builds the SAME key and fingerprint strings from database rows (the
 * `fingerprintFields` below name exactly the fields and their normal forms), so "present and matching" is a string comparison.
 *
 * The importers match case-insensitively in places and case-exactly in others (products by EXACT sku, opening stock and purchase
 * orders by UPPER sku, suppliers by lower-cased name, the purchase-order importer by UPPER supplier name). A key therefore has two
 * parts: `key`, the way the step's own importer matches, and `collisionKey`, the UPPER form. Two different keys with the same
 * collisionKey are a hazard (the importers build a Map and the last duplicate wins silently), so they are refused inside the
 * file and reported as a conflict against the database.
 *
 * PROBLEM TEXT NEVER CARRIES A FILE VALUE. A problem names the step, the chunk and the line (and a column name or a closed reason), never a cell,
 * because the problems reach logs and reports and a cell can hold anything. (The unit KEYS in report rows are a declared, separate exception: see
 * docs/first-load-apply.md, "What a report contains".)
 */
import { NUMERIC_LIMITS } from '../spec'
import { D, fmtFixed, parseDecimal } from '../money'
import type { ApplyStepId } from './constants'
import {
  openingStockFingerprint, productFingerprint, purchaseOrderFingerprint, purchaseOrderHeader, purchaseOrderLine, supplierFingerprint, type CellRecord,
} from './normal-form'

export interface StepRow {
  /** 1-based chunk (file) the row came from. */
  chunk: number
  /** 1-based physical line in that file. */
  line: number
  cells: string[]
}

export interface StepRows {
  header: string[]
  /** Rows of every chunk of the step, in load order. */
  rows: StepRow[]
}

export interface KeyedUnit {
  step: ApplyStepId
  /** How the step's importer matches. */
  key: string
  /** UPPER-CASE form, for the importers' case-insensitive lookups. */
  collisionKey: string
  /** Normal form of everything the importer writes, excluding the recipe. */
  fingerprint: string
  /** Products only: the normalised component multiset, or null when the product has no recipe. */
  recipe: string | null
  /** Indexes into StepRows.rows (a purchase order unit spans all its lines). */
  rowIndexes: number[]
}

export interface KeyedStep {
  units: KeyedUnit[]
  problems: string[]
}

/**
 * THE FINGERPRINT, SINGLE SOURCE. Every column of every importer template is in exactly one place here: the key, the fingerprint, compared
 * separately (the recipe), or explicitly NOT persisted with the reason. tests/first-load/apply-fingerprint.test.ts checks the partition against
 * the template headers and against the columns the importer actually reads, and that a difference in each fingerprinted column is a conflict.
 */
export interface FingerprintSpec {
  key: readonly string[]
  /** Order-level columns of a purchase order (everything else fingerprinted is per line, or the step has one row per unit). */
  fingerprinted: readonly string[]
  /** Purchase orders only: the per-line columns, compared as a multiset. */
  lineLevel?: readonly string[]
  comparedSeparately: Readonly<Record<string, string>>
  notPersisted: Readonly<Record<string, string>>
}

export const FINGERPRINT_SPECS: Readonly<Record<ApplyStepId, FingerprintSpec>> = {
  suppliers: {
    key: ['name'],
    fingerprinted: ['contactName', 'email', 'phone', 'currency', 'vatNumber', 'accountNumber', 'paymentTermsDays', 'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes'],
    comparedSeparately: {},
    notPersisted: { supplierId: 'an id column: it must be blank in a first load, an id would make the importer match by id' },
  },
  products: {
    key: ['sku'],
    fingerprinted: [
      'name', 'description', 'type', 'parentSku', 'barcode', 'mpn', 'countryOfOrigin', 'preferredSupplierId', 'preferredSupplierName', 'preferredSupplierLocked',
      'weight', 'widthCm', 'heightCm', 'depthCm', 'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive', 'stockUnit', 'oversellAllowed', 'imageUrl',
      'active', 'lifecycleStatus', 'category',
    ],
    comparedSeparately: { components: 'the recipe: compared as a multiset of component and quantity (a KIT or BOM)' },
    notPersisted: {
      productId: 'an id column: it must be blank in a first load',
      parentProductId: 'an id column: it must be blank in a first load (the parent is given by parentSku)',
    },
  },
  'opening-stock': {
    key: ['sku', 'warehouseCode'],
    fingerprinted: ['qty', 'unitCostBase'],
    comparedSeparately: {},
    notPersisted: {
      productName: 'descriptive export column: the importer does not read it',
      type: 'descriptive export column: the importer does not read it',
      stockUnit: 'descriptive export column: the importer does not read it',
      warehouseName: 'descriptive export column: the importer does not read it',
      reserved: 'derived export column: the importer does not read it (opening stock has nothing reserved)',
      available: 'derived export column: the importer does not read it',
      inventoryValueBase: 'derived export column: the importer does not read it (the movement value is quantity times cost)',
    },
  },
  'purchase-orders': {
    key: ['orderKey'],
    fingerprinted: ['supplierName', 'currency', 'fxRateToBase', 'destinationWarehouseCode', 'orderTaxRateName', 'orderTaxRateValue', 'pricesIncludeVat', 'supplierRef', 'expectedDelivery', 'orderDiscountForeign', 'notes'],
    lineLevel: ['sku', 'qty', 'unitCostForeign', 'lineDiscountForeign', 'lineDiscountStr', 'taxRateName', 'taxRateValue'],
    comparedSeparately: {},
    notPersisted: {},
  },
}

/** Columns that would make an importer match by id instead of by natural key. They must be blank in a first load. */
const ID_COLUMNS: Readonly<Record<string, readonly string[]>> = { suppliers: ['supplierId'], products: ['productId', 'parentProductId'] }

function indexOf(header: string[]): Map<string, number> {
  return new Map(header.map((name, i) => [name, i]))
}

/** "SKU:qty;SKU:qty" to a sorted multiset string; problems are returned, never thrown, and never carry a cell value. */
export function parseComponentsCell(cell: string, owner: string): { recipe: string | null; problems: string[] } {
  const text = cell.trim()
  if (text === '') return { recipe: null, problems: [] }
  const problems: string[] = []
  const parts: string[] = []
  const seen = new Set<string>()
  for (const piece of text.split(';')) {
    const colon = piece.lastIndexOf(':')
    if (colon <= 0) { problems.push(`${owner}: a component is not SKU:quantity`); continue }
    const sku = piece.slice(0, colon).trim()
    const qty = parseDecimal(piece.slice(colon + 1), 'q', NUMERIC_LIMITS.lineQty)
    if (sku === '') { problems.push(`${owner}: a component has no SKU`); continue }
    if (!qty.ok) { problems.push(`${owner}: a component quantity is not an acceptable number`); continue }
    if (!qty.value.gt(new D(0))) { problems.push(`${owner}: a component quantity is not greater than zero`); continue }
    const upper = sku.toUpperCase()
    if (seen.has(upper)) { problems.push(`${owner}: a component appears twice in one recipe`); continue }
    seen.add(upper)
    parts.push(`${upper}:${fmtFixed(qty.value, NUMERIC_LIMITS.lineQty.maxDp)}`)
  }
  return { recipe: problems.length > 0 ? null : parts.sort().join(';'), problems }
}

/** The SKUs a components cell names (exact case, as written), for the cross-file checks. */
export function componentSkus(cell: string): string[] {
  return cell.trim() === '' ? [] : cell.split(';').map((piece) => piece.slice(0, piece.lastIndexOf(':')).trim())
}

export function rowLocation(row: StepRow): string {
  return `chunk ${row.chunk} line ${row.line}`
}

function registerUnique(step: ApplyStepId, units: KeyedUnit[], rows: StepRow[], problems: string[]): void {
  const byKey = new Map<string, KeyedUnit>()
  const byCollision = new Map<string, KeyedUnit>()
  const at = (unit: KeyedUnit) => rowLocation(rows[unit.rowIndexes[0]])
  for (const unit of units) {
    const sameKey = byKey.get(unit.key)
    if (sameKey) problems.push(`${step} ${at(unit)}: the same key as ${at(sameKey)}; the importer would not load it twice`)
    else byKey.set(unit.key, unit)
    const sameCollision = byCollision.get(unit.collisionKey)
    if (sameCollision && !sameKey) problems.push(`${step} ${at(unit)}: differs from ${at(sameCollision)} only in letter case; the importers' case-insensitive lookups would confuse them`)
    else if (!sameCollision) byCollision.set(unit.collisionKey, unit)
  }
}

export function keyStep(step: ApplyStepId, data: StepRows): KeyedStep {
  const col = indexOf(data.header)
  const problems: string[] = []
  const units: KeyedUnit[] = []
  const spec = FINGERPRINT_SPECS[step]
  const get = (row: StepRow, name: string): string => (col.has(name) ? row.cells[col.get(name)!] ?? '' : '')
  const where = (row: StepRow) => `${step} ${rowLocation(row)}`
  const cellsOf = (row: StepRow): CellRecord => Object.fromEntries(data.header.map((name, i) => [name, row.cells[i] ?? '']))
  for (const row of data.rows) for (const idColumn of ID_COLUMNS[step] ?? []) if (get(row, idColumn) !== '') problems.push(`${where(row)}: ${idColumn} must be blank (an id would make the importer match by id, not by natural key)`)

  if (step === 'suppliers') {
    data.rows.forEach((row, index) => {
      const name = get(row, 'name')
      if (name.trim() === '' || name !== name.trim()) { problems.push(`${where(row)}: the name is blank or has surrounding spaces`); return }
      units.push({ step, key: name.toLowerCase(), collisionKey: name.toUpperCase(), fingerprint: supplierFingerprint(spec.fingerprinted, cellsOf(row)), recipe: null, rowIndexes: [index] })
    })
  } else if (step === 'products') {
    data.rows.forEach((row, index) => {
      const sku = get(row, 'sku')
      if (sku === '' || sku !== sku.trim()) { problems.push(`${where(row)}: the SKU is blank or has surrounding spaces`); return }
      const type = get(row, 'type')
      const components = parseComponentsCell(get(row, 'components'), where(row))
      problems.push(...components.problems)
      if ((type === 'KIT' || type === 'BOM') && components.recipe === null && components.problems.length === 0) problems.push(`${where(row)}: a ${type} without components would load with no recipe`)
      if (type !== 'KIT' && type !== 'BOM' && get(row, 'components') !== '') problems.push(`${where(row)}: only a KIT or BOM can carry components`)
      units.push({ step, key: sku, collisionKey: sku.toUpperCase(), fingerprint: productFingerprint(spec.fingerprinted, cellsOf(row), 'file'), recipe: components.recipe, rowIndexes: [index] })
    })
  } else if (step === 'opening-stock') {
    data.rows.forEach((row, index) => {
      const sku = get(row, 'sku').trim()
      const warehouse = get(row, 'warehouseCode').trim()
      if (sku === '' || warehouse === '') { problems.push(`${where(row)}: the SKU or warehouse code is blank`); return }
      const qty = parseDecimal(get(row, 'qty'), 'q', NUMERIC_LIMITS.stockQty)
      const cost = parseDecimal(get(row, 'unitCostBase'), 'c', NUMERIC_LIMITS.unitCost)
      if (!qty.ok) { problems.push(`${where(row)}: qty is not an acceptable number`); return }
      if (!cost.ok) { problems.push(`${where(row)}: unitCostBase is not an acceptable number`); return }
      if (!qty.value.gt(new D(0))) { problems.push(`${where(row)}: quantity must be greater than zero (the importer refuses it)`); return }
      const key = `${sku.toUpperCase()}|${warehouse.toUpperCase()}`
      units.push({ step, key, collisionKey: key, fingerprint: openingStockFingerprint(sku, warehouse, qty.value, cost.value), recipe: null, rowIndexes: [index] })
    })
  } else {
    const orders = new Map<string, number[]>()
    data.rows.forEach((row, index) => {
      const key = get(row, 'orderKey')
      if (key === '' || key !== key.trim()) { problems.push(`${where(row)}: the orderKey is blank or has surrounding spaces`); return }
      ;(orders.get(key) ?? orders.set(key, []).get(key)!).push(index)
    })
    for (const [key, indexes] of orders) {
      const first = data.rows[indexes[0]]
      for (const name of spec.fingerprinted) {
        const other = indexes.find((i) => get(data.rows[i], name) !== get(first, name))
        if (other !== undefined) problems.push(`${where(data.rows[other])}: the line disagrees with ${rowLocation(first)} on ${name}`)
      }
      const lines: string[] = []
      for (const i of indexes) {
        const row = data.rows[i]
        const qty = parseDecimal(get(row, 'qty'), 'q', NUMERIC_LIMITS.lineQty)
        const cost = parseDecimal(get(row, 'unitCostForeign'), 'c', NUMERIC_LIMITS.unitCost)
        const sku = get(row, 'sku').trim()
        if (!qty.ok) { problems.push(`${where(row)}: qty is not an acceptable number`); continue }
        if (!cost.ok) { problems.push(`${where(row)}: unitCostForeign is not an acceptable number`); continue }
        if (sku === '') { problems.push(`${where(row)}: the SKU is blank`); continue }
        if (!qty.value.gt(new D(0))) { problems.push(`${where(row)}: quantity must be greater than zero`); continue }
        lines.push(purchaseOrderLine(cellsOf(row), qty.value, cost.value))
      }
      units.push({ step, key, collisionKey: key.toUpperCase(), fingerprint: purchaseOrderFingerprint(purchaseOrderHeader(spec.fingerprinted, cellsOf(first)), lines), recipe: null, rowIndexes: indexes })
    }
    units.sort((a, b) => a.rowIndexes[0] - b.rowIndexes[0])
  }
  for (const unit of units) {
    const chunks = new Set(unit.rowIndexes.map((i) => data.rows[i].chunk))
    if (chunks.size > 1) problems.push(`${step} ${rowLocation(data.rows[unit.rowIndexes[0]])}: the rows of this order are in ${chunks.size} different files (chunks ${[...chunks].join(', ')}); the importer creates it from the first file and skips the rest, so lines would be lost`)
  }
  registerUnique(step, units, data.rows, problems)
  return { units, problems }
}
