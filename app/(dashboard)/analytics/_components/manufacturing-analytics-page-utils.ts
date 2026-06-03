import type { ManufacturingAnalyticsFilters } from '@/lib/domain/manufacturing/manufacturing-analytics'
import type { ManufacturingAnalyticsFilterValues } from './manufacturing-analytics-report'

export type ManufacturingAnalyticsSearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function manufacturingAnalyticsFiltersFromSearch(searchParams: ManufacturingAnalyticsSearchParams): ManufacturingAnalyticsFilters {
  return {
    dateFrom: one(searchParams.dateFrom),
    dateTo: one(searchParams.dateTo),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: positiveInteger(one(searchParams.pageSize)) ?? 100,
  }
}

export function manufacturingAnalyticsFiltersForUi(filters: ManufacturingAnalyticsFilters): ManufacturingAnalyticsFilterValues {
  return {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    pageSize: String(filters.pageSize ?? 100),
  }
}
