import type { FinanceAnalyticsFilters } from '@/lib/domain/finance/finance-period-analytics'
import type { FinanceAnalyticsFilterValues } from './finance-analytics-report'

export type FinanceAnalyticsSearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function financeAnalyticsFiltersFromSearch(searchParams: FinanceAnalyticsSearchParams): FinanceAnalyticsFilters {
  return {
    dateFrom: one(searchParams.dateFrom),
    dateTo: one(searchParams.dateTo),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: positiveInteger(one(searchParams.pageSize)) ?? 100,
    bucket1Days: positiveInteger(one(searchParams.bucket1Days)),
    bucket2Days: positiveInteger(one(searchParams.bucket2Days)),
    bucket3Days: positiveInteger(one(searchParams.bucket3Days)),
  }
}

export function financeAnalyticsFiltersForUi(filters: FinanceAnalyticsFilters): FinanceAnalyticsFilterValues {
  return {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    pageSize: String(filters.pageSize ?? 100),
    bucket1Days: String(filters.bucket1Days ?? 30),
    bucket2Days: String(filters.bucket2Days ?? 60),
    bucket3Days: String(filters.bucket3Days ?? 90),
  }
}
