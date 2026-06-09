import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvBufferedStreamResponse } from '@/lib/csv'
import { db } from '@/lib/db'
import {
  getCogsReport,
  getInventoryTurnoverReport,
  getInventoryValuationReport,
  getLandedCostReport,
  InventoryTurnoverSourceLimitError,
  inventoryCostingFiltersFromSearch,
  INVENTORY_COSTING_CSV_ROW_LIMIT,
  type InventoryCostingSearchParams,
  type InventoryCostingReportType,
} from '@/lib/domain/inventory/inventory-costing-reports'
import { inventoryCostingApiAccessDenied } from '@/lib/security/inventory-costing-access'

export const INVENTORY_VALUATION_CSV_HEADERS = ['sku', 'mpn', 'productName', 'categoryName', 'supplierNames', 'warehouseCode', 'warehouseName', 'qty', 'stockUnit', 'unitCostBase', 'totalValueBase', 'glBalanceBase', 'glVarianceBase']

async function loadMpnByProductId(productIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(productIds.filter((id): id is string => Boolean(id))))
  if (ids.length === 0) return new Map()
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, mpn: true },
  })
  return new Map(products.map((product) => [product.id, product.mpn ?? '']))
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  const denied = inventoryCostingApiAccessDenied(session)
  if (denied) return denied

  const type = req.nextUrl.searchParams.get('report') ?? 'inventory-valuation'
  if (!isInventoryCostingReportType(type)) {
    return NextResponse.json({ error: 'Unknown inventory-costing export type' }, { status: 400 })
  }
  const date = new Date().toISOString().slice(0, 10)
  const filters = inventoryCostingFiltersFromSearch(searchParamsForFilters(req.nextUrl.searchParams))

  switch (type) {
    case 'inventory-valuation': {
      const report = await getInventoryValuationReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const rows = report.rows.map((row) => ({
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
        productName: row.productName,
        categoryName: row.categoryName ?? '',
        supplierNames: row.supplierNames.join('; '),
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouseName,
        qty: row.qty,
        stockUnit: row.stockUnit,
        unitCostBase: row.unitCostBase ?? '',
        totalValueBase: row.totalValueBase,
        glBalanceBase: row.glBalanceBase ?? '',
        glVarianceBase: row.glVarianceBase ?? '',
      }))
      return csvBufferedStreamResponse(
        rows,
        INVENTORY_VALUATION_CSV_HEADERS,
        `inventory-valuation-${date}.csv`,
        { asOf: report.asOf, source: report.source, valueReplayReliable: report.valueReplayReliable, generatedAt: report.generatedAt },
      )
    }

    case 'cogs': {
      const report = await getCogsReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const rows = report.rows.map((row) => ({
        groupLabel: row.groupLabel,
        sku: row.sku ?? '',
        mpn: row.productId ? (mpnByProductId.get(row.productId) ?? '') : '',
        categoryName: row.categoryName ?? '',
        warehouseCode: row.warehouseCode ?? '',
        customerName: row.customerName ?? '',
        channel: row.channel ?? '',
        qty: row.qty,
        cogsBase: row.cogsBase,
        revenueBase: row.revenueBase ?? '',
        grossMarginBase: row.grossMarginBase ?? '',
        grossMarginPct: row.grossMarginPct ?? '',
        movementCount: row.movementCount,
        revenueCaptured: row.revenueCaptured,
      }))
      return csvBufferedStreamResponse(
        rows,
        ['groupLabel', 'sku', 'mpn', 'categoryName', 'warehouseCode', 'customerName', 'channel', 'qty', 'cogsBase', 'revenueBase', 'grossMarginBase', 'grossMarginPct', 'movementCount', 'revenueCaptured'],
        `cogs-${date}.csv`,
        { dateFrom: report.dateFrom, dateTo: report.dateTo, groupBy: report.groupBy, generatedAt: report.generatedAt },
      )
    }

    case 'landed-cost': {
      const report = await getLandedCostReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const rows = report.rows.map((row) => ({
        poReference: row.poReference,
        supplierName: row.supplierName,
        status: row.status,
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
        productName: row.productName,
        categoryName: row.categoryName ?? '',
        qty: row.qty,
        goodsUnitCostBase: row.goodsUnitCostBase,
        landedUnitCostBase: row.landedUnitCostBase,
        landedUpliftUnitBase: row.landedUpliftUnitBase,
        landedUpliftPct: row.landedUpliftPct ?? '',
        goodsValueBase: row.goodsValueBase,
        landedValueBase: row.landedValueBase,
        landedCostMethod: row.landedCostMethod,
        revaluationCount: row.revaluationCount,
      }))
      return csvBufferedStreamResponse(
        rows,
        ['poReference', 'supplierName', 'status', 'sku', 'mpn', 'productName', 'categoryName', 'qty', 'goodsUnitCostBase', 'landedUnitCostBase', 'landedUpliftUnitBase', 'landedUpliftPct', 'goodsValueBase', 'landedValueBase', 'landedCostMethod', 'revaluationCount'],
        `landed-cost-${date}.csv`,
        { dateFrom: report.dateFrom, dateTo: report.dateTo, generatedAt: report.generatedAt },
      )
    }

    case 'inventory-turnover': {
      const report = await getInventoryTurnoverReport(filters, { paginate: false }).catch((error: unknown) => {
        if (error instanceof InventoryTurnoverSourceLimitError) return error
        throw error
      })
      if (report instanceof InventoryTurnoverSourceLimitError) {
        return NextResponse.json({ error: report.message }, { status: 413 })
      }
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const rows = report.rows.map((row) => ({
        groupLabel: row.groupLabel,
        sku: row.sku ?? '',
        mpn: row.productId ? (mpnByProductId.get(row.productId) ?? '') : '',
        categoryName: row.categoryName ?? '',
        warehouseCode: row.warehouseCode ?? '',
        supplierName: row.supplierName ?? '',
        cogsBase: row.cogsBase,
        averageInventoryValueBase: row.averageInventoryValueBase,
        turnoverRatio: row.turnoverRatio ?? '',
        daysInventoryOutstanding: row.daysInventoryOutstanding ?? '',
        cogsEntryCount: row.cogsEntryCount,
        snapshotDayCount: row.snapshotDayCount,
      }))
      return csvBufferedStreamResponse(rows, ['groupLabel', 'sku', 'mpn', 'categoryName', 'warehouseCode', 'supplierName', 'cogsBase', 'averageInventoryValueBase', 'turnoverRatio', 'daysInventoryOutstanding', 'cogsEntryCount', 'snapshotDayCount'], `inventory-turnover-${date}.csv`)
    }
  }
}

function isInventoryCostingReportType(value: string): value is InventoryCostingReportType {
  return value === 'inventory-valuation' || value === 'cogs' || value === 'landed-cost' || value === 'inventory-turnover'
}

function searchParamsForFilters(searchParams: URLSearchParams): InventoryCostingSearchParams {
  const params: InventoryCostingSearchParams = {}
  for (const [key, value] of searchParams.entries()) {
    const existing = params[key]
    if (existing == null) params[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else params[key] = [existing, value]
  }
  return params
}

function exportTooLarge(rowCount: number): NextResponse | null {
  if (rowCount <= INVENTORY_COSTING_CSV_ROW_LIMIT) return null
  return NextResponse.json(
    { error: `Inventory costing CSV exports are capped at ${INVENTORY_COSTING_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
    { status: 413 },
  )
}
