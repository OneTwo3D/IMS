import { Prisma } from '@/app/generated/prisma/client'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import type { Permission } from '@/lib/permissions'
import { stripCsvFormulaGuard } from '@/lib/csv'
import {
  buildProductCategoryPathNormalized,
  parseProductCategoryPath,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
} from '@/lib/products/category-name'
import { blocksClearingInvalidOrigin, normalizeCsvCountryOfOrigin } from '@/lib/products/country-of-origin'
import {
  CSV_CLEAR_TOKEN,
  PRODUCT_CSV_KEY_COLUMN,
  findProductCsvColumn,
  type ProductCsvColumn,
} from '@/lib/products/csv-roundtrip/columns'

/**
 * The PURE half of the CSV round trip: read a file's cells, decide per product which fields change, and say why a row
 * cannot be applied. It touches no database; the caller hands it the current products and the lookup tables.
 *
 * THE RULES (each one is pinned by tests/products/csv-roundtrip.test.ts):
 *   - a column that is absent from the file is never read, so it can never be written;
 *   - a BLANK cell means "leave unchanged". It never clears. (The importer-wide destructive-blank bug: an export that
 *     leaves a description empty must not wipe the description it did not know about.)
 *   - the token {@link CSV_CLEAR_TOKEN} clears, and only a nullable field accepts it;
 *   - an unknown SKU is an error, not a create: this is an update-only path;
 *   - an unrecognised value is an error for its row, never a silent default (the importer's boolean reader turns every
 *     word it does not know into FALSE; this one refuses it);
 *   - a row with any error writes nothing at all, so a product is never half-edited.
 */

/** What the plan needs to know about a product as it stands. Decimals arrive as strings. */
export type RoundTripProduct = {
  id: string
  sku: string
  name: string
  description: string | null
  barcode: string | null
  mpn: string | null
  countryOfOrigin: string | null
  weight: string | null
  widthCm: string | null
  heightCm: string | null
  depthCm: string | null
  imageUrl: string | null
  salesPriceBase: string | null
  salePriceBase: string | null
  salesPriceTaxInclusive: boolean
  stockUnit: string
  oversellAllowed: boolean
  preferredSupplierId: string | null
  preferredSupplierLocked: boolean
  categoryId: string | null
  lifecycleStatus: ProductLifecycleStatus
}

export type PlanLookups = {
  /** Lower-cased supplier name to id. */
  supplierIdByName: ReadonlyMap<string, string>
  supplierNameById: ReadonlyMap<string, string>
  /** `ProductCategory.nameNormalized` (the normalised path) to id. */
  categoryIdByPath: ReadonlyMap<string, string>
  /** Category id to its display path ("Apparel > T-Shirts"). */
  categoryPathById: ReadonlyMap<string, string>
  /** For the barcodes this chunk wants to set: barcode to the id of the product that holds it today. */
  barcodeOwners: ReadonlyMap<string, string>
}

/** State carried across the chunks of one file, so a duplicate is caught however far apart its rows are. */
export type PlanFileState = {
  seenSkus: Map<string, number>
  seenBarcodes: Map<string, string>
}

export function newPlanFileState(): PlanFileState {
  return { seenSkus: new Map(), seenBarcodes: new Map() }
}

export type FieldChange = {
  column: string
  label: string
  field: string
  /** Display text, for the preview. */
  from: string
  to: string
  /** What the database column takes. */
  value: string | boolean | null
}

export type RowOutcome =
  | { kind: 'error'; line: number; sku: string; message: string }
  | { kind: 'unchanged'; line: number; sku: string }
  | { kind: 'change'; line: number; sku: string; product: RoundTripProduct; changes: FieldChange[] }

export type HeaderAnalysis =
  | { ok: false; error: string }
  | { ok: true; columns: ProductCsvColumn[]; ignored: string[]; headerByColumn: Map<string, string>; skuHeader: string }

