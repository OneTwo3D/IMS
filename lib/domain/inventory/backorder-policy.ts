import type { ProductType } from '@/app/generated/prisma/client'

export type BackorderProductType = ProductType

// KIT included: backorder coverage is evaluated against the parent sales line,
// even though KITs have no FIFO layers of their own.
export const STOCK_TRACKED_PRODUCT_TYPES: ReadonlySet<BackorderProductType> = new Set([
  'SIMPLE',
  'VARIANT',
  'KIT',
  'BOM',
])

export function isStockTrackedProductType(
  type: BackorderProductType | null | undefined,
): type is BackorderProductType {
  return Boolean(type && STOCK_TRACKED_PRODUCT_TYPES.has(type))
}
