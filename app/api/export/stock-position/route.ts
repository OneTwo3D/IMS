import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'
import {
  getNegativeStockReport,
  getStockAllocationReport,
  getStockOnHandReport,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import { getDeadStockReport, getInventoryAgingReport, InventoryHealthSourceLimitError } from '@/lib/domain/inventory/inventory-health-reports'
import { stockPositionApiAccessDenied } from '@/lib/security/stock-position-access'

const STOCK_POSITION_CSV_ROW_LIMIT = 50000
export const STOCK_ON_HAND_CSV_HEADERS = ['sku', 'mpn', 'productName', 'productType', 'category', 'suppliers', 'warehouseCode', 'warehouseName', 'stockUnit', 'quantity', 'reservedQty', 'availableQty', 'unitCostBase', 'totalValueBase', 'reservationQtySource', 'reservationSnapshotDate', 'reservationSourceCount']

type StockPositionExportDeps = {
  requireApiAuth: typeof requireApiAuth
  accessDenied: typeof stockPositionApiAccessDenied
  getStockOnHandReport: typeof getStockOnHandReport
  getStockAllocationReport: typeof getStockAllocationReport
  getNegativeStockReport: typeof getNegativeStockReport
  getInventoryAgingReport: typeof getInventoryAgingReport
  getDeadStockReport: typeof getDeadStockReport
  loadMpnByProductId: typeof loadMpnByProductId
}

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
    thresholdDays: positiveInteger(one(req, 'thresholdDays')),
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function rejectOversizedExport(totalRows: number): NextResponse | null {
  return totalRows > STOCK_POSITION_CSV_ROW_LIMIT
    ? NextResponse.json(
      { error: `Stock-position CSV exports are capped at ${STOCK_POSITION_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
    : null
}

const defaultStockPositionExportDeps: StockPositionExportDeps = {
  requireApiAuth,
  accessDenied: stockPositionApiAccessDenied,
  getStockOnHandReport,
  getStockAllocationReport,
  getNegativeStockReport,
  getInventoryAgingReport,
  getDeadStockReport,
  loadMpnByProductId,
}

export async function getStockPositionExportResponse(
  req: NextRequest,
  deps: Partial<StockPositionExportDeps> = {},
) {
  const resolvedDeps = { ...defaultStockPositionExportDeps, ...deps }
  const session = await resolvedDeps.requireApiAuth()
  if (session instanceof NextResponse) return session
  const denied = resolvedDeps.accessDenied(session)
  if (denied) return denied

  const type = req.nextUrl.searchParams.get('type') ?? 'stock-on-hand'
  const date = new Date().toISOString().slice(0, 10)

  switch (type) {
    case 'stock-on-hand': {
      const report = await resolvedDeps.getStockOnHandReport(stockPositionFilters(req), { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((r) => r.productId))
      const data = report.rows.map((r) => ({
        sku: r.sku,
        mpn: mpnByProductId.get(r.productId) ?? '',
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
        reservationQtySource: r.reservationQtySource,
        reservationSnapshotDate: r.reservationSnapshotDate ?? '',
        reservationSourceCount: r.reservationSourceCount ?? 'unknown',
      }))
      return csvResponse(
        toCsv(data, STOCK_ON_HAND_CSV_HEADERS),
        `stock-on-hand-${date}.csv`,
        { asOf: report.asOf, source: report.source, generatedAt: report.generatedAt },
      )
    }

    case 'stock-allocations': {
      const report = await resolvedDeps.getStockAllocationReport(stockPositionFilters(req), { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((r) => r.productId))
      const data = report.rows.map((r) => ({
        sku: r.sku,
        mpn: mpnByProductId.get(r.productId) ?? '',
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
      }))
      return csvResponse(
        toCsv(data, ['sku', 'mpn', 'productName', 'productType', 'category', 'warehouseCode', 'warehouseName', 'source', 'referenceId', 'referenceLabel', 'expectedDate', 'ageBucket', 'stockUnit', 'reservedQty', 'stockLevelReservedQty', 'driftQty']),
        `stock-allocations-${date}.csv`,
        { generatedAt: report.generatedAt },
      )
    }

    case 'negative-stock': {
      const report = await resolvedDeps.getNegativeStockReport(stockPositionFilters(req), { paginate: false })
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((r) => r.productId))
      const data = report.rows.map((r) => ({
        sku: r.sku,
        mpn: mpnByProductId.get(r.productId) ?? '',
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
      }))
      return csvResponse(
        toCsv(data, ['sku', 'mpn', 'productName', 'productType', 'category', 'warehouseCode', 'warehouseName', 'stockUnit', 'status', 'currentQty', 'minimumQty', 'firstNegativeAt', 'lastMovementAt', 'movementCount']),
        `negative-stock-${date}.csv`,
        { dateFrom: report.dateFrom, dateTo: report.dateTo, generatedAt: report.generatedAt },
      )
    }

    case 'inventory-aging': {
      const report = await resolvedDeps.getInventoryAgingReport(stockPositionFilters(req), { paginate: false }).catch((error: unknown) => {
        if (error instanceof InventoryHealthSourceLimitError) return error
        throw error
      })
      if (report instanceof InventoryHealthSourceLimitError) {
        return NextResponse.json({ error: report.message }, { status: 413 })
      }
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((r) => r.productId))
      const data = report.rows.map((r) => ({
        sku: r.sku,
        mpn: mpnByProductId.get(r.productId) ?? '',
        productName: r.productName,
        productType: r.productType,
        category: r.categoryName ?? '',
        suppliers: r.supplierNames.join('; '),
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        stockUnit: r.stockUnit,
        bucket: r.bucket,
        minAgeDays: r.minAgeDays,
        maxAgeDays: r.maxAgeDays ?? '',
        qty: r.qty,
        valueBase: r.valueBase,
        source: r.source,
      }))
      return csvResponse(toCsv(data, ['sku', 'mpn', 'productName', 'productType', 'category', 'suppliers', 'warehouseCode', 'warehouseName', 'stockUnit', 'bucket', 'minAgeDays', 'maxAgeDays', 'qty', 'valueBase', 'source']), `inventory-aging-${date}.csv`)
    }

    case 'dead-stock': {
      const report = await resolvedDeps.getDeadStockReport(stockPositionFilters(req), { paginate: false }).catch((error: unknown) => {
        if (error instanceof InventoryHealthSourceLimitError) return error
        throw error
      })
      if (report instanceof InventoryHealthSourceLimitError) {
        return NextResponse.json({ error: report.message }, { status: 413 })
      }
      const oversized = rejectOversizedExport(report.pageInfo.totalRows)
      if (oversized) return oversized
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((r) => r.productId))
      const data = report.rows.map((r) => ({
        sku: r.sku,
        mpn: mpnByProductId.get(r.productId) ?? '',
        productName: r.productName,
        productType: r.productType,
        category: r.categoryName ?? '',
        suppliers: r.supplierNames.join('; '),
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        stockUnit: r.stockUnit,
        qty: r.qty,
        valueBase: r.valueBase,
        daysSinceLastSale: r.daysSinceLastSale ?? '',
        lastSaleAt: r.lastSaleAt ?? '',
        firstStockedAt: r.firstStockedAt ?? '',
      }))
      return csvResponse(toCsv(data, ['sku', 'mpn', 'productName', 'productType', 'category', 'suppliers', 'warehouseCode', 'warehouseName', 'stockUnit', 'qty', 'valueBase', 'daysSinceLastSale', 'lastSaleAt', 'firstStockedAt']), `dead-stock-${date}.csv`)
    }

    default:
      return NextResponse.json({ error: 'Unknown stock-position export type' }, { status: 400 })
  }
}

export async function GET(req: NextRequest) {
  return getStockPositionExportResponse(req)
}
