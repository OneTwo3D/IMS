/**
 * THE NORMAL FORM: the ONE place that decides what "the same value" means for the first-load runner.
 *
 * A prepared row is compared with a database row as a string. The file side builds that string from the cells of a CSV row; the
 * database side builds it from a database row turned back into the cells the importer would have read to write it. Both go through
 * the SAME functions here, so a difference in how a value is written (a trailing zero, a case, a default the importer applies, a
 * percentage written as 20 or 0.2, a date written without a time) is settled once, in this file, and nowhere else.
 *
 * WHAT A RULE HERE MEANS. Each rule mirrors what the importer does with the cell, so the file form is "what the importer would
 * store" and the database form is "what the importer stored":
 *   - blank cells take the importer's default (stock unit "pcs", oversell allowed, lifecycle ACTIVE, base currency, ...);
 *   - numbers are plain decimals without trailing zeros (4 dp or 6 dp where the importer's column rounds);
 *   - booleans are the importer's own reading (1, true, yes, y);
 *   - a country is the ISO code the importer resolves, a category is its normalised path;
 *   - a purchase order line carries the entered amount after discount, because the stored unit cost is the net of VAT and discount.
 *
 * PURE: no database, no network, no clock. The database rows are described structurally (anything with `toFixed()` is a decimal), so
 * this file does not import the Prisma client's row types.
 */
import { toIsoCountryCode } from '@/lib/countries'
import { normalizeCsvCountryOfOrigin } from '@/lib/products/country-of-origin'
import { buildProductCategoryPathNormalized, cleanProductCategoryName, parseProductCategoryPath } from '@/lib/products/category-name'
import { D, fmt, fmtFixed, parseDecimal, type Dec } from '../money'

/** One row as column name to the cell text an importer would read ('' for a blank cell). */
export type CellRecord = Readonly<Record<string, string>>

/** The base currency the first load supports; a supplier or order with no currency takes it (the importers' own default). */
export const NORMAL_FORM_BASE_CURRENCY = 'GBP'
export const DEFAULT_STOCK_UNIT = 'pcs'
export const LIFECYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED'] as const

/** Anything that prints as a plain decimal: a Prisma Decimal, decimal.js, or a string. */
export interface DecimalLike {
  toFixed(): string
}

const cell = (cells: CellRecord, column: string): string => (cells[column] ?? '').trim()

export function decimalText(value: DecimalLike | string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? new D(value).toFixed() : value.toFixed()
}

/** A plain decimal without trailing zeros; blank stays blank; text that is not a number is kept as written (it will not match anything). */
export function normaliseNumber(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  const parsed = parseDecimal(text, 'value', { maxIntDigits: 20, maxDp: 12 }, { allowNegative: true })
  return parsed.ok ? fmt(parsed.value) : text
}

/** The importers' boolean: 1, true, yes or y (any case) is true, anything else false. */
export function importerBoolean(raw: string): 'true' | 'false' {
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'y' ? 'true' : 'false'
}

const SQL_INT = /^[+-]?\d+/

