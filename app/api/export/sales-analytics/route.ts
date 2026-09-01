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

export type SalesAnalyticsExportType = 'sales' | 'customers' | 'margin' | 'returns' | 'fulfillment' | 'throughput'

/**
 * o3d-iigc round 5. A FILE READER HAS NO TOOLTIP — the rule round 3 set when it renamed a column
 * rather than relying on a header hint. Three of these six CSVs carry revenue/profit/margin
 * figures that never see a refund, and one carries credit values whose basis varies row by row.
 * `csvResponse` turns this metadata into `#` comment rows at the foot of the file (skipped by
 * parseCsv, so re-import is unaffected) plus the X-IMS-Export-Metadata header, which is this
 * repo's existing channel for saying something about a file inside the file.
 */
type SalesAnalyticsExportSpec = {
  filename: string
  columns: string[]
  refundTreatment?: string
}

export const SALES_ANALYTICS_EXPORTS: Record<SalesAnalyticsExportType, SalesAnalyticsExportSpec> = {
  sales: {
    filename: 'sales-analytics',
    columns: ['key', 'label', 'groupBy', 'currency', 'orderCount', 'lineCount', 'revenue', 'netRevenue', 'netRevenueBound', 'tax', 'shipping', 'discount', 'refundsGrossBasis', 'refundsNetBasis', 'refundsUnknownBasis'],
    refundTreatment: REFUND_BASIS_NOTICE_SALES,
  },
  customers: {
    filename: 'customer-mix',
    columns: ['customerId', 'customerName', 'customerEmail', 'orderCount', 'revenueBase', 'netRevenueBase', 'netRevenueBaseBound', 'netRevenueExVatBase', 'netRevenueExVatBaseBound', 'grossProfitBase', 'grossProfitBaseBound', 'costCaptured', 'costEvidence', 'arExposureBase', 'arExposureBaseBound', 'shareOfRevenuePct', 'shareOfRevenuePctBound', 'refundsNetBasis', 'refundsGrossBasis', 'refundsUnknownBasis'],
    refundTreatment: REFUND_BASIS_NOTICE_CUSTOMER_MIX,
  },
  margin: {
    filename: 'gross-margin',
    columns: ['productId', 'sku', 'productName', 'categoryName', 'lineCount', 'revenueBase', 'revenueBaseBound', 'cogsBase', 'grossProfitBase', 'grossProfitBaseBound', 'marginPct', 'marginPctBound', 'contributionPct', 'contributionPctBound', 'refundsNetBasis', 'refundsGrossBasis', 'refundsUnknownBasis'],
    refundTreatment: REFUND_BASIS_NOTICE_GROSS_MARGIN,
  },
  returns: {
    filename: 'returns',
    // o3d-iigc round 5: refundValueBase is null where the row mixes bases, so the basis and the
    // three per-basis buckets travel WITH it. A bare blank in a file is not an explanation.
    columns: ['productId', 'sku', 'productName', 'customerName', 'reason', 'refundCount', 'returnedQty', 'refundValueBase', 'refundValueBasis', 'refundValueNetBasis', 'refundValueGrossBasis', 'refundValueUnknownBasis', 'shippedQty', 'returnRatePct'],
    refundTreatment: RETURNS_MIXED_BASIS_NOTICE,
  },
  fulfillment: {
    filename: 'fulfillment-kpis',
    columns: ['metric', 'value', 'numerator', 'denominator'],
  },
  throughput: {
    filename: 'throughput',
    columns: ['date', 'userName', 'orderCount', 'shipmentCount', 'lineCount'],
  },
}

/**
 * o3d-kyey. EVERY DISCLOSURE THE PRODUCER EMITS REACHES THE FILE.
 *
 * A CSV of `report.rows` carries only what reached a row. A producer's REPORT-LEVEL figures — the
 * Gross Margin credit that reached no product row at all, the bounds on the period totals, Customer
 * Mix's count of the customers its profit total actually covers — exist nowhere in `rows`, so an
 * export built from rows alone drops them silently. That is worse than never having published them:
 * the page marks the total bounded and warns about off-report credit, while the file the operator
 * takes away shows exact revenue on every row and nothing to say otherwise, and a file is read as
 * the whole picture.
 *
 * So the producer's WHOLE `totals` map travels as export metadata, one `totals.<key>` comment row
 * each, by iteration rather than by a hand-kept list. A totals key added tomorrow ships tomorrow —
 * the property the parity test asserts structurally, and the reason it is not a column list.
 */
function exportMetadata(
  spec: SalesAnalyticsExportSpec,
  filters: SalesAnalyticsFilters,
  totals: Record<string, string>,
): Record<string, unknown> {
  return {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    groupBy: filters.groupBy,
    ...(spec.refundTreatment ? { refundTreatment: spec.refundTreatment } : {}),
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [`totals.${key}`, value])),
  }
}

/** The serialiser both the route and its parity test go through, so neither can test a copy. */
export function salesAnalyticsCsvResponse(
  reportType: SalesAnalyticsExportType,
  report: { rows: Record<string, unknown>[]; totals: Record<string, string> },
  filters: SalesAnalyticsFilters,
  date: string,
): Response {
  const spec = SALES_ANALYTICS_EXPORTS[reportType]
  return csvResponse(
    toCsv(report.rows, spec.columns),
    `${spec.filename}-${date}.csv`,
    exportMetadata(spec, filters, report.totals),
  )
}

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

  const wideFilters = { ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }

  try {
    switch (reportType) {
    case 'sales': {
      const report = await getSalesAnalyticsReport(wideFilters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return salesAnalyticsCsvResponse('sales', report, filters, date)
    }
    case 'customers': {
      const report = await getCustomerAnalyticsReport(wideFilters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return salesAnalyticsCsvResponse('customers', report, filters, date)
    }
    case 'margin': {
      const report = await getMarginAnalyticsReport(wideFilters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return salesAnalyticsCsvResponse('margin', report, filters, date)
    }
    case 'returns': {
      const report = await getReturnsAnalyticsReport(wideFilters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return salesAnalyticsCsvResponse('returns', report, filters, date)
    }
    case 'fulfillment': {
      const report = await getFulfillmentAnalyticsReport(filters)
      return salesAnalyticsCsvResponse('fulfillment', report, filters, date)
    }
    case 'throughput': {
      const report = await getThroughputAnalyticsReport(wideFilters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return salesAnalyticsCsvResponse('throughput', report, filters, date)
    }
    default:
      return NextResponse.json({ error: 'Unknown sales analytics export type' }, { status: 400 })
    }
  } catch (error) {
    if (isSourceScanTooLargeError(error)) return NextResponse.json({ error: error.message }, { status: 413 })
    throw error
  }
}
