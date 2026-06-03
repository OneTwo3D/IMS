import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvResponse, toCsv } from '@/lib/csv'
import {
  getLeadTimeReport,
  getOpenPurchaseOrdersReport,
  getPurchasePriceVarianceReport,
  getSpendReport,
  getSupplierPerformanceReport,
  type PurchasingAnalyticsFilters,
} from '@/lib/domain/purchasing/purchasing-analytics'
import { canAccessPurchasingAnalytics } from '@/lib/security/purchasing-analytics-access'

const PURCHASING_ANALYTICS_CSV_ROW_LIMIT = 50000

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function filtersFromRequest(req: NextRequest): PurchasingAnalyticsFilters {
  return {
    dateFrom: one(req, 'dateFrom'),
    dateTo: one(req, 'dateTo'),
    pageSize: positiveInteger(one(req, 'pageSize')) ?? 100,
  }
}

function rejectOversizedExport(totalRows: number): NextResponse | null {
  return totalRows > PURCHASING_ANALYTICS_CSV_ROW_LIMIT
    ? NextResponse.json(
      { error: `Purchasing analytics CSV exports are capped at ${PURCHASING_ANALYTICS_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
    : null
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!canAccessPurchasingAnalytics(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const filters = filtersFromRequest(req)
  const reportType = req.nextUrl.searchParams.get('report') ?? 'open-pos'
  const date = new Date().toISOString().slice(0, 10)

  switch (reportType) {
    case 'open-pos': {
      const report = await getOpenPurchaseOrdersReport({ ...filters, pageSize: PURCHASING_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['reference', 'supplierName', 'status', 'poSentAt', 'expectedDelivery', 'overdue', 'daysSinceSent', 'outstandingQty', 'outstandingValueBase']), `open-pos-${date}.csv`)
    }
    case 'supplier-performance': {
      const report = await getSupplierPerformanceReport({ ...filters, pageSize: PURCHASING_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['supplierName', 'receiptCount', 'onTimeReceiptCount', 'expectedReceiptCount', 'onTimeRatePct', 'orderedQty', 'receivedQty', 'qtyVariance', 'qtyVariancePct', 'returnedQty', 'returnRatePct', 'averageActualLeadTimeDays', 'averageConfiguredLeadTimeDays', 'averageRfqResponseDays']), `supplier-performance-${date}.csv`)
    }
    case 'ppv': {
      const report = await getPurchasePriceVarianceReport({ ...filters, pageSize: PURCHASING_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['supplierName', 'sku', 'productName', 'categoryName', 'poReference', 'receivedAt', 'qty', 'actualLandedUnitCostBase', 'referenceUnitCostBase', 'variancePerUnitBase', 'varianceTotalBase', 'variancePct', 'referencePriceSource']), `ppv-${date}.csv`)
    }
    case 'spend': {
      const report = await getSpendReport({ ...filters, pageSize: PURCHASING_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['period', 'supplierName', 'categoryName', 'poCount', 'spendBase']), `spend-${date}.csv`)
    }
    case 'lead-times': {
      const report = await getLeadTimeReport({ ...filters, pageSize: PURCHASING_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['supplierName', 'sku', 'productName', 'receiptCount', 'averageLeadTimeDays', 'p50LeadTimeDays', 'p95LeadTimeDays', 'configuredLeadTimeDays', 'latestReceiptAt']), `lead-times-${date}.csv`)
    }
    default:
      return NextResponse.json({ error: 'Unknown purchasing analytics export type' }, { status: 400 })
  }
}