/** `parseInt(x, 10)` as the supplier importer writes it; blank is blank, text that is not a number is kept as written. */
function importerInteger(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  const match = SQL_INT.exec(text)
  return match ? String(Number.parseInt(match[0], 10)) : text
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export function supplierCell(column: string, cells: CellRecord): string {
  const value = cell(cells, column)
  switch (column) {
    case 'currency': return (value === '' ? NORMAL_FORM_BASE_CURRENCY : value).toUpperCase()
    case 'paymentTermsDays': return importerInteger(value)
    case 'country': return value === '' ? '' : (toIsoCountryCode(value) ?? value)
    default: return value
  }
}

export function supplierFingerprint(columns: readonly string[], cells: CellRecord): string {
  return JSON.stringify(Object.fromEntries(columns.map((c) => [c, supplierCell(c, cells)])))
}

export interface DbSupplier {
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  currency: string
  vatNumber: string | null
  accountNumber: string | null
  paymentTermsDays: number | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  county: string | null
  postcode: string | null
  country: string | null
  notes: string | null
}

export function supplierCellsFromDb(row: DbSupplier): CellRecord {
  return {
    name: row.name, contactName: row.contactName ?? '', email: row.email ?? '', phone: row.phone ?? '', currency: row.currency,
    vatNumber: row.vatNumber ?? '', accountNumber: row.accountNumber ?? '', paymentTermsDays: row.paymentTermsDays === null ? '' : String(row.paymentTermsDays),
    addressLine1: row.addressLine1 ?? '', addressLine2: row.addressLine2 ?? '', city: row.city ?? '', county: row.county ?? '', postcode: row.postcode ?? '',
    country: row.country ?? '', notes: row.notes ?? '',
  }
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const PRODUCT_NUMERIC = new Set(['weight', 'widthCm', 'heightCm', 'depthCm', 'salesPriceBase', 'salePriceBase'])

/** The category as the importer stores it: the normalised path of the cleaned name ("apparel>t-shirts"); blank when there is none. */
export function normaliseCategory(raw: string): string {
  return buildProductCategoryPathNormalized(parseProductCategoryPath(cleanProductCategoryName(raw)))
}

/** The lifecycle the importer settles on: an exact valid lifecycleStatus cell, else the legacy `active` cell, else ACTIVE. */
function fileLifecycle(cells: CellRecord): string {
  const raw = cell(cells, 'lifecycleStatus')
  if ((LIFECYCLE_STATUSES as readonly string[]).includes(raw)) return raw
  const active = cell(cells, 'active')
  if (active !== '') return active.toUpperCase() !== 'FALSE' ? 'ACTIVE' : 'EOL'
  return 'ACTIVE'
}

export type CellSource = 'file' | 'db'

/**
 * One product column in its normal form. For the FILE the legacy `active` flag is DERIVED from the lifecycle (the importer writes both
 * from the one lifecycle); for the DATABASE both are read as stored, so a row whose two disagree shows as a difference.
 */
export function productCell(column: string, cells: CellRecord, source: CellSource): string {
  const value = cell(cells, column)
  if (PRODUCT_NUMERIC.has(column)) return normaliseNumber(value)
  switch (column) {
    case 'type': return (value === '' ? 'SIMPLE' : value).toUpperCase()
    case 'lifecycleStatus': return source === 'file' ? fileLifecycle(cells) : value
    case 'active': return source === 'file' ? (fileLifecycle(cells) === 'ARCHIVED' ? 'false' : 'true') : importerBoolean(value)
    case 'category': return normaliseCategory(value)
    // An origin the importer cannot resolve is kept as written: it imports the product WITHOUT an origin, so the stored row then differs from the file, and that is reported, not folded away.
    case 'countryOfOrigin': return value === '' ? '' : (normalizeCsvCountryOfOrigin(value) ?? value)
    case 'preferredSupplierName': return value.toLocaleLowerCase('en-US')
    case 'preferredSupplierLocked': return importerBoolean(value)
    case 'salesPriceTaxInclusive': return importerBoolean(value)
    case 'oversellAllowed': return value === '' ? 'true' : importerBoolean(value)
    case 'stockUnit': return value === '' ? DEFAULT_STOCK_UNIT : value
    default: return value
  }
}

export function productFingerprint(columns: readonly string[], cells: CellRecord, source: CellSource): string {
  return JSON.stringify(Object.fromEntries(columns.map((c) => [c, productCell(c, cells, source)])))
}

export interface DbProduct {
  name: string
  description: string | null
  type: string
  parent: { sku: string } | null
  barcode: string | null
  mpn: string | null
  countryOfOrigin: string | null
  preferredSupplier: { name: string } | null
  preferredSupplierLocked: boolean
  weight: DecimalLike | null
  widthCm: DecimalLike | null
  heightCm: DecimalLike | null
  depthCm: DecimalLike | null
  salesPriceBase: DecimalLike | null
  salePriceBase: DecimalLike | null
  salesPriceTaxInclusive: boolean
  stockUnit: string
  oversellAllowed: boolean
  imageUrl: string | null
  active: boolean
  lifecycleStatus: string
  category: { nameNormalized: string } | null
}

export function productCellsFromDb(row: DbProduct): CellRecord {
  return {
    name: row.name, description: row.description ?? '', type: row.type, parentSku: row.parent?.sku ?? '', barcode: row.barcode ?? '', mpn: row.mpn ?? '',
    countryOfOrigin: row.countryOfOrigin ?? '',
    // An id cannot be known to a file in a first load; the file side must be blank, so a stored id is not read back.
    preferredSupplierId: '',
    preferredSupplierName: row.preferredSupplier?.name ?? '', preferredSupplierLocked: String(row.preferredSupplierLocked),
    weight: decimalText(row.weight), widthCm: decimalText(row.widthCm), heightCm: decimalText(row.heightCm), depthCm: decimalText(row.depthCm),
    salesPriceBase: decimalText(row.salesPriceBase), salePriceBase: decimalText(row.salePriceBase), salesPriceTaxInclusive: String(row.salesPriceTaxInclusive),
    stockUnit: row.stockUnit, oversellAllowed: String(row.oversellAllowed), imageUrl: row.imageUrl ?? '', active: String(row.active),
    lifecycleStatus: row.lifecycleStatus, category: row.category?.nameNormalized ?? '',
  }
}

/** The recipe in the normal form the file side computes in `parseComponentsCell` (UPPER SKU, quantity to 4 dp, sorted); null when there is none. */
export function recipeFromDb(components: ReadonlyArray<{ sku: string; qty: DecimalLike }>): string | null {
  if (components.length === 0) return null
  return components.map((c) => `${c.sku.toUpperCase()}:${fmtFixed(new D(c.qty.toFixed()), 4)}`).sort().join(';')
}

// ---------------------------------------------------------------------------
// Opening stock
// ---------------------------------------------------------------------------

export function openingStockFingerprint(sku: string, warehouseCode: string, qty: Dec, unitCostBase: Dec): string {
  return JSON.stringify({ sku: sku.toUpperCase(), warehouseCode: warehouseCode.toUpperCase(), qty: fmt(qty), unitCostBase: fmtFixed(unitCostBase, 6) })
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

/** The importers' tax value: blank, zero or negative is none; above 1 is a percentage and becomes a fraction. */
export function normaliseTaxValue(raw: string): string {
  const parsed = parseDecimal(raw, 'tax', { maxIntDigits: 12, maxDp: 12 }, { allowNegative: true })
  if (!parsed.ok || !parsed.value.gt(new D(0))) return ''
  return fmt(parsed.value.gt(new D(1)) ? parsed.value.div(100) : parsed.value)
}

function dateText(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? text : date.toISOString()
}

/** `max(0, value)` as a plain decimal; blank is zero (the importer passes nothing, the order stores 0). */
function nonNegative(raw: string): string {
  const parsed = parseDecimal(raw, 'amount', { maxIntDigits: 18, maxDp: 8 }, { allowNegative: true })
  if (!parsed.ok) return raw.trim() === '' ? '0' : raw.trim()
  return parsed.value.lt(new D(0)) ? '0' : fmt(parsed.value)
}

/**
 * The order-level fields, in the order of `columns` (the spec's list). The order tax name and value fall back to the FIRST row's line tax
 * columns, as the importer does; a blank rate is 1 (the importer's rate for the base currency).
 */
export function purchaseOrderHeader(columns: readonly string[], first: CellRecord): Record<string, string> {
  const out: Record<string, string> = {}
  for (const column of columns) {
    const value = cell(first, column)
    switch (column) {
      case 'supplierName':
      case 'destinationWarehouseCode': out[column] = value.toUpperCase(); break
      case 'currency': out[column] = value.toUpperCase(); break
      case 'fxRateToBase': out[column] = value === '' ? '1' : normaliseNumber(value); break
      case 'orderTaxRateName': out[column] = value !== '' ? value : cell(first, 'taxRateName'); break
      case 'orderTaxRateValue': out[column] = normaliseTaxValue(cell(first, 'orderTaxRateValue')) || normaliseTaxValue(cell(first, 'taxRateValue')); break
      case 'pricesIncludeVat': out[column] = importerBoolean(value); break
      case 'expectedDelivery': out[column] = dateText(value); break
      case 'orderDiscountForeign': out[column] = nonNegative(value); break
      default: out[column] = value
    }
  }
  return out
}

/** How a line names its tax: by name, by value, or not at all. The importer resolves a rate by name first, then by value. */
function fileLineTaxToken(cells: CellRecord): string {
  const name = cell(cells, 'taxRateName')
  if (name !== '') return `n:${name.toLowerCase()}`
  const value = normaliseTaxValue(cell(cells, 'taxRateValue'))
  return value === '' ? '' : `v:${fmtFixed(new D(value), 4)}`
}

/** The amount the line costs after its discount, as ENTERED (gross when prices include VAT), to 4 dp: what the stored line total can give back. */
function enteredLineAmount(qty: Dec, unitCost: Dec, discount: Dec): Dec {
  const amount = qty.mul(unitCost).minus(discount)
  return (amount.lt(new D(0)) ? new D(0) : amount).toDecimalPlaces(4, D.ROUND_HALF_UP)
}

/** The line fields that do not depend on the tax token, as the prefix of the line string. */
function linePrefix(parts: { sku: string; qty: Dec; amount: Dec; discount: Dec; discountStr: string }): string {
  return [parts.sku.toUpperCase(), fmtFixed(parts.qty, 4), fmtFixed(parts.amount, 4), fmtFixed(parts.discount, 4), parts.discountStr.trim()].join('|')
}

/** One FILE line as a string (the caller has already parsed and range-checked qty and unit cost). */
export function purchaseOrderLine(cells: CellRecord, qty: Dec, unitCost: Dec): string {
  const discountParsed = parseDecimal(cell(cells, 'lineDiscountForeign'), 'discount', { maxIntDigits: 18, maxDp: 8 }, { allowNegative: true })
  const discount = discountParsed.ok && discountParsed.value.gt(new D(0)) ? discountParsed.value : new D(0)
  const prefix = linePrefix({ sku: cell(cells, 'sku'), qty, amount: enteredLineAmount(qty, unitCost, discount), discount, discountStr: cell(cells, 'lineDiscountStr') })
  return `${prefix}|${fileLineTaxToken(cells)}`
}

export function purchaseOrderFingerprint(header: Record<string, string>, lines: readonly string[]): string {
  return JSON.stringify({ ...header, status: 'DRAFT', lines: [...lines].sort() })
}

export interface DbPurchaseOrder {
  supplier: { name: string }
  currency: string
  fxRateToBase: DecimalLike
  destinationWarehouse: { code: string } | null
  taxRateName: string | null
  taxRatePercent: DecimalLike | null
  pricesIncludeVat: boolean
  supplierRef: string | null
  expectedDelivery: Date | null
  discountAmount: DecimalLike
  notes: string | null
  status: string
  lines: ReadonlyArray<{
    product: { sku: string }
    qty: DecimalLike
    totalForeign: DecimalLike
    taxForeign: DecimalLike
    discountAmount: DecimalLike
    discountStr: string | null
    taxRate: { name: string; rate: DecimalLike } | null
  }>
}

/**
 * A database purchase order in the file's normal form. `file` is the prepared order's own fingerprint when there is one: a column the file
 * leaves BLANK takes a default the file cannot know (the supplier's currency; the tax a line inherits from the order), so it is compared only
 * where the file stated it. Without `file` (a foreign order) every column is shown as stored.
 */
export function purchaseOrderFingerprintFromDb(columns: readonly string[], po: DbPurchaseOrder, file: string | null): string {
  const parsedFile = file === null ? null : (JSON.parse(file) as { lines?: string[] } & Record<string, string>)
  const header: Record<string, string> = {}
  for (const column of columns) {
    switch (column) {
      case 'supplierName': header[column] = po.supplier.name.toUpperCase(); break
      case 'currency': header[column] = parsedFile && parsedFile.currency === '' ? '' : po.currency.toUpperCase(); break
      case 'fxRateToBase': header[column] = normaliseNumber(po.fxRateToBase.toFixed()); break
      case 'destinationWarehouseCode': header[column] = (po.destinationWarehouse?.code ?? '').toUpperCase(); break
      case 'orderTaxRateName': header[column] = (po.taxRateName ?? '').trim(); break
      case 'orderTaxRateValue': header[column] = po.taxRatePercent === null ? '' : normaliseNumber(po.taxRatePercent.toFixed()); break
      case 'pricesIncludeVat': header[column] = String(po.pricesIncludeVat); break
      case 'supplierRef': header[column] = (po.supplierRef ?? '').trim(); break
      case 'expectedDelivery': header[column] = po.expectedDelivery === null ? '' : po.expectedDelivery.toISOString(); break
      case 'orderDiscountForeign': header[column] = normaliseNumber(po.discountAmount.toFixed()); break
      case 'notes': header[column] = (po.notes ?? '').trim(); break
      default: header[column] = ''
    }
  }
  // Lines: the non-tax part is exact; the tax token takes the form the matching FILE line used (name, value or none).
  const remaining = [...(parsedFile?.lines ?? [])]
  const lines = po.lines.map((line) => {
    const total = new D(line.totalForeign.toFixed())
    const amount = po.pricesIncludeVat ? total.plus(new D(line.taxForeign.toFixed())) : total
    const prefix = linePrefix({
      sku: line.product.sku, qty: new D(line.qty.toFixed()), amount, discount: new D(line.discountAmount.toFixed()), discountStr: line.discountStr ?? '',
    })
    const at = remaining.findIndex((candidate) => candidate.startsWith(`${prefix}|`))
    const token = at === -1 ? null : remaining.splice(at, 1)[0].slice(prefix.length + 1)
    const byName = line.taxRate ? `n:${line.taxRate.name.trim().toLowerCase()}` : ''
    const byValue = line.taxRate ? `v:${fmtFixed(new D(line.taxRate.rate.toFixed()), 4)}` : ''
    return `${prefix}|${token === null ? byName : token === '' ? '' : token.startsWith('v:') ? byValue : byName}`
  })
  return JSON.stringify({ ...header, status: po.status, lines: lines.sort() })
}
