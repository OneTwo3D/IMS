import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvResponse, toCsv } from '@/lib/csv'
import {
  getCustomerAnalyticsReport,
  getFulfillmentAnalyticsReport,
  getMarginAnalyticsReport,
  getReturnsAnalyticsReport,
  getSalesAnalyticsReport,
  getThroughputAnalyticsReport,
  type SalesAnalyticsFilters,
  type SalesAnalyticsGroupBy,
  type SalesCurrencyMode,
} from '@/lib/domain/sales/sales-fulfillment-analytics'
import {
  REFUND_BASIS_NOTICE_CUSTOMER_MIX,
  REFUND_BASIS_NOTICE_GROSS_MARGIN,
  REFUND_BASIS_NOTICE_SALES,
  RETURNS_MIXED_BASIS_NOTICE,
} from '@/lib/analytics/refund-figure-surfaces'
import { canAccessSalesAnalytics } from '@/lib/security/sales-analytics-access'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'

const SALES_ANALYTICS_CSV_ROW_LIMIT = 50000

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
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

function filtersFromRequest(req: NextRequest): SalesAnalyticsFilters {
  return {
    dateFrom: one(req, 'dateFrom'),
    dateTo: one(req, 'dateTo'),
    groupBy: groupBy(one(req, 'groupBy')),
    currencyMode: currencyMode(one(req, 'currencyMode')),
    pageSize: positiveInteger(one(req, 'pageSize')) ?? 100,
  }
}

function rejectOversizedExport(totalRows: number): NextResponse | null {
  return totalRows > SALES_ANALYTICS_CSV_ROW_LIMIT
    ? NextResponse.json(
      { error: `Sales analytics CSV exports are capped at ${SALES_ANALYTICS_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
    : null
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!canAccessSalesAnalytics(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const filters = filtersFromRequest(req)
  const reportType = req.nextUrl.searchParams.get('report') ?? 'sales'
  const date = new Date().toISOString().slice(0, 10)

  /**
   * o3d-iigc round 5. A FILE READER HAS NO TOOLTIP — the rule round 3 set when it renamed a column
   * rather than relying on a header hint. Three of these six CSVs carry revenue/profit/margin
   * figures that never see a refund, and one carries credit values whose basis varies row by row.
   * `csvResponse` turns this metadata into `#` comment rows at the foot of the file (skipped by
   * parseCsv, so re-import is unaffected) plus the X-IMS-Export-Metadata header, which is this
   * repo's existing channel for saying something about a file inside the file.
   */
  const exportMetadata = (refundTreatment: string) => ({
    dateFrom: filters.dateFrom, dateTo: filters.dateTo, groupBy: filters.groupBy, refundTreatment,
  })

  try {
    switch (reportType) {
    case 'sales': {
      const report = await getSalesAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['key', 'label', 'groupBy', 'currency', 'orderCount', 'lineCount', 'revenue', 'netRevenue', 'netRevenueBound', 'tax', 'shipping', 'discount', 'refundsGrossBasis', 'refundsNetBasis', 'refundsUnknownBasis']), `sales-analytics-${date}.csv`, exportMetadata(REFUND_BASIS_NOTICE_SALES))
    }
    case 'customers': {
      const report = await getCustomerAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['customerId', 'customerName', 'customerEmail', 'orderCount', 'revenueBase', 'netRevenueBase', 'netRevenueBaseBound', 'netRevenueExVatBase', 'netRevenueExVatBaseBound', 'grossProfitBase', 'grossProfitBaseBound', 'costCaptured', 'arExposureBase', 'arExposureBaseBound', 'shareOfRevenuePct', 'shareOfRevenuePctBound', 'refundsNetBasis', 'refundsGrossBasis', 'refundsUnknownBasis']), `customer-mix-${date}.csv`, exportMetadata(REFUND_BASIS_NOTICE_CUSTOMER_MIX))
    }
    case 'margin': {
      const report = await getMarginAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['productId', 'sku', 'productName', 'categoryName', 'lineCount', 'revenueBase', 'revenueBaseBound', 'cogsBase', 'grossProfitBase', 'grossProfitBaseBound', 'marginPct', 'marginPctBound', 'contributionPct', 'contributionPctBound', 'refundsNetBasis', 'refundsGrossBasis', 'refundsUnknownBasis']), `gross-margin-${date}.csv`, exportMetadata(REFUND_BASIS_NOTICE_GROSS_MARGIN))
    }
    case 'returns': {
      const report = await getReturnsAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      // o3d-iigc round 5: refundValueBase is null where the row mixes bases, so the basis and the
      // three per-basis buckets travel WITH it. A bare blank in a file is not an explanation.
      return csvResponse(toCsv(report.rows, ['productId', 'sku', 'productName', 'customerName', 'reason', 'refundCount', 'returnedQty', 'refundValueBase', 'refundValueBasis', 'refundValueNetBasis', 'refundValueGrossBasis', 'refundValueUnknownBasis', 'shippedQty', 'returnRatePct']), `returns-${date}.csv`, exportMetadata(RETURNS_MIXED_BASIS_NOTICE))
    }
    case 'fulfillment': {
      const report = await getFulfillmentAnalyticsReport(filters)
      return csvResponse(toCsv(report.rows, ['metric', 'value', 'numerator', 'denominator']), `fulfillment-kpis-${date}.csv`)
    }
    case 'throughput': {
      const report = await getThroughputAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['date', 'userName', 'orderCount', 'shipmentCount', 'lineCount']), `throughput-${date}.csv`)
    }
    default:
      return NextResponse.json({ error: 'Unknown sales analytics export type' }, { status: 400 })
    }
  } catch (error) {
    if (isSourceScanTooLargeError(error)) return NextResponse.json({ error: error.message }, { status: 413 })
    throw error
  }
}
