import type { Permission } from '@/lib/permissions'

/**
 * The price columns of the legacy product export (/api/export/products). Same set the Edit-by-CSV
 * columns guard with `inventory.prices`.
 */
export const LEGACY_EXPORT_PRICE_COLUMNS = ['salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive'] as const

/**
 * Without `inventory.prices` the price columns keep their place in the header (so the column contract
 * and the first-load / e2e header pins hold) but every cell is blank.
 */
export function gateLegacyExportPrices<T extends Record<string, unknown>>(
  rows: T[],
  can: (permission: Permission) => boolean,
): T[] {
  if (can('inventory.prices')) return rows
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row }
    for (const column of LEGACY_EXPORT_PRICE_COLUMNS) copy[column] = ''
    return copy as T
  })
}
