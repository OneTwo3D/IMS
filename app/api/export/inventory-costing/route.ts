import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvBufferedStreamResponse } from '@/lib/csv'
import {
  getCogsReport,
  getInventoryValuationReport,
  getLandedCostReport,
  inventoryCostingFiltersFromSearch,
  INVENTORY_COSTING_CSV_ROW_LIMIT,
  type InventoryCostingSearchParams,
  type InventoryCostingReportType,
} from '@/lib/domain/inventory/inventory-costing-reports'
import { inventoryCostingApiAccessDenied } from '@/lib/security/inventory-costing-access'

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
      const rows = report.rows.map((row) => ({
        asOf: report.asOf,
        sku: row.sku,
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
        source: report.source,
        valueReplayReliable: report.valueReplayReliable,
        generatedAt: report.generatedAt,
      }))
      return csvBufferedStreamResponse(rows, ['asOf', 'sku', 'productName', 'categoryName', 'supplierNames', 'warehouseCode', 'warehouseName', 'qty', 'stockUnit', 'unitCostBase', 'totalValueBase', 'glBalanceBase', 'glVarianceBase', 'source', 'valueReplayReliable', 'generatedAt'], `inventory-valuation-${date}.csv`)
    }

    case 'cogs': {
      const report = await getCogsReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const rows = report.rows.map((row) => ({
        dateFrom: report.dateFrom,
        dateTo: report.dateTo,
        groupBy: report.groupBy,
        groupLabel: row.groupLabel,
        sku: row.sku ?? '',
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
        generatedAt: report.generatedAt,
      }))
      return csvBufferedStreamResponse(rows, ['dateFrom', 'dateTo', 'groupBy', 'groupLabel', 'sku', 'categoryName', 'warehouseCode', 'customerName', 'channel', 'qty', 'cogsBase', 'revenueBase', 'grossMarginBase', 'grossMarginPct', 'movementCount', 'revenueCaptured', 'generatedAt'], `cogs-${date}.csv`)
    }

    case 'landed-cost': {
      const report = await getLandedCostReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const rows = report.rows.map((row) => ({
        dateFrom: report.dateFrom,
        dateTo: report.dateTo,
        poReference: row.poReference,
        supplierName: row.supplierName,
        status: row.status,
        sku: row.sku,
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
        generatedAt: report.generatedAt,
      }))
      return csvBufferedStreamResponse(rows, ['dateFrom', 'dateTo', 'poReference', 'supplierName', 'status', 'sku', 'productName', 'categoryName', 'qty', 'goodsUnitCostBase', 'landedUnitCostBase', 'landedUpliftUnitBase', 'landedUpliftPct', 'goodsValueBase', 'landedValueBase', 'landedCostMethod', 'revaluationCount', 'generatedAt'], `landed-cost-${date}.csv`)
    }
  }
}

function isInventoryCostingReportType(value: string): value is InventoryCostingReportType {
  return value === 'inventory-valuation' || value === 'cogs' || value === 'landed-cost'
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
