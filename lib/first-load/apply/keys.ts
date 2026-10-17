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
 */
import { NUMERIC_LIMITS } from '../spec'
import { D, fmt, fmtFixed, parseDecimal } from '../money'
import type { ApplyStepId } from './constants'

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

const PRODUCT_NUMERIC_COLUMNS = new Set(['weight', 'widthCm', 'heightCm', 'depthCm', 'salesPriceBase', 'salePriceBase'])
const PRODUCT_BOOLEAN_COLUMNS = new Set(['preferredSupplierLocked', 'salesPriceTaxInclusive', 'oversellAllowed', 'active'])
/** Columns that would make an importer match by id instead of by natural key. They must be blank in a first load. */
const PRODUCT_ID_COLUMNS = ['productId', 'parentProductId'] as const

function indexOf(header: string[]): Map<string, number> {
  return new Map(header.map((name, i) => [name, i]))
}

function normaliseNumber(raw: string): string {
  const parsed = parseDecimal(raw, 'value', { maxIntDigits: 20, maxDp: 12 }, { allowNegative: true })
  return parsed.ok ? fmt(parsed.value) : raw.trim()
}

/** "SKU:qty;SKU:qty" to a sorted multiset string; problems are returned, never thrown. */
export function parseComponentsCell(cell: string, owner: string): { recipe: string | null; problems: string[] } {
  const text = cell.trim()
  if (text === '') return { recipe: null, problems: [] }
  const problems: string[] = []
  const parts: string[] = []
  const seen = new Set<string>()
  for (const piece of text.split(';')) {
    const colon = piece.lastIndexOf(':')
    if (colon <= 0) { problems.push(`${owner}: component "${piece}" is not SKU:quantity`); continue }
    const sku = piece.slice(0, colon).trim()
    const qty = parseDecimal(piece.slice(colon + 1), `${owner}: component ${sku} quantity`, NUMERIC_LIMITS.lineQty)
    if (sku === '') { problems.push(`${owner}: a component has no SKU`); continue }
    if (!qty.ok) { problems.push(qty.reason); continue }
    if (!qty.value.gt(new D(0))) { problems.push(`${owner}: component ${sku} quantity must be greater than zero`); continue }
    const upper = sku.toUpperCase()
    if (seen.has(upper)) { problems.push(`${owner}: component ${sku} appears twice in one recipe`); continue }
    seen.add(upper)
    parts.push(`${upper}:${fmtFixed(qty.value, NUMERIC_LIMITS.lineQty.maxDp)}`)
  }
  return { recipe: problems.length > 0 ? null : parts.sort().join(';'), problems }
}

/** The SKUs a components cell names (exact case, as written), for the cross-file checks. */
export function componentSkus(cell: string): string[] {
  return cell.trim() === '' ? [] : cell.split(';').map((piece) => piece.slice(0, piece.lastIndexOf(':')).trim())
}

function registerUnique(step: ApplyStepId, units: KeyedUnit[], problems: string[]): void {
  const byKey = new Map<string, KeyedUnit>()
  const byCollision = new Map<string, KeyedUnit>()
  for (const unit of units) {
    const sameKey = byKey.get(unit.key)
    if (sameKey) problems.push(`${step}: the key ${JSON.stringify(unit.key)} appears more than once (lines ${unit.rowIndexes.map((i) => i + 1).join(', ')} of the step); the importer would not load it twice`)
    else byKey.set(unit.key, unit)
    const sameCollision = byCollision.get(unit.collisionKey)
    if (sameCollision && !sameKey) problems.push(`${step}: ${JSON.stringify(unit.key)} and ${JSON.stringify(sameCollision.key)} differ only in letter case; the importers' case-insensitive lookups would confuse them`)
    else if (!sameCollision) byCollision.set(unit.collisionKey, unit)
  }
}

