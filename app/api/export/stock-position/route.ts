import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { toCsv, csvResponse } from '@/lib/csv'
import {
  getNegativeStockReport,
  getStockAllocationReport,
  getStockOnHandReport,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import { stockPositionApiAccessDenied } from '@/lib/security/stock-position-access'

const STOCK_POSITION_CSV_ROW_LIMIT = 50000

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
}

function stockPositionFilters(req: NextRequest): StockPositionFilters {
  return {
    asOf: one(req, 'asOf'),
    dateFrom: one(req, 'dateFrom') ?? one(req, 'from'),
    dateTo: one(req, 'dateTo') ?? one(req, 'to'),
    warehouseId: one(req, 'warehouseId'),
    categoryId: one(req, 'categoryId'),
    supplierId: one(req, 'supplierId'),
    productType: one(req, 'productType') as StockPositionFilters['productType'],
    includeZero: one(req, 'includeZero') === '1',
  }
}

function rejectOversizedExport(totalRows: number): NextResponse | null {
  return totalRows > STOCK_POSITION_CSV_ROW_LIMIT
    ? NextResponse.json(
      { error: `Stock-position CSV exports are capped at ${STOCK_POSITION_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
    : null
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  const denied = stockPositionApiAccessDenied(session)
  if (denied) return denied

  const type = req.nextUrl.searchParams.get('type') ?? 'stock-on-hand'
  const date = new Date().toISOString().slice(0, 10)

  switch (type) {
    case 'stock-on-hand': {
      const report = await getStockOnHandReport(stockPositionFilters(req), { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const data = report.rows.map((r) => ({
        sku: r.sku,
        productName: r.productName,
        productType: r.productType,
        category: r.categoryName ?? '',
        suppliers: r.supplierNames.join('; '),
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        stockUnit: r.stockUnit,
        quantity: r.quantity,
        reservedQty: r.reservedQty,
        availableQty: r.availableQty,
        unitCostBase: r.unitCostBase ?? '',
        totalValueBase: r.totalValueBase,
        asOf: report.asOf,
        source: report.source,
        generatedAt: report.generatedAt,
      }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'productType', 'category', 'suppliers', 'warehouseCode', 'warehouseName', 'stockUnit', 'quantity', 'reservedQty', 'availableQty', 'unitCostBase', 'totalValueBase', 'asOf', 'source', 'generatedAt']), `stock-on-hand-${date}.csv`)
    }

    case 'stock-allocations': {
      const report = await getStockAllocationReport(stockPositionFilters(req), { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const data = report.rows.map((r) => ({
        sku: r.sku,
        productName: r.productName,
        productType: r.productType,
        category: r.categoryName ?? '',
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        source: r.source,
        referenceId: r.referenceId,
        referenceLabel: r.referenceLabel,
        expectedDate: r.expectedDate ?? '',
        ageBucket: r.ageBucket,
        stockUnit: r.stockUnit,
        reservedQty: r.reservedQty,
        stockLevelReservedQty: r.stockLevelReservedQty,
        driftQty: r.driftQty,
        generatedAt: report.generatedAt,
      }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'productType', 'category', 'warehouseCode', 'warehouseName', 'source', 'referenceId', 'referenceLabel', 'expectedDate', 'ageBucket', 'stockUnit', 'reservedQty', 'stockLevelReservedQty', 'driftQty', 'generatedAt']), `stock-allocations-${date}.csv`)
    }

    case 'negative-stock': {
      const report = await getNegativeStockReport(stockPositionFilters(req), { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const data = report.rows.map((r) => ({
        sku: r.sku,
        productName: r.productName,
        productType: r.productType,
        category: r.categoryName ?? '',
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        stockUnit: r.stockUnit,
        status: r.status,
        currentQty: r.currentQty,
        minimumQty: r.minimumQty,
        firstNegativeAt: r.firstNegativeAt ?? '',
        lastMovementAt: r.lastMovementAt ?? '',
        movementCount: r.movementCount,
        dateFrom: report.dateFrom,
        dateTo: report.dateTo,
        generatedAt: report.generatedAt,
      }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'productType', 'category', 'warehouseCode', 'warehouseName', 'stockUnit', 'status', 'currentQty', 'minimumQty', 'firstNegativeAt', 'lastMovementAt', 'movementCount', 'dateFrom', 'dateTo', 'generatedAt']), `negative-stock-${date}.csv`)
    }

    default:
      return NextResponse.json({ error: 'Unknown stock-position export type' }, { status: 400 })
  }
}
