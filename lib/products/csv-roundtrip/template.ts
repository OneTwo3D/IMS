import { toCsv } from '@/lib/csv'
import { PRODUCT_CSV_KEY_COLUMN, type ProductCsvColumn } from '@/lib/products/csv-roundtrip/columns'
import { displayCurrentValue, type PlanLookups, type RoundTripProduct } from '@/lib/products/csv-roundtrip/plan'

/** The header row: SKU first, then the chosen columns in registry order. */
export function productCsvHeaders(columns: readonly ProductCsvColumn[]): string[] {
  return [PRODUCT_CSV_KEY_COLUMN, ...columns.map((column) => column.key)]
}

/**
 * The pre-filled file for a selection: one row per product, every chosen column holding the product's current value, so
 * that an untouched row re-uploads as "no change". A field that is empty today is exported empty, which on the way back
 * reads as "leave unchanged".
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
    return row
  })
  return toCsv(rows, headers)
}
