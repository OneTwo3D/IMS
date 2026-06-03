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
import { canAccessSalesAnalytics } from '@/lib/security/sales-analytics-access'

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

  switch (reportType) {
    case 'sales': {
      const report = await getSalesAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['key', 'label', 'groupBy', 'currency', 'orderCount', 'lineCount', 'revenue', 'tax', 'shipping', 'discount']), `sales-analytics-${date}.csv`)
    }
    case 'customers': {
      const report = await getCustomerAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['customerId', 'customerName', 'customerEmail', 'orderCount', 'revenueBase', 'grossProfitBase', 'arExposureBase', 'shareOfRevenuePct']), `customer-mix-${date}.csv`)
    }
    case 'margin': {
      const report = await getMarginAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['productId', 'sku', 'productName', 'categoryName', 'lineCount', 'revenueBase', 'cogsBase', 'grossProfitBase', 'marginPct', 'contributionPct']), `gross-margin-${date}.csv`)
    }
    case 'returns': {
      const report = await getReturnsAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['productId', 'sku', 'productName', 'customerName', 'reason', 'refundCount', 'returnedQty', 'refundValueBase', 'shippedQty', 'returnRatePct']), `returns-${date}.csv`)
    }
    case 'fulfillment': {
      const report = await getFulfillmentAnalyticsReport(filters)
      return csvResponse(toCsv(report.rows, ['metric', 'value', 'numerator', 'denominator']), `fulfillment-kpis-${date}.csv`)
    }
    case 'throughput': {
      const report = await getThroughputAnalyticsReport({ ...filters, pageSize: SALES_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['date', 'userName', 'orderCount', 'shipmentCount', 'lineCount', 'queueDepth']), `throughput-${date}.csv`)
    }
    default:
      return NextResponse.json({ error: 'Unknown sales analytics export type' }, { status: 400 })
  }
}
