import {
  emptyFinanceAnalyticsReportForSourceLimit,
  FINANCE_ANALYTICS_EMPTY_TOTALS,
  getApAgingReport,
  getArAgingReport,
  getCurrencySummaryReport,
  getFxGainLossReport,
  getVatReport,
  type FinanceAnalyticsFilters,
  type FinanceAnalyticsReport,
} from '@/lib/domain/finance/finance-period-analytics'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'
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

export const financeAnalyticsEmptyTotals = FINANCE_ANALYTICS_EMPTY_TOTALS

async function loadFinanceAnalyticsReportForPage<Row, Totals extends Record<string, string>>(
  filters: FinanceAnalyticsFilters,
  load: (filters: FinanceAnalyticsFilters) => Promise<FinanceAnalyticsReport<Row, Totals>>,
  emptyTotals: Totals,
): Promise<FinanceAnalyticsReport<Row, Totals>> {
  try {
    return await load(filters)
  } catch (error) {
    if (isSourceScanTooLargeError(error)) return emptyFinanceAnalyticsReportForSourceLimit(filters, error, emptyTotals)
    throw error
  }
}

export function loadVatReportForPage(filters: FinanceAnalyticsFilters, load = getVatReport) {
  return loadFinanceAnalyticsReportForPage(filters, load, financeAnalyticsEmptyTotals.vat)
}

export function loadArAgingReportForPage(filters: FinanceAnalyticsFilters, load = getArAgingReport) {
  return loadFinanceAnalyticsReportForPage(filters, load, financeAnalyticsEmptyTotals.arAging)
}

export function loadApAgingReportForPage(filters: FinanceAnalyticsFilters, load = getApAgingReport) {
  return loadFinanceAnalyticsReportForPage(filters, load, financeAnalyticsEmptyTotals.apAging)
}

export function loadCurrencySummaryReportForPage(filters: FinanceAnalyticsFilters, load = getCurrencySummaryReport) {
  return loadFinanceAnalyticsReportForPage(filters, load, financeAnalyticsEmptyTotals.currencySummary)
}

export function loadFxGainLossReportForPage(filters: FinanceAnalyticsFilters, load = getFxGainLossReport) {
  return loadFinanceAnalyticsReportForPage(filters, load, financeAnalyticsEmptyTotals.fxGainLoss)
}
