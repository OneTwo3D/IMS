import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvResponse, toCsv } from '@/lib/csv'
import { db } from '@/lib/db'
import {
  getBackorderDemandReport,
  getComponentShortageReport,
  getReorderReport,
} from '@/lib/domain/inventory/replenishment-reports'
import type { StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { canAccessReplenishmentReports } from '@/lib/security/replenishment-report-access'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'

const REPLENISHMENT_CSV_ROW_LIMIT = 50000

async function loadMpnByProductId(productIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(productIds.filter((id): id is string => Boolean(id))))
  if (ids.length === 0) return new Map()
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, mpn: true },
  })
  return new Map(products.map((product) => [product.id, product.mpn ?? '']))
}

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const ABC_CLASSES = ['A', 'B', 'C'] as const
const URGENCIES = ['critical', 'reorder', 'watch'] as const

function abcClass(value: string | undefined): StockPositionFilters['abcClass'] {
  return (ABC_CLASSES as readonly string[]).includes(value ?? '') ? (value as StockPositionFilters['abcClass']) : undefined
}

function urgency(value: string | undefined): StockPositionFilters['urgency'] {
  return (URGENCIES as readonly string[]).includes(value ?? '') ? (value as StockPositionFilters['urgency']) : undefined
}

function filtersFromRequest(req: NextRequest): StockPositionFilters {
  return {
    warehouseId: one(req, 'warehouseId'),
    categoryId: one(req, 'categoryId'),
    supplierId: one(req, 'supplierId'),
    productType: one(req, 'productType') as StockPositionFilters['productType'],
    thresholdDays: positiveInteger(one(req, 'thresholdDays')),
    // audit-00o7: reorder-only filters — ignored by backorder/component-shortage,
    // applied inside getReorderReport so the CSV matches the on-screen filtered set.
    // Validate enums here (the export route is hit directly, not only via the page)
    // so an unknown value falls back to "no filter" instead of matching zero rows.
    abcClass: abcClass(one(req, 'abcClass')),
    urgency: urgency(one(req, 'urgency')),
    search: one(req, 'search')?.trim().slice(0, 100) || undefined,
    targetCoverWeeks: positiveInteger(one(req, 'targetCoverWeeks')),
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

  try {
    switch (type) {
    case 'reorder': {
      // audit-5f19: the CSV always lists every product (including zero-reorder),
      // even when the on-screen report is filtered to products needing replenishment.
      const report = await getReorderReport({ ...filters, includeZero: true }, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const data = report.rows.map((row) => ({
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
        productName: row.productName,
        productType: row.productType,
        category: row.categoryName ?? '',
        supplierName: row.supplierName ?? '',
        supplierSku: row.supplierSku ?? '',
        neededFor: row.neededFor.join('; '),
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
      return csvResponse(toCsv(data, ['sku', 'mpn', 'productName', 'productType', 'category', 'supplierName', 'supplierSku', 'neededFor', 'stockUnit', 'availableQty', 'warehouseAvailabilityBreakdown', 'inboundOpenPoQty', 'averageDailyDemand', 'leadTimeDays', 'safetyStockQty', 'reorderPoint', 'configuredReorderQty', 'suggestedReorderQty', 'abcClass', 'urgency']), `reorder-${date}.csv`)
    }

    case 'backorder': {
      const report = await getBackorderDemandReport(filters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const data = report.rows.map((row) => ({
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
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
      return csvResponse(toCsv(data, ['sku', 'mpn', 'productName', 'productType', 'category', 'suppliers', 'stockUnit', 'orderCount', 'orderedQty', 'committedQty', 'allocatedQty', 'backorderQty', 'inboundOpenPoQty', 'projectedFillDate', 'oldestOrderAt']), `backorder-${date}.csv`)
    }

    case 'component-shortage': {
      const report = await getComponentShortageReport(filters, { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const data = report.rows.map((row) => ({
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
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
      return csvResponse(toCsv(data, ['sku', 'mpn', 'productName', 'productType', 'category', 'suppliers', 'warehouseCode', 'warehouseName', 'stockUnit', 'productionOrderCount', 'requiredQty', 'availableQty', 'inboundOpenPoQty', 'shortageQty', 'earliestScheduledAt', 'outputProducts']), `component-shortage-${date}.csv`)
    }

    default:
      return NextResponse.json({ error: 'Unknown replenishment export type' }, { status: 400 })
    }
  } catch (error) {
    if (isSourceScanTooLargeError(error)) return NextResponse.json({ error: error.message }, { status: 413 })
    throw error
  }
}