/** Which of the file's headers are editable columns. The file must carry SKU and at least one editable column. */
export function analyseProductCsvHeaders(headers: readonly string[], canUse: (permission: Permission) => boolean): HeaderAnalysis {
  let skuHeader: string | null = null
  const seen = new Set<string>()
  const columns: ProductCsvColumn[] = []
  const ignored: string[] = []
  const headerByColumn = new Map<string, string>()
  for (const header of headers) {
    const lowered = header.trim().toLowerCase()
    if (seen.has(lowered)) return { ok: false, error: `The column "${header.trim()}" appears more than once in the file.` }
    seen.add(lowered)
    if (lowered === PRODUCT_CSV_KEY_COLUMN) { skuHeader = header; continue }
    const column = findProductCsvColumn(header)
    if (column) {
      columns.push(column)
      headerByColumn.set(column.key, header)
    } else if (lowered !== '') {
      ignored.push(header.trim())
    }
  }
  if (!skuHeader) return { ok: false, error: 'The file has no "sku" column. SKU is the key that matches each row to a product.' }
  if (columns.length === 0) return { ok: false, error: 'The file has no editable columns besides sku, so there is nothing to change.' }
  const blocked = columns.filter((column) => column.requires && !canUse(column.requires))
  if (blocked.length > 0) {
    return {
      ok: false,
      error: `The file changes ${blocked.map((column) => column.key).join(', ')}, which needs the ${blocked[0].requires} permission. You do not have it, so nothing was applied.`,
    }
  }
  return { ok: true, columns, ignored, headerByColumn, skuHeader }
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'n', '0'])
const LIFECYCLE_VALUES = new Set(['DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED'])
const DECIMAL_LITERAL = /^\d+(?:\.\d+)?$/

type Parsed = { ok: true; value: string | boolean | null; display: string } | { ok: false; message: string }

function bad(message: string): Parsed { return { ok: false, message } }

function parseDecimal(column: ProductCsvColumn, raw: string): Parsed {
  const { precision, scale } = column.decimal!
  if (!DECIMAL_LITERAL.test(raw)) return bad(`${column.key}: "${raw}" is not a non-negative number (digits and an optional decimal point only)`)
  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > scale) return bad(`${column.key}: "${raw}" has more than ${scale} decimal places`)
  if (whole.replace(/^0+(?=\d)/, '').length > precision - scale) return bad(`${column.key}: "${raw}" is too large`)
  const value = new Prisma.Decimal(raw).toFixed(scale)
  return { ok: true, value, display: value }
}

function parseBoolean(column: ProductCsvColumn, raw: string): Parsed {
  const word = raw.toLowerCase()
  if (TRUE_WORDS.has(word)) return { ok: true, value: true, display: 'TRUE' }
  if (FALSE_WORDS.has(word)) return { ok: true, value: false, display: 'FALSE' }
  return bad(`${column.key}: "${raw}" is not TRUE or FALSE`)
}

function parseValue(column: ProductCsvColumn, raw: string, lookups: PlanLookups): Parsed {
  switch (column.kind) {
    case 'text': {
      if (column.maxLength && raw.length > column.maxLength) return bad(`${column.key}: longer than ${column.maxLength} characters`)
      return { ok: true, value: raw, display: raw }
    }
    case 'decimal': return parseDecimal(column, raw)
    case 'boolean': return parseBoolean(column, raw)
    case 'country': {
      const iso = normalizeCsvCountryOfOrigin(raw)
      if (!iso) return bad(`${column.key}: unrecognised country "${raw}" (use a country name or ISO code)`)
      return { ok: true, value: iso, display: iso }
    }
    case 'lifecycle': {
      const upper = raw.toUpperCase()
      if (!LIFECYCLE_VALUES.has(upper)) return bad(`${column.key}: "${raw}" is not one of DRAFT, ACTIVE, EOL, ARCHIVED`)
      return { ok: true, value: upper, display: upper }
    }
    case 'supplier': {
      const id = lookups.supplierIdByName.get(raw.toLocaleLowerCase('en-US'))
      if (!id) return bad(`${column.key}: preferred supplier "${raw}" not found`)
      return { ok: true, value: id, display: lookups.supplierNameById.get(id) ?? raw }
    }
    case 'category': {
      const segments = parseProductCategoryPath(raw)
      if (segments.length === 0) return bad(`${column.key}: "${raw}" is not a category path`)
      if (segments.some((segment) => segment.length > PRODUCT_CATEGORY_NAME_MAX_LENGTH)) {
        return bad(`${column.key}: each category name must be ${PRODUCT_CATEGORY_NAME_MAX_LENGTH} characters or fewer`)
      }
      const id = lookups.categoryIdByPath.get(buildProductCategoryPathNormalized(segments))
      if (!id) return bad(`${column.key}: category "${raw}" does not exist (a bulk edit does not create categories)`)
      return { ok: true, value: id, display: lookups.categoryPathById.get(id) ?? raw }
    }
  }
}

function currentValue(product: RoundTripProduct, column: ProductCsvColumn): string | boolean | null {
  return (product as unknown as Record<string, string | boolean | null>)[column.field] ?? null
}

