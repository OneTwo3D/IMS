import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvResponse, toCsv } from '@/lib/csv'
import {
  getApAgingReport,
  getArAgingReport,
  getCurrencySummaryReport,
  getFxGainLossReport,
  getVatReport,
  type FinanceAnalyticsFilters,
} from '@/lib/domain/finance/finance-period-analytics'
import { canAccessFinanceAnalytics } from '@/lib/security/finance-analytics-access'

const FINANCE_ANALYTICS_CSV_ROW_LIMIT = 50000

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function filtersFromRequest(req: NextRequest): FinanceAnalyticsFilters {
  return {
    dateFrom: one(req, 'dateFrom'),
    dateTo: one(req, 'dateTo'),
    pageSize: positiveInteger(one(req, 'pageSize')) ?? 100,
    bucket1Days: positiveInteger(one(req, 'bucket1Days')),
    bucket2Days: positiveInteger(one(req, 'bucket2Days')),
    bucket3Days: positiveInteger(one(req, 'bucket3Days')),
  }
}

function rejectOversizedExport(totalRows: number): NextResponse | null {
  return totalRows > FINANCE_ANALYTICS_CSV_ROW_LIMIT
    ? NextResponse.json(
      { error: `Finance analytics CSV exports are capped at ${FINANCE_ANALYTICS_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
    : null
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!canAccessFinanceAnalytics(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const filters = filtersFromRequest(req)
  const reportType = req.nextUrl.searchParams.get('report') ?? 'vat'
  const date = new Date().toISOString().slice(0, 10)

  switch (reportType) {
    case 'vat': {
      const report = await getVatReport({ ...filters, pageSize: FINANCE_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['side', 'jurisdiction', 'taxRateName', 'accountingTaxType', 'ratePct', 'lineCount', 'taxableBase', 'taxBase']), `vat-${date}.csv`)
    }
    case 'ar-aging': {
      const report = await getArAgingReport({ ...filters, pageSize: FINANCE_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['partyName', 'contact', 'documentCount', 'current', 'bucket1', 'bucket2', 'bucket3', 'bucket4', 'outstandingBase', 'lastPaymentDate']), `ar-aging-${date}.csv`)
    }
    case 'ap-aging': {
      const report = await getApAgingReport({ ...filters, pageSize: FINANCE_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['partyName', 'contact', 'documentCount', 'current', 'bucket1', 'bucket2', 'bucket3', 'bucket4', 'outstandingBase', 'lastPaymentDate']), `ap-aging-${date}.csv`)
    }
    case 'currency-summary': {
      const report = await getCurrencySummaryReport({ ...filters, pageSize: FINANCE_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['currency', 'salesDocumentCount', 'salesForeign', 'salesBase', 'arOutstandingForeign', 'arOutstandingBase', 'purchaseDocumentCount', 'purchasesForeign', 'purchasesBase', 'apOutstandingForeign', 'apOutstandingBase']), `currency-summary-${date}.csv`)
    }
    case 'fx-gain-loss': {
      const report = await getFxGainLossReport({ ...filters, pageSize: FINANCE_ANALYTICS_CSV_ROW_LIMIT }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      return csvResponse(toCsv(report.rows, ['side', 'settlementId', 'documentId', 'reference', 'partyName', 'currency', 'paidAt', 'amountForeign', 'bookedRateToBase', 'settlementRateToBase', 'bookedBase', 'settlementBase', 'gainLossBase', 'outcome', 'controlAccount', 'fxGainLossAccount']), `fx-gain-loss-${date}.csv`)
    }
    default:
      return NextResponse.json({ error: 'Unknown finance analytics export type' }, { status: 400 })
  }
}
