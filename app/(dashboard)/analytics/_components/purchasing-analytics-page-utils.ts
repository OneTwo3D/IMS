import {
  emptyPurchasingAnalyticsReportForSourceLimit,
  getLeadTimeReport,
  getOpenPurchaseOrdersReport,
  getPurchasePriceVarianceReport,
  getSpendReport,
  getSupplierPerformanceReport,
  type PurchasingAnalyticsFilters,
  type PurchasingAnalyticsReport,
} from '@/lib/domain/purchasing/purchasing-analytics'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'
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

export const purchasingAnalyticsEmptyTotals = {
  openPurchaseOrders: { outstandingValueBase: '0', outstandingQty: '0', overdue: '0' },
  supplierPerformance: { supplierCount: '0', receipts: '0' },
  purchasePriceVariance: { varianceTotalBase: '0', rowCount: '0' },
  spend: { spendBase: '0', poCount: '0' },
  leadTime: { supplierSkuPairs: '0', maxP95LeadTimeDays: '0' },
} as const satisfies Record<string, Record<string, string>>

async function loadPurchasingAnalyticsReportForPage<Row>(
  filters: PurchasingAnalyticsFilters,
  load: (filters: PurchasingAnalyticsFilters) => Promise<PurchasingAnalyticsReport<Row>>,
  emptyTotals: Record<string, string>,
): Promise<PurchasingAnalyticsReport<Row>> {
  try {
    return await load(filters)
  } catch (error) {
    if (isSourceScanTooLargeError(error)) return emptyPurchasingAnalyticsReportForSourceLimit<Row>(filters, error, emptyTotals)
    throw error
  }
}

export function loadOpenPurchaseOrdersReportForPage(filters: PurchasingAnalyticsFilters, load = getOpenPurchaseOrdersReport) {
  return loadPurchasingAnalyticsReportForPage(filters, load, purchasingAnalyticsEmptyTotals.openPurchaseOrders)
}

export function loadSupplierPerformanceReportForPage(filters: PurchasingAnalyticsFilters, load = getSupplierPerformanceReport) {
  return loadPurchasingAnalyticsReportForPage(filters, load, purchasingAnalyticsEmptyTotals.supplierPerformance)
}

export function loadPurchasePriceVarianceReportForPage(filters: PurchasingAnalyticsFilters, load = getPurchasePriceVarianceReport) {
  return loadPurchasingAnalyticsReportForPage(filters, load, purchasingAnalyticsEmptyTotals.purchasePriceVariance)
}

export function loadSpendReportForPage(filters: PurchasingAnalyticsFilters, load = getSpendReport) {
  return loadPurchasingAnalyticsReportForPage(filters, load, purchasingAnalyticsEmptyTotals.spend)
}

export function loadLeadTimeReportForPage(filters: PurchasingAnalyticsFilters, load = getLeadTimeReport) {
  return loadPurchasingAnalyticsReportForPage(filters, load, purchasingAnalyticsEmptyTotals.leadTime)
}
