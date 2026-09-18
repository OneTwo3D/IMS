import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvBufferedStreamResponse } from '@/lib/csv'
import { REFUND_BASIS_NOTICE_COGS_MARGIN } from '@/lib/analytics/refund-figure-surfaces'
import { ExactFigure, ExactRatio, roundExact } from '@/lib/domain/math/exact-figure'
import type { DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
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

type InventoryCostingExportDeps = {
  requireApiAuth: typeof requireApiAuth
  accessDenied: typeof inventoryCostingApiAccessDenied
  getInventoryValuationReport: typeof getInventoryValuationReport
  getCogsReport: typeof getCogsReport
  getLandedCostReport: typeof getLandedCostReport
  getInventoryTurnoverReport: typeof getInventoryTurnoverReport
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

const defaultInventoryCostingExportDeps: InventoryCostingExportDeps = {
  requireApiAuth,
  accessDenied: inventoryCostingApiAccessDenied,
  getInventoryValuationReport,
  getCogsReport,
  getLandedCostReport,
  getInventoryTurnoverReport,
  loadMpnByProductId,
}

export async function getInventoryCostingExportResponse(
  req: NextRequest,
  deps: Partial<InventoryCostingExportDeps> = {},
) {
  const resolvedDeps = { ...defaultInventoryCostingExportDeps, ...deps }
  const session = await resolvedDeps.requireApiAuth()
  if (session instanceof NextResponse) return session
  const denied = resolvedDeps.accessDenied(session)
  if (denied) return denied

  const type = req.nextUrl.searchParams.get('report') ?? 'inventory-valuation'
  if (!isInventoryCostingReportType(type)) {
    return NextResponse.json({ error: 'Unknown inventory-costing export type' }, { status: 400 })
  }
  const date = new Date().toISOString().slice(0, 10)
  const filters = inventoryCostingFiltersFromSearch(searchParamsForFilters(req.nextUrl.searchParams))

  switch (type) {
    case 'inventory-valuation': {
      const report = await resolvedDeps.getInventoryValuationReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((row) => row.productId))
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
      const report = await resolvedDeps.getCogsReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((row) => row.productId))
      // THE FILE ROUNDS EACH FIGURE ONCE, FROM ITS EXACT VALUE (o3d-rv4a r5, Codex round 5): money to
      // six decimals, quantities to four, the ratio to two — the precisions this export has always
      // published — each toward the bound in the column beside it. The producer hands over exact
      // figures, so this is the only rounding a CSV value receives.
      const rows = report.rows.map((row) => ({
        groupLabel: row.groupLabel,
        sku: row.sku ?? '',
        mpn: row.productId ? (mpnByProductId.get(row.productId) ?? '') : '',
        categoryName: row.categoryName ?? '',
        warehouseCode: row.warehouseCode ?? '',
        customerName: row.customerName ?? '',
        channel: row.channel ?? '',
        qty: exportFigure(row.qty, CSV_QTY_PLACES, 'exact'),
        cogsBase: exportFigure(row.cogsBase, CSV_MONEY_PLACES, 'exact'),
        revenueBase: row.revenueBase ? exportFigure(row.revenueBase, CSV_MONEY_PLACES, row.revenueBaseBound ?? 'exact') : '',
        // o3d-rv4a: THE BOUND IS ITS OWN COLUMN, and a blank in it is the producer's `null` — no
        // published figure, so no relation. A CSV that dropped this would be the same defect in a
        // different skin: the page would mark revenue `≤` while the file an operator takes away shows
        // an exact-looking number with nothing beside it, and a file is read as the whole picture.
        revenueBaseBound: row.revenueBaseBound ?? '',
        grossMarginBase: row.grossMarginBase ? exportFigure(row.grossMarginBase, CSV_MONEY_PLACES, row.grossMarginBaseBound ?? 'exact') : '',
        grossMarginBaseBound: row.grossMarginBaseBound ?? '',
        grossMarginPct: row.grossMarginPct ? exportFigure(row.grossMarginPct, CSV_PCT_PLACES, row.grossMarginPctBound ?? 'exact') : '',
        // Separate from the two linear bounds: margin is a ratio, so this column can read
        // `indeterminate` on a row whose revenue and margin beside it are sound ceilings. A single
        // shared flag column could not say that, and a yes/no one could not say it at all.
        grossMarginPctBound: row.grossMarginPctBound ?? '',
        refundsNetBasis: exportFigure(row.refundsNetBasis, CSV_MONEY_PLACES, 'exact'),
        refundsGrossBasis: exportFigure(row.refundsGrossBasis, CSV_MONEY_PLACES, 'exact'),
        refundsUnknownBasis: exportFigure(row.refundsUnknownBasis, CSV_MONEY_PLACES, 'exact'),
        movementCount: row.movementCount,
        revenueCaptured: row.revenueCaptured,
      }))
      return csvBufferedStreamResponse(
        rows,
        ['groupLabel', 'sku', 'mpn', 'categoryName', 'warehouseCode', 'customerName', 'channel', 'qty', 'cogsBase', 'revenueBase', 'revenueBaseBound', 'grossMarginBase', 'grossMarginBaseBound', 'grossMarginPct', 'grossMarginPctBound', 'refundsNetBasis', 'refundsGrossBasis', 'refundsUnknownBasis', 'movementCount', 'revenueCaptured'],
        `cogs-${date}.csv`,
        // A FILE READER HAS NO TOOLTIP. The repo's own CSV metadata channel turns this into `#`
        // comment rows at the foot of the file (which parseCsv skips, so re-import is unharmed) and an
        // X-IMS-Export-Metadata header for API consumers. o3d-rv4a carries the producer's WHOLE totals
        // map through it by ITERATION, not a hand-kept list: the bounds on the period figures and the
        // credit that reached no row exist nowhere in `rows`, so an export built from rows alone drops
        // them silently — and a totals key added tomorrow ships tomorrow. Same rule and same reason as
        // app/api/export/sales-analytics/route.ts.
        {
          dateFrom: report.dateFrom,
          dateTo: report.dateTo,
          groupBy: report.groupBy,
          generatedAt: report.generatedAt,
          refundTreatment: REFUND_BASIS_NOTICE_COGS_MARGIN,
          // NO ROUNDING-NOTICE ROW (o3d-rv4a r4, Codex round 4 MEDIUM 2). Round 3 added one here, and
          // CSV has no comment syntax: a standard parser reads every trailing `# key,value` line as a
          // report record, mapping it into groupLabel and sku. Only this repository's parseCsv skips
          // them. The trailing-row channel itself (the keys above and the totals below) is the
          // repository-wide contract in docs/architecture.md and is filed as o3d-x5go rather than
          // changed for one report; this branch adds no further row to it.
          ...Object.fromEntries(Object.entries(report.totals).map(([key, value]) => [`totals.${key}`, exportTotal(key, value, report.totals)])),
        },
      )
    }

    case 'landed-cost': {
      const report = await resolvedDeps.getLandedCostReport(filters, { paginate: false })
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((row) => row.productId))
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
      const report = await resolvedDeps.getInventoryTurnoverReport(filters, { paginate: false }).catch((error: unknown) => {
        if (error instanceof InventoryTurnoverSourceLimitError) return error
        throw error
      })
      if (report instanceof InventoryTurnoverSourceLimitError) {
        return NextResponse.json({ error: report.message }, { status: 413 })
      }
      const tooLarge = exportTooLarge(report.pageInfo.totalRows)
      if (tooLarge) return tooLarge
      const mpnByProductId = await resolvedDeps.loadMpnByProductId(report.rows.map((row) => row.productId))
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

export async function GET(req: NextRequest) {
  return getInventoryCostingExportResponse(req)
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

const CSV_MONEY_PLACES = 6
const CSV_QTY_PLACES = 4
const CSV_PCT_PLACES = 2

/** The CSV's one rounding of a figure: money and ratios keep their fixed shape, quantities are trimmed. */
function exportFigure(value: ExactFigure | ExactRatio, places: number, bound: DerivedFigureBound): string {
  return roundExact(value, places, bound, { trailingZeros: places === CSV_MONEY_PLACES })
}

const DERIVED_FIGURE_BOUNDS: ReadonlySet<string> = new Set(['exact', 'upper', 'lower', 'indeterminate'])

/**
 * A totals value for the metadata rows, rounded once. Still by ITERATION over the producer's whole map,
 * so a totals key added tomorrow ships tomorrow; a figure is rounded toward the bound published beside
 * it as `<key>Bound` where there is one, and to nearest where there is not.
 */
function exportTotal(key: string, value: unknown, totals: Record<string, unknown>): unknown {
  if (!(value instanceof ExactFigure) && !(value instanceof ExactRatio)) return value
  const bound = totals[`${key}Bound`]
  const direction = typeof bound === 'string' && DERIVED_FIGURE_BOUNDS.has(bound) ? bound as DerivedFigureBound : 'exact'
  return exportFigure(value, key === 'qty' ? CSV_QTY_PLACES : CSV_MONEY_PLACES, direction)
}

function exportTooLarge(rowCount: number): NextResponse | null {
  if (rowCount <= INVENTORY_COSTING_CSV_ROW_LIMIT) return null
  return NextResponse.json(
    { error: `Inventory costing CSV exports are capped at ${INVENTORY_COSTING_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
    { status: 413 },
  )
}
