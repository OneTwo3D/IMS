import { toCsv } from '@/lib/csv'
import { PRODUCT_CSV_KEY_COLUMN, PRODUCT_CSV_REV_COLUMN, type ProductCsvColumn } from '@/lib/products/csv-roundtrip/columns'
import { buildRevToken, displayCurrentValue, type PlanLookups, type RoundTripProduct } from '@/lib/products/csv-roundtrip/plan'

/** The header row: SKU first, then the chosen columns in registry order, then `rev` (the download's version token). */
export function productCsvHeaders(columns: readonly ProductCsvColumn[]): string[] {
  return [PRODUCT_CSV_KEY_COLUMN, ...columns.map((column) => column.key), PRODUCT_CSV_REV_COLUMN]
}

/**
 * The pre-filled file for a selection: one row per product, every chosen column holding the product's current value, so
 * that an untouched row re-uploads as "no change". A field that is empty today is exported empty, which on the way back
 * reads as "leave unchanged". The trailing `rev` column records what each value was, so that on upload only cells the
 * operator actually edited are applied, and an edit to a field that has since changed in IMS is refused.
 */
export function buildProductCsvTemplate(
  products: readonly RoundTripProduct[],
  columns: readonly ProductCsvColumn[],
  lookups: Pick<PlanLookups, 'supplierNameById' | 'categoryPathById'>,
): string {
  const headers = productCsvHeaders(columns)
  const rows = products.map((product) => {
    const row: Record<string, unknown> = { [PRODUCT_CSV_KEY_COLUMN]: product.sku }
    for (const column of columns) row[column.key] = displayCurrentValue(product, column, lookups)
    row[PRODUCT_CSV_REV_COLUMN] = buildRevToken(product, columns, lookups)
    return row
  })
  return toCsv(rows, headers)
}
