import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvResponse, toCsv } from '@/lib/csv'
import {
  getBackorderDemandReport,
  getComponentShortageReport,
  getReorderReport,
} from '@/lib/domain/inventory/replenishment-reports'
import type { StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { canAccessReplenishmentReports } from '@/lib/security/replenishment-report-access'

const REPLENISHMENT_CSV_ROW_LIMIT = 50000

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function filtersFromRequest(req: NextRequest): StockPositionFilters {
  return {
    warehouseId: one(req, 'warehouseId'),
    categoryId: one(req, 'categoryId'),
    supplierId: one(req, 'supplierId'),
    productType: one(req, 'productType') as StockPositionFilters['productType'],
    thresholdDays: positiveInteger(one(req, 'thresholdDays')),
  }
}

function rejectOversizedExport(totalRows: number): NextResponse | null {
  return totalRows > REPLENISHMENT_CSV_ROW_LIMIT
    ? NextResponse.json(
      { error: `Replenishment CSV exports are capped at ${REPLENISHMENT_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
    : null
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!canAccessReplenishmentReports(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const type = req.nextUrl.searchParams.get('type') ?? 'reorder'
  const filters = filtersFromRequest(req)
  const date = new Date().toISOString().slice(0, 10)

  switch (type) {
    case 'reorder': {
      const report = await getReorderReport(filters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const data = report.rows.map((row) => ({
        sku: row.sku,
        productName: row.productName,
        productType: row.productType,
        category: row.categoryName ?? '',
        supplierName: row.supplierName ?? '',
        supplierSku: row.supplierSku ?? '',
        stockUnit: row.stockUnit,
        availableQty: row.availableQty,
        warehouseAvailabilityBreakdown: row.warehouseAvailabilityBreakdown,
        inboundOpenPoQty: row.inboundOpenPoQty,
        averageDailyDemand: row.averageDailyDemand,
        leadTimeDays: row.leadTimeDays,
        safetyStockQty: row.safetyStockQty,
        reorderPoint: row.reorderPoint,
        configuredReorderQty: row.configuredReorderQty,
        suggestedReorderQty: row.suggestedReorderQty,
        abcClass: row.abcClass ?? '',
        urgency: row.urgency,
      }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'productType', 'category', 'supplierName', 'supplierSku', 'stockUnit', 'availableQty', 'warehouseAvailabilityBreakdown', 'inboundOpenPoQty', 'averageDailyDemand', 'leadTimeDays', 'safetyStockQty', 'reorderPoint', 'configuredReorderQty', 'suggestedReorderQty', 'abcClass', 'urgency']), `reorder-${date}.csv`)
    }

    case 'backorder': {
      const report = await getBackorderDemandReport(filters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const data = report.rows.map((row) => ({
        sku: row.sku,
        productName: row.productName,
        productType: row.productType,
        category: row.categoryName ?? '',
        suppliers: row.supplierNames.join('; '),
        stockUnit: row.stockUnit,
        orderCount: row.orderCount,
        orderedQty: row.orderedQty,
        committedQty: row.committedQty,
        allocatedQty: row.allocatedQty,
        backorderQty: row.backorderQty,
        inboundOpenPoQty: row.inboundOpenPoQty,
        projectedFillDate: row.projectedFillDate ?? '',
        oldestOrderAt: row.oldestOrderAt,
      }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'productType', 'category', 'suppliers', 'stockUnit', 'orderCount', 'orderedQty', 'committedQty', 'allocatedQty', 'backorderQty', 'inboundOpenPoQty', 'projectedFillDate', 'oldestOrderAt']), `backorder-${date}.csv`)
    }

    case 'component-shortage': {
      const report = await getComponentShortageReport(filters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const data = report.rows.map((row) => ({
        sku: row.sku,
        productName: row.productName,
        productType: row.productType,
        category: row.categoryName ?? '',
        suppliers: row.supplierNames.join('; '),
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouseName,
        stockUnit: row.stockUnit,
        productionOrderCount: row.productionOrderCount,
        requiredQty: row.requiredQty,
        availableQty: row.availableQty,
        inboundOpenPoQty: row.inboundOpenPoQty,
        shortageQty: row.shortageQty,
        earliestScheduledAt: row.earliestScheduledAt ?? '',
        outputProducts: row.outputProducts.join('; '),
      }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'productType', 'category', 'suppliers', 'warehouseCode', 'warehouseName', 'stockUnit', 'productionOrderCount', 'requiredQty', 'availableQty', 'inboundOpenPoQty', 'shortageQty', 'earliestScheduledAt', 'outputProducts']), `component-shortage-${date}.csv`)
    }

    default:
      return NextResponse.json({ error: 'Unknown replenishment export type' }, { status: 400 })
  }
}
