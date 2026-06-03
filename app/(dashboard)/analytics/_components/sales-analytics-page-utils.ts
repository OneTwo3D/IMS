import type { SalesAnalyticsFilters, SalesAnalyticsGroupBy, SalesCurrencyMode } from '@/lib/domain/sales/sales-fulfillment-analytics'
import type { SalesAnalyticsFilterValues } from './sales-analytics-report'

export type SalesAnalyticsSearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function groupBy(value: string | undefined): SalesAnalyticsGroupBy | undefined {
  return value === 'product' || value === 'category' || value === 'customer' || value === 'channel' ? value : undefined
}

function currencyMode(value: string | undefined): SalesCurrencyMode | undefined {
  return value === 'foreign' ? 'foreign' : value === 'base' ? 'base' : undefined
}

export function salesAnalyticsFiltersFromSearch(searchParams: SalesAnalyticsSearchParams): SalesAnalyticsFilters {
  return {
    dateFrom: one(searchParams.dateFrom),
    dateTo: one(searchParams.dateTo),
    groupBy: groupBy(one(searchParams.groupBy)),
    currencyMode: currencyMode(one(searchParams.currencyMode)),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: positiveInteger(one(searchParams.pageSize)) ?? 100,
  }
}

export function salesAnalyticsFiltersForUi(filters: SalesAnalyticsFilters): SalesAnalyticsFilterValues {
  return {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    groupBy: filters.groupBy,
    currencyMode: filters.currencyMode,
    pageSize: String(filters.pageSize ?? 100),
  }
}