/** How a stored value reads in the preview and in the downloaded file. */
export function displayCurrentValue(product: RoundTripProduct, column: ProductCsvColumn, lookups: Pick<PlanLookups, 'supplierNameById' | 'categoryPathById'>): string {
  const value = currentValue(product, column)
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (column.kind === 'supplier') return lookups.supplierNameById.get(value) ?? ''
  if (column.kind === 'category') return lookups.categoryPathById.get(value) ?? ''
  if (column.kind === 'decimal') return new Prisma.Decimal(value).toFixed(column.decimal!.scale)
  return value
}

function sameValue(column: ProductCsvColumn, current: string | boolean | null, next: string | boolean | null): boolean {
  if (current === null || next === null) return current === next
  if (column.kind === 'decimal') return new Prisma.Decimal(current as string).eq(new Prisma.Decimal(next as string))
  return current === next
}

export type PlanChunkInput = {
  /** The 1-based data row number, for messages (the header is row 1, so the first product is row 2). */
  rows: ReadonlyArray<{ line: number; cells: Record<string, string> }>
  columns: readonly ProductCsvColumn[]
  headerByColumn: ReadonlyMap<string, string>
  skuHeader: string
  productsBySku: ReadonlyMap<string, RoundTripProduct>
  lookups: PlanLookups
  state: PlanFileState
}

/** The cells of one file row that this plan reads: stripped of the exporter's formula guard, never undefined. */
function cell(cells: Record<string, string>, header: string): string {
  return stripCsvFormulaGuard((cells[header] ?? '').trim())
}

export function planProductCsvChunk(input: PlanChunkInput): RowOutcome[] {
  const outcomes: RowOutcome[] = []
  for (const { line, cells } of input.rows) {
    const sku = cell(cells, input.skuHeader)
    if (!sku) { outcomes.push({ kind: 'error', line, sku: '', message: `Row ${line}: missing sku` }); continue }
    const firstLine = input.state.seenSkus.get(sku)
    if (firstLine !== undefined) {
      outcomes.push({ kind: 'error', line, sku, message: `Row ${line} (${sku}): this SKU already appears on row ${firstLine}; each product may appear once` })
      continue
    }
    input.state.seenSkus.set(sku, line)
    const product = input.productsBySku.get(sku)
    if (!product) {
      outcomes.push({ kind: 'error', line, sku, message: `Row ${line} (${sku}): SKU not found. Edit by CSV only updates existing products; it does not create them` })
      continue
    }

    const changes: FieldChange[] = []
    const problems: string[] = []
    const claimedBarcodes: Array<[string, string]> = []
    for (const column of input.columns) {
      const raw = cell(cells, input.headerByColumn.get(column.key)!)
      if (raw === '') continue // blank: leave unchanged. Never a clear.
      const before = currentValue(product, column)
      let next: string | boolean | null
      let display: string
      if (raw === CSV_CLEAR_TOKEN) {
        if (!column.nullable) { problems.push(`${column.key} cannot be cleared (it is required)`); continue }
        if (column.kind === 'country' && blocksClearingInvalidOrigin(before as string | null, null)) {
          problems.push(`${column.key}: this product has an invalid stored country of origin; supply a valid country instead of clearing it`)
          continue
        }
        next = null
        display = ''
      } else {
        const parsed = parseValue(column, raw, input.lookups)
        if (!parsed.ok) { problems.push(parsed.message); continue }
        next = parsed.value
        display = parsed.display
      }
      if (sameValue(column, before, next)) continue
      if (column.key === 'barcode' && typeof next === 'string') {
        const owner = input.lookups.barcodeOwners.get(next)
        if (owner && owner !== product.id) { problems.push(`barcode "${next}" is already in use by another product`); continue }
        claimedBarcodes.push([next, sku])
      }
      changes.push({
        column: column.key,
        label: column.label,
        field: column.field,
        from: displayCurrentValue(product, column, input.lookups),
        to: display,
        value: next,
      })
    }
    for (const [barcode, owner] of claimedBarcodes) {
      const earlier = input.state.seenBarcodes.get(barcode)
      if (earlier !== undefined && earlier !== owner) problems.push(`barcode "${barcode}" is also given to ${earlier} in this file`)
    }
    if (problems.length > 0) {
      outcomes.push({ kind: 'error', line, sku, message: `Row ${line} (${sku}): ${problems.join('; ')}. Nothing was changed for this product` })
      continue
    }
    for (const [barcode, owner] of claimedBarcodes) input.state.seenBarcodes.set(barcode, owner)
    outcomes.push(changes.length === 0 ? { kind: 'unchanged', line, sku } : { kind: 'change', line, sku, product, changes })
  }
  return outcomes
}
