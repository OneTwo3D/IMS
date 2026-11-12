import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvResponseWithNotices, toCsv, wantsCsvMetadataRows } from '@/lib/csv'
import {
  getProductionVarianceReport,
  getWipReport,
  ManufacturingAnalyticsSourceLimitError,
  type ManufacturingAnalyticsFilters,
} from '@/lib/domain/manufacturing/manufacturing-analytics'
import { canAccessManufacturingAnalytics } from '@/lib/security/manufacturing-analytics-access'
import { sourceLimitCsvResponse } from '@/lib/csv-source-limit'

const EXPORT_COLUMNS: Record<string, string[]> = {
  'production-variance': ['productionOrderReference', 'status', 'warehouseCode', 'outputSku', 'outputProductName', 'componentSku', 'componentName', 'plannedQty', 'actualQty', 'varianceQty', 'variancePct', 'overConsumedQty', 'overConsumedValueBase', 'orderYieldPct', 'outcome'],
  'wip': ['productionOrderReference', 'status', 'warehouseCode', 'outputSku', 'outputProductName', 'startedAt', 'scheduledAt', 'daysSinceStart', 'plannedOutputQty', 'producedQty', 'remainingOutputQty', 'manufacturingCostBase', 'consumedComponentValueBase', 'reservedComponentValueBase', 'expectedOutputValueBase', 'wipValueBase', 'costLineCount'],
}

const MANUFACTURING_ANALYTICS_CSV_ROW_LIMIT = 50000

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function filtersFromRequest(req: NextRequest): ManufacturingAnalyticsFilters {
  return {
    dateFrom: one(req, 'dateFrom'),
    dateTo: one(req, 'dateTo'),
    pageSize: positiveInteger(one(req, 'pageSize')) ?? 100,
  }
}

function rejectOversizedExport(totalRows: number): NextResponse | null {
  return totalRows > MANUFACTURING_ANALYTICS_CSV_ROW_LIMIT
    ? NextResponse.json(
      { error: `Manufacturing analytics CSV exports are capped at ${MANUFACTURING_ANALYTICS_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
    : null
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!canAccessManufacturingAnalytics(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const filters = filtersFromRequest(req)
  const reportType = req.nextUrl.searchParams.get('report') ?? 'production-variance'
  const date = new Date().toISOString().slice(0, 10)
  // Data rows only; the report's notices ride in a response header, and follow the data as `#` rows only with ?metadata=1 or ?notices=1.
  const includeInBody = wantsCsvMetadataRows(req) || req.nextUrl.searchParams.get('notices') === '1'

  try {
    switch (reportType) {
      case 'production-variance': {
        const report = await getProductionVarianceReport(filters, { paginate: false })
        const oversized = rejectOversizedExport(report.pageInfo.totalRows)
        if (oversized) return oversized
        return csvResponseWithNotices(toCsv(report.rows, EXPORT_COLUMNS['production-variance']), `production-variance-${date}.csv`, report.notices, { includeInBody })
      }
      case 'wip': {
        const report = await getWipReport(filters, { paginate: false })
        const oversized = rejectOversizedExport(report.pageInfo.totalRows)
        if (oversized) return oversized
        return csvResponseWithNotices(toCsv(report.rows, EXPORT_COLUMNS['wip']), `wip-${date}.csv`, report.notices, { includeInBody })
      }
      default:
        return NextResponse.json({ error: 'Unknown manufacturing analytics export type' }, { status: 400 })
    }
  } catch (error) {
    if (error instanceof ManufacturingAnalyticsSourceLimitError) {
      return sourceLimitCsvResponse(error, EXPORT_COLUMNS[reportType] ?? [], `${reportType}-${date}.csv`)
    }
    throw error
  }
}
