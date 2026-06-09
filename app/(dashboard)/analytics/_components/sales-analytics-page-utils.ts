import {
  emptySalesAnalyticsReportForSourceLimit,
  getCustomerAnalyticsReport,
  getFulfillmentAnalyticsReport,
  getMarginAnalyticsReport,
  getReturnsAnalyticsReport,
  getSalesAnalyticsReport,
  getThroughputAnalyticsReport,
  type SalesAnalyticsFilters,
  type SalesAnalyticsGroupBy,
  type SalesAnalyticsReport,
  type SalesCurrencyMode,
} from '@/lib/domain/sales/sales-fulfillment-analytics'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'
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

export const salesAnalyticsEmptyTotals = {
  sales: { revenue: '0', tax: '0', shipping: '0', discount: '0' },
  customers: { revenueBase: '0', grossProfitBase: '0', arExposureBase: '0' },
  margin: { revenueBase: '0', cogsBase: '0', grossProfitBase: '0', marginPct: '0' },
  returns: { refundValueBase: '0', returnedQty: '0' },
  fulfillment: { shippedOrders: '0', shippedQty: '0' },
  throughput: { orders: '0', shipments: '0', lines: '0', queueDepth: '0' },
} as const satisfies Record<string, Record<string, string>>

async function loadSalesAnalyticsReportForPage<Row>(
  filters: SalesAnalyticsFilters,
  load: (filters: SalesAnalyticsFilters) => Promise<SalesAnalyticsReport<Row>>,
  emptyTotals: Record<string, string>,
): Promise<SalesAnalyticsReport<Row>> {
  try {
    return await load(filters)
  } catch (error) {
    if (isSourceScanTooLargeError(error)) return emptySalesAnalyticsReportForSourceLimit<Row>(filters, error, emptyTotals)
    throw error
  }
}

export function loadSalesReportForPage(filters: SalesAnalyticsFilters, load = getSalesAnalyticsReport) {
  return loadSalesAnalyticsReportForPage(filters, load, salesAnalyticsEmptyTotals.sales)
}

export function loadCustomerAnalyticsReportForPage(filters: SalesAnalyticsFilters, load = getCustomerAnalyticsReport) {
  return loadSalesAnalyticsReportForPage(filters, load, salesAnalyticsEmptyTotals.customers)
}

export function loadMarginAnalyticsReportForPage(filters: SalesAnalyticsFilters, load = getMarginAnalyticsReport) {
  return loadSalesAnalyticsReportForPage(filters, load, salesAnalyticsEmptyTotals.margin)
}

export function loadReturnsAnalyticsReportForPage(filters: SalesAnalyticsFilters, load = getReturnsAnalyticsReport) {
  return loadSalesAnalyticsReportForPage(filters, load, salesAnalyticsEmptyTotals.returns)
}

export function loadFulfillmentAnalyticsReportForPage(filters: SalesAnalyticsFilters, load = getFulfillmentAnalyticsReport) {
  return loadSalesAnalyticsReportForPage(filters, load, salesAnalyticsEmptyTotals.fulfillment)
}

export function loadThroughputAnalyticsReportForPage(filters: SalesAnalyticsFilters, load = getThroughputAnalyticsReport) {
  return loadSalesAnalyticsReportForPage(filters, load, salesAnalyticsEmptyTotals.throughput)
}
