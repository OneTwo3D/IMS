import type { ProductType } from '@/app/generated/prisma/client'
import type { ReorderDemandChartFilters } from '@/lib/domain/inventory/reorder-demand-chart'

export type ChartSearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** The Reorder Planning filters that shape one product's figures; the rest of the list filters are not carried. */
export function chartFiltersFromSearch(searchParams: ChartSearchParams): ReorderDemandChartFilters {
  return {
    warehouseId: one(searchParams.warehouseId) || undefined,
    categoryId: one(searchParams.categoryId) || undefined,
    supplierId: one(searchParams.supplierId) || undefined,
    productType: (one(searchParams.productType) || undefined) as ProductType | undefined,
    thresholdDays: positiveInteger(one(searchParams.thresholdDays)),
    targetCoverWeeks: positiveInteger(one(searchParams.targetCoverWeeks)),
    ...(one(searchParams.ignoreStockouts) === '1' ? { ignoreStockouts: true } : {}),
  }
}

/** URL overrides for the two chart windows. */
export function chartWindowsFromSearch(searchParams: ChartSearchParams): { historyWeeks?: number; forecastWeeks?: number } {
  return {
    historyWeeks: positiveInteger(one(searchParams.historyWeeks)),
    forecastWeeks: positiveInteger(one(searchParams.forecastWeeks)),
  }
}