export function keyStep(step: ApplyStepId, data: StepRows): KeyedStep {
  const col = indexOf(data.header)
  const problems: string[] = []
  const units: KeyedUnit[] = []
  const get = (row: StepRow, name: string): string => (col.has(name) ? row.cells[col.get(name)!] ?? '' : '')
  const where = (row: StepRow) => `chunk ${row.chunk} line ${row.line}`

  if (step === 'suppliers') {
    data.rows.forEach((row, index) => {
      const name = get(row, 'name')
      if (name.trim() === '' || name !== name.trim()) { problems.push(`suppliers ${where(row)}: the name is blank or has surrounding spaces`); return }
      if (get(row, 'supplierId') !== '') problems.push(`suppliers ${where(row)}: supplierId must be blank (an id would make the importer match by id, not by name)`)
      const fields: Record<string, string> = {}
      for (const name2 of data.header) if (name2 !== 'supplierId') fields[name2] = name2 === 'paymentTermsDays' ? normaliseNumber(get(row, name2)) : name2 === 'currency' ? get(row, name2).trim().toUpperCase() : get(row, name2).trim()
      units.push({ step, key: name.toLowerCase(), collisionKey: name.toUpperCase(), fingerprint: JSON.stringify(fields), recipe: null, rowIndexes: [index] })
    })
  } else if (step === 'products') {
    data.rows.forEach((row, index) => {
      const sku = get(row, 'sku')
      if (sku === '' || sku !== sku.trim()) { problems.push(`products ${where(row)}: the SKU is blank or has surrounding spaces`); return }
      for (const idColumn of PRODUCT_ID_COLUMNS) if (get(row, idColumn) !== '') problems.push(`products ${where(row)}: ${idColumn} must be blank (an id would make the importer match by id, not by SKU)`)
      const type = get(row, 'type')
      const components = parseComponentsCell(get(row, 'components'), `products ${where(row)} (${sku})`)
      problems.push(...components.problems)
      if ((type === 'KIT' || type === 'BOM') && components.recipe === null && components.problems.length === 0) problems.push(`products ${where(row)} (${sku}): a ${type} without components would load with no recipe`)
      if (type !== 'KIT' && type !== 'BOM' && get(row, 'components') !== '') problems.push(`products ${where(row)} (${sku}): only a KIT or BOM can carry components`)
      const fields: Record<string, string> = {}
      for (const name of data.header) {
        if ((PRODUCT_ID_COLUMNS as readonly string[]).includes(name) || name === 'components') continue
        const value = get(row, name).trim()
        fields[name] = PRODUCT_NUMERIC_COLUMNS.has(name) && value !== '' ? normaliseNumber(value) : PRODUCT_BOOLEAN_COLUMNS.has(name) ? value.toLowerCase() : value
      }
      units.push({ step, key: sku, collisionKey: sku.toUpperCase(), fingerprint: JSON.stringify(fields), recipe: components.recipe, rowIndexes: [index] })
    })
  } else if (step === 'opening-stock') {
    data.rows.forEach((row, index) => {
      const sku = get(row, 'sku').trim()
      const warehouse = get(row, 'warehouseCode').trim()
      if (sku === '' || warehouse === '') { problems.push(`opening-stock ${where(row)}: the SKU or warehouse code is blank`); return }
      const qty = parseDecimal(get(row, 'qty'), `opening-stock ${where(row)} qty`, NUMERIC_LIMITS.stockQty)
      const cost = parseDecimal(get(row, 'unitCostBase'), `opening-stock ${where(row)} unitCostBase`, NUMERIC_LIMITS.unitCost)
      if (!qty.ok) { problems.push(qty.reason); return }
      if (!cost.ok) { problems.push(cost.reason); return }
      if (!qty.value.gt(new D(0))) { problems.push(`opening-stock ${where(row)}: quantity must be greater than zero (the importer refuses it)`); return }
      const key = `${sku.toUpperCase()}|${warehouse.toUpperCase()}`
      const fields = { sku: sku.toUpperCase(), warehouseCode: warehouse.toUpperCase(), qty: fmt(qty.value), unitCostBase: fmtFixed(cost.value, 6) }
      units.push({ step, key, collisionKey: key, fingerprint: JSON.stringify(fields), recipe: null, rowIndexes: [index] })
    })
  } else {
    const orders = new Map<string, number[]>()
    data.rows.forEach((row, index) => {
      const key = get(row, 'orderKey')
      if (key === '' || key !== key.trim()) { problems.push(`purchase-orders ${where(row)}: the orderKey is blank or has surrounding spaces`); return }
      ;(orders.get(key) ?? orders.set(key, []).get(key)!).push(index)
    })
    const ORDER_LEVEL = ['supplierName', 'currency', 'fxRateToBase', 'destinationWarehouseCode', 'orderTaxRateName', 'orderTaxRateValue', 'pricesIncludeVat', 'supplierRef', 'expectedDelivery', 'orderDiscountForeign']
    for (const [key, indexes] of orders) {
      const first = data.rows[indexes[0]]
      for (const name of ORDER_LEVEL) {
        if (indexes.some((i) => get(data.rows[i], name) !== get(first, name))) problems.push(`purchase-orders ${key}: the lines disagree on ${name}`)
      }
      const lines: string[] = []
      for (const i of indexes) {
        const row = data.rows[i]
        const qty = parseDecimal(get(row, 'qty'), `purchase-orders ${where(row)} qty`, NUMERIC_LIMITS.lineQty)
        const cost = parseDecimal(get(row, 'unitCostForeign'), `purchase-orders ${where(row)} unitCostForeign`, NUMERIC_LIMITS.unitCost)
        const sku = get(row, 'sku').trim()
        if (!qty.ok) { problems.push(qty.reason); continue }
        if (!cost.ok) { problems.push(cost.reason); continue }
        if (sku === '') { problems.push(`purchase-orders ${where(row)}: the SKU is blank`); continue }
        if (!qty.value.gt(new D(0))) { problems.push(`purchase-orders ${where(row)}: quantity must be greater than zero`); continue }
        lines.push(`${sku.toUpperCase()}|${fmtFixed(qty.value, 4)}|${fmtFixed(cost.value, 6)}`)
      }
      const fx = get(first, 'fxRateToBase').trim()
      const fields = {
        supplierName: get(first, 'supplierName').trim().toUpperCase(),
        currency: get(first, 'currency').trim().toUpperCase(),
        fxRateToBase: fx === '' ? '' : normaliseNumber(fx),
        destinationWarehouseCode: get(first, 'destinationWarehouseCode').trim().toUpperCase(),
        status: 'DRAFT',
        lines: lines.sort(),
      }
      units.push({ step, key, collisionKey: key.toUpperCase(), fingerprint: JSON.stringify(fields), recipe: null, rowIndexes: indexes })
    }
    units.sort((a, b) => a.rowIndexes[0] - b.rowIndexes[0])
  }
  for (const unit of units) {
    const chunks = new Set(unit.rowIndexes.map((i) => data.rows[i].chunk))
    if (chunks.size > 1) problems.push(`${step}: ${JSON.stringify(unit.key)} has rows in ${chunks.size} different files (chunks ${[...chunks].join(', ')}); the importer creates it from the first file and skips the rest, so lines would be lost`)
  }
  registerUnique(step, units, problems)
  return { units, problems }
}
