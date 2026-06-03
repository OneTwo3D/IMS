import type { PurchasingAnalyticsFilters } from '@/lib/domain/purchasing/purchasing-analytics'
import type { PurchasingAnalyticsFilterValues } from './purchasing-analytics-report'

export type PurchasingAnalyticsSearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function purchasingAnalyticsFiltersFromSearch(searchParams: PurchasingAnalyticsSearchParams): PurchasingAnalyticsFilters {
  return {
    dateFrom: one(searchParams.dateFrom),
    dateTo: one(searchParams.dateTo),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: positiveInteger(one(searchParams.pageSize)) ?? 100,
  }
}

export function purchasingAnalyticsFiltersForUi(filters: PurchasingAnalyticsFilters): PurchasingAnalyticsFilterValues {
  return {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    pageSize: String(filters.pageSize ?? 100),
  }
}
