/**
 * Slow-stock report: the support for the period-end lower-of-cost-and-NRV review (FRS 102 s13.4).
 *
 * One row per product (optionally per product and warehouse) with on-hand quantity, on-hand value from the open FIFO
 * cost layers, the age of the oldest open layer, the last SALE_DISPATCH date, the recent sales rate and the months of
 * cover. READ ONLY: a write-down is still a manual stock adjustment; this report only finds the candidates.
 *
 * The pure calculations (age, rate, cover, band, filter, sort) are exported and tested on their own; the loader below
 * feeds them from bounded queries that follow the inventory-health source-scan-limit pattern.
 */
import { Prisma, ProductType, StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import {
  HISTORICAL_IMPORT_MOVEMENT_SHAPE,
  InventoryHealthSourceLimitError,
  clampPageSize,
  directLayerProductTypeFilter,
  pageInfo,
  paginate,
  productWhere,
  rejectOverLimit,
  stockKey,
  supplierNames,
} from '@/lib/domain/inventory/inventory-health-reports'
import type { PageInfo, StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly, startOfUtcDay, subtractUtcDays, utcCalendarDayDelta } from '@/lib/domain/math/date-window'
import { sourceLimitNotice } from '@/lib/security/source-scan-error'

export const SLOW_STOCK_RATE_WINDOW_DAYS = 90
/** Sales rate is reported as units per this many days. */
export const SLOW_STOCK_RATE_PERIOD_DAYS = 30
/** Age bands, in days since the oldest open layer was received. Labels are stable CSV values. */
export const SLOW_STOCK_AGE_BANDS = [
  { label: '0-90', minDays: 0 },
  { label: '91-180', minDays: 91 },
  { label: '181-365', minDays: 181 },
  { label: '365+', minDays: 366 },
] as const

const SLOW_STOCK_LEVEL_ROW_LIMIT = 100000
const SLOW_STOCK_COST_LAYER_ROW_LIMIT = 100000
const SLOW_STOCK_SALE_GROUP_ROW_LIMIT = 100000

export type SlowStockFilters = Pick<StockPositionFilters, 'warehouseId' | 'categoryId' | 'supplierId' | 'productType' | 'page' | 'pageSize'> & {
  /** One row per product and warehouse instead of one per product. A warehouse filter scopes every figure to that warehouse either way. */
  perWarehouse?: boolean
  /** Keep rows whose oldest open layer is at least this many days old. */
  minAgeDays?: number
  /** Keep rows with no sale in at least this many days (never sold counts when the stock itself is at least that old). */
  noSaleDays?: number
  /** Keep rows whose on-hand value is at least this, in base currency. Needs cost visibility; ignored without it. */
  minValueBase?: string
  /** Cost visibility for the caller. False (the default) strips value, and value-based filtering and ordering. */
  includeCost?: boolean
}

export type SlowStockReportRow = {
  productId: string
  /** Null on a per-product row. */
  warehouseId: string | null
  sku: string
  productName: string
  productType: ProductType
  categoryName: string | null
  supplierNames: string[]
  /** 'All' on a per-product row. */
  warehouseCode: string
  stockUnit: string
  qty: string
  /** Null when the caller cannot see costs. */
  valueBase: string | null
  oldestLayerAt: string | null
  oldestLayerAgeDays: number | null
  ageBand: string | null
  lastSaleAt: string | null
  daysSinceLastSale: number | null
  soldQtyInWindow: string
  ratePer30Days: string
  /** Null when nothing sold in the window (cover is unbounded). */
  monthsOfCover: string | null
}

export type SlowStockReport = {
  generatedAt: string
  rateWindowDays: number
  rateWindowDateFrom: string
  rateWindowDateTo: string
  perWarehouse: boolean
  costVisible: boolean
  rows: SlowStockReportRow[]
  pageInfo: PageInfo
  totals: {
    rows: number
    qty: string
    /** Null when the caller cannot see costs. */
    valueBase: string | null
  }
  /** Value (or, without cost visibility, row count) per age band over the filtered rows. */
  bandSummary: Array<{ band: string; rows: number; valueBase: string | null }>
  notices: string[]
}

// --- pure calculations -------------------------------------------------------------------------

export type SlowStockLayerInput = { remainingQty: DecimalInput; unitCostBase: DecimalInput; receivedAt: Date }

/** On-hand value of the open layers, exact. Layers with no remaining quantity contribute nothing. */
export function layersValue(layers: SlowStockLayerInput[]): Decimal {
  let total = new Prisma.Decimal(0)
  for (const layer of layers) {
    const remaining = toDecimal(layer.remainingQty)
    if (remaining.gt(0)) total = total.add(remaining.mul(toDecimal(layer.unitCostBase)))
  }
  return total
}

/** Receipt date of the oldest layer that still has stock, or null when none has. */
export function oldestOpenLayerAt(layers: SlowStockLayerInput[]): Date | null {
  let oldest: Date | null = null
  for (const layer of layers) {
    if (!toDecimal(layer.remainingQty).gt(0)) continue
    if (!oldest || layer.receivedAt.getTime() < oldest.getTime()) oldest = layer.receivedAt
  }
  return oldest
}

/** Whole UTC calendar days from `from` to `to`, never negative. */
export function ageInDays(from: Date, to: Date): number {
  return utcCalendarDayDelta(from, to)
}

export function ageBandFor(ageDays: number): string {
  let label: string = SLOW_STOCK_AGE_BANDS[0].label
  for (const band of SLOW_STOCK_AGE_BANDS) {
    if (ageDays >= band.minDays) label = band.label
  }
  return label
}

/** Units sold in the window expressed per 30 days: sold / windowDays * 30, exact then rounded to 4 dp. */
export function unitsPer30Days(soldQty: DecimalInput, windowDays: number = SLOW_STOCK_RATE_WINDOW_DAYS): Decimal {
  if (!Number.isInteger(windowDays) || windowDays <= 0) throw new Error(`Invalid rate window: ${windowDays}`)
  const sold = toDecimal(soldQty)
  if (sold.lt(0)) throw new Error('Sold quantity cannot be negative')
  return roundQuantity(sold.mul(SLOW_STOCK_RATE_PERIOD_DAYS).div(windowDays), 4)
}

/**
 * Months (30-day periods) of cover: on hand divided by the 30-day rate. Computed from the unrounded rate so the
 * shown rate and cover never disagree through double rounding. Null when nothing sold (unbounded cover).
 */
export function monthsOfCover(onHandQty: DecimalInput, soldQty: DecimalInput, windowDays: number = SLOW_STOCK_RATE_WINDOW_DAYS): Decimal | null {
  const sold = toDecimal(soldQty)
  if (!sold.gt(0)) return null
  const onHand = toDecimal(onHandQty)
  if (onHand.lt(0)) throw new Error('On-hand quantity cannot be negative')
  return roundQuantity(onHand.mul(windowDays).div(sold.mul(SLOW_STOCK_RATE_PERIOD_DAYS)), 1)
}

export function parseNonNegativeInteger(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** A non-negative decimal string, or undefined for anything else. */
export function parseMinValue(value: unknown): Decimal | undefined {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value.trim())) return undefined
  return new Prisma.Decimal(value.trim())
}

export type SlowStockFilterable = {
  oldestLayerAgeDays: number | null
  daysSinceLastSale: number | null
  valueBase: string | null
}

/** Applies the age, no-sale and minimum-value filters. Value filtering is skipped when the row carries no value. */
export function matchesSlowStockFilters(
  row: SlowStockFilterable,
  filters: { minAgeDays?: number; noSaleDays?: number; minValueBase?: Decimal },
): boolean {
  if (filters.minAgeDays != null && filters.minAgeDays > 0) {
    if (row.oldestLayerAgeDays == null || row.oldestLayerAgeDays < filters.minAgeDays) return false
  }
  if (filters.noSaleDays != null && filters.noSaleDays > 0) {
    if (row.daysSinceLastSale == null) {
      // Never sold: only evidence of a slow mover if the stock has itself been held that long.
      if (row.oldestLayerAgeDays == null || row.oldestLayerAgeDays < filters.noSaleDays) return false
    } else if (row.daysSinceLastSale < filters.noSaleDays) {
      return false
    }
  }
  if (filters.minValueBase && row.valueBase != null && toDecimal(row.valueBase).lt(filters.minValueBase)) return false
  return true
}

/** Highest value first (value at risk), then oldest, then SKU. Without cost visibility: oldest, then larger quantity, then SKU. */
export function compareSlowStockRows(costVisible: boolean) {
  return (a: SlowStockReportRow, b: SlowStockReportRow): number => {
    if (costVisible) {
      const byValue = toDecimal(b.valueBase).cmp(toDecimal(a.valueBase))
      if (byValue !== 0) return byValue
    }
    const byAge = (b.oldestLayerAgeDays ?? -1) - (a.oldestLayerAgeDays ?? -1)
    if (byAge !== 0) return byAge
    if (!costVisible) {
      const byQty = toDecimal(b.qty).cmp(toDecimal(a.qty))
      if (byQty !== 0) return byQty
    }
    return a.sku.localeCompare(b.sku) || a.warehouseCode.localeCompare(b.warehouseCode)
  }
}

// --- loader ------------------------------------------------------------------------------------

type FindManyDelegate = { findMany(args?: unknown): Promise<unknown[]> }
type GroupByDelegate = { groupBy(args: unknown): Promise<unknown[]> }

export type SlowStockReportClient = {
  stockLevel: FindManyDelegate
  costLayer: FindManyDelegate
  stockMovement: GroupByDelegate
}

export type SlowStockReportDeps = { client?: SlowStockReportClient; now?: () => Date }

type LevelRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
  product: {
    sku: string
    name: string
    type: ProductType
    stockUnit: string
    category: { name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  }
  warehouse: { code: string }
}

type LayerRow = { productId: string; warehouseId: string; remainingQty: DecimalInput; unitCostBase: DecimalInput; receivedAt: Date }

type SaleGroupRow = {
  productId: string
  fromWarehouseId: string | null
  _max?: { createdAt: Date | null }
  _sum?: { qty: DecimalInput }
}

type SaleEvidence = { lastSaleAt: Date | null; soldQty: Decimal }

function emptyEvidence(): SaleEvidence {
  return { lastSaleAt: null, soldQty: new Prisma.Decimal(0) }
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}

function slowStockMovementWhere(filters: SlowStockFilters, productTypeFilter: ReturnType<typeof directLayerProductTypeFilter>) {
  return {
    type: StockMovementType.SALE_DISPATCH,
    // Same demand rule as dead stock: warehouse-attributed dispatches, plus warehouse-less rows only when they are
    // the exact historical-import shape (a deleted warehouse nulls fromWarehouseId on ordinary dispatches).
    ...(filters.warehouseId
      ? { OR: [{ fromWarehouseId: filters.warehouseId }, HISTORICAL_IMPORT_MOVEMENT_SHAPE] }
      : { OR: [{ fromWarehouseId: { not: null } }, HISTORICAL_IMPORT_MOVEMENT_SHAPE] }),
    // Relation predicate (not an id list) so a large tenant cannot hit the bind-parameter cap.
    product: {
      ...productWhere(filters as StockPositionFilters, productTypeFilter),
      stockLevels: {
        some: { quantity: { gt: 0 }, ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}) },
      },
    },
  }
}

async function loadSaleEvidence(
  client: SlowStockReportClient,
  filters: SlowStockFilters,
  productTypeFilter: ReturnType<typeof directLayerProductTypeFilter>,
  windowFrom: Date,
): Promise<{ byProduct: Map<string, { byWarehouse: Map<string, SaleEvidence>; unattributed: SaleEvidence }> }> {
  const where = slowStockMovementWhere(filters, productTypeFilter)
  const orderBy = [{ productId: 'asc' }, { fromWarehouseId: 'asc' }]
  const lastSales = await client.stockMovement.groupBy({
    by: ['productId', 'fromWarehouseId'],
    where,
    _max: { createdAt: true },
    orderBy,
    take: SLOW_STOCK_SALE_GROUP_ROW_LIMIT + 1,
  }) as SaleGroupRow[]
  rejectOverLimit(lastSales, SLOW_STOCK_SALE_GROUP_ROW_LIMIT, 'last-sale scan')
  const windowSales = await client.stockMovement.groupBy({
    by: ['productId', 'fromWarehouseId'],
    where: { ...where, createdAt: { gte: windowFrom } },
    _sum: { qty: true },
    orderBy,
    take: SLOW_STOCK_SALE_GROUP_ROW_LIMIT + 1,
  }) as SaleGroupRow[]
  rejectOverLimit(windowSales, SLOW_STOCK_SALE_GROUP_ROW_LIMIT, 'sales-rate scan')

  const byProduct = new Map<string, { byWarehouse: Map<string, SaleEvidence>; unattributed: SaleEvidence }>()
  const slot = (productId: string, warehouseId: string | null): SaleEvidence => {
    let entry = byProduct.get(productId)
    if (!entry) {
      entry = { byWarehouse: new Map(), unattributed: emptyEvidence() }
      byProduct.set(productId, entry)
    }
    if (warehouseId == null) return entry.unattributed
    let evidence = entry.byWarehouse.get(warehouseId)
    if (!evidence) {
      evidence = emptyEvidence()
      entry.byWarehouse.set(warehouseId, evidence)
    }
    return evidence
  }
  for (const row of lastSales) {
    const evidence = slot(row.productId, row.fromWarehouseId)
    evidence.lastSaleAt = maxDate(evidence.lastSaleAt, row._max?.createdAt ?? null)
  }
  for (const row of windowSales) {
    const qty = toDecimal(row._sum?.qty)
    if (qty.lt(0)) throw new Error(`SALE_DISPATCH sum for product ${row.productId} is negative: ${qty.toString()}`)
    const evidence = slot(row.productId, row.fromWarehouseId)
    evidence.soldQty = evidence.soldQty.add(qty)
  }
  return { byProduct }
}

function combineEvidence(parts: SaleEvidence[]): SaleEvidence {
  return parts.reduce<SaleEvidence>((acc, part) => ({
    lastSaleAt: maxDate(acc.lastSaleAt, part.lastSaleAt),
    soldQty: acc.soldQty.add(part.soldQty),
  }), emptyEvidence())
}

export async function getSlowStockReport(
  filters: SlowStockFilters = {},
  options: { paginate?: boolean; deps?: SlowStockReportDeps } = { paginate: true },
): Promise<SlowStockReport> {
  const client = options.deps?.client ?? db as unknown as SlowStockReportClient
  const now = options.deps?.now?.() ?? new Date()
  const costVisible = filters.includeCost === true
  const perWarehouse = filters.perWarehouse === true
  const productTypeFilter = directLayerProductTypeFilter(filters as StockPositionFilters)
  const windowTo = startOfUtcDay(now)
  const windowFrom = subtractUtcDays(windowTo, SLOW_STOCK_RATE_WINDOW_DAYS - 1)
  const emptyReport = (): SlowStockReport => buildReport([], 0)
  const buildReport = (rows: SlowStockReportRow[], missingLayerRows: number): SlowStockReport => {
    const sorted = [...rows].sort(compareSlowStockRows(costVisible))
    const totalQty = sorted.reduce((sum, row) => sum.add(toDecimal(row.qty)), new Prisma.Decimal(0))
    const totalValue = sorted.reduce((sum, row) => sum.add(toDecimal(row.valueBase)), new Prisma.Decimal(0))
    const bands = new Map<string, { rows: number; value: Decimal }>()
    for (const row of sorted) {
      const key = row.ageBand ?? 'No open layer'
      const current = bands.get(key) ?? { rows: 0, value: new Prisma.Decimal(0) }
      bands.set(key, { rows: current.rows + 1, value: current.value.add(toDecimal(row.valueBase)) })
    }
    const bandOrder: string[] = [...SLOW_STOCK_AGE_BANDS.map((band) => band.label), 'No open layer']
    const paged = options.paginate === false
      ? { rows: sorted, pageInfo: pageInfo(sorted.length, 1, Math.max(sorted.length, 1)) }
      : paginate(sorted, filters)
    return {
      generatedAt: now.toISOString(),
      rateWindowDays: SLOW_STOCK_RATE_WINDOW_DAYS,
      rateWindowDateFrom: dateOnly(windowFrom),
      rateWindowDateTo: dateOnly(windowTo),
      perWarehouse,
      costVisible,
      rows: paged.rows,
      pageInfo: paged.pageInfo,
      totals: {
        rows: sorted.length,
        qty: roundQuantity(totalQty, 4).toString(),
        valueBase: costVisible ? roundQuantity(totalValue, 6).toString() : null,
      },
      bandSummary: bandOrder.flatMap((band) => {
        const entry = bands.get(band)
        return entry ? [{ band, rows: entry.rows, valueBase: costVisible ? roundQuantity(entry.value, 6).toString() : null }] : []
      }),
      notices: [
        `Positions are current on-hand stock (not as-of); quantity is StockLevel.quantity and value is the open FIFO cost layers at their current unit cost. Layer age is days since the oldest layer that still has stock was received.`,
        `Last sale is the latest SALE_DISPATCH movement ever recorded; the rate is SALE_DISPATCH units from ${dateOnly(windowFrom)} to ${dateOnly(windowTo)} (${SLOW_STOCK_RATE_WINDOW_DAYS} days) per 30 days. Returns are not netted off. Months of cover = on hand / rate, blank when nothing sold in the window.`,
        'Virtual KIT SKUs hold no stock of their own and are excluded; their components are reported from their own layers.',
        'This report only finds candidates. Judging net realisable value and posting any write-down is a manual stock adjustment.',
        ...(!costVisible ? ['Cost and value are hidden for your role; rows are ordered by layer age.'] : []),
        ...(costVisible && filters.minValueBase && parseMinValue(filters.minValueBase) == null ? ['The minimum value was not a valid number and was ignored.'] : []),
        ...(missingLayerRows > 0 ? [`${missingLayerRows.toLocaleString()} row(s) hold stock but no open cost layer; their value is 0 and their age is blank.`] : []),
      ],
    }
  }

  if (filters.productType === ProductType.KIT) {
    return emptyReport()
  }

  const levels = await (async () => {
    const found = await client.stockLevel.findMany({
      where: {
        quantity: { gt: 0 },
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
        product: productWhere(filters as StockPositionFilters, productTypeFilter),
      },
      select: {
        productId: true,
        warehouseId: true,
        quantity: true,
        product: {
          select: {
            sku: true,
            name: true,
            type: true,
            stockUnit: true,
            category: { select: { name: true } },
            supplierProducts: {
              ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
              select: { supplier: { select: { name: true } } },
              orderBy: { supplier: { name: 'asc' } },
            },
          },
        },
        warehouse: { select: { code: true } },
      },
      orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }],
      take: SLOW_STOCK_LEVEL_ROW_LIMIT + 1,
    }) as LevelRow[]
    rejectOverLimit(found, SLOW_STOCK_LEVEL_ROW_LIMIT, 'stock-level scan')
    return found
  })()
  if (levels.length === 0) return emptyReport()

  const layers = await (async () => {
    const found = await client.costLayer.findMany({
      where: {
        remainingQty: { gt: 0 },
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
        product: {
          ...productWhere(filters as StockPositionFilters, productTypeFilter),
          stockLevels: { some: { quantity: { gt: 0 }, ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}) } },
        },
      },
      select: { productId: true, warehouseId: true, remainingQty: true, unitCostBase: true, receivedAt: true },
      take: SLOW_STOCK_COST_LAYER_ROW_LIMIT + 1,
    }) as LayerRow[]
    rejectOverLimit(found, SLOW_STOCK_COST_LAYER_ROW_LIMIT, 'cost-layer scan')
    return found
  })()
  const evidence = await loadSaleEvidence(client, filters, productTypeFilter, windowFrom)

  const layersByStock = new Map<string, LayerRow[]>()
  for (const layer of layers) {
    const key = stockKey(layer.productId, layer.warehouseId)
    const list = layersByStock.get(key)
    if (list) list.push(layer)
    else layersByStock.set(key, [layer])
  }

  type Group = { levels: LevelRow[]; key: string }
  const groups = new Map<string, Group>()
  for (const level of levels) {
    const key = perWarehouse ? stockKey(level.productId, level.warehouseId) : level.productId
    const group = groups.get(key)
    if (group) group.levels.push(level)
    else groups.set(key, { key, levels: [level] })
  }

  const minValue = costVisible ? parseMinValue(filters.minValueBase) : undefined
  const minAgeDays = parseNonNegativeInteger(filters.minAgeDays)
  const noSaleDays = parseNonNegativeInteger(filters.noSaleDays)
  let missingLayerRows = 0
  const rows: SlowStockReportRow[] = []
  for (const group of groups.values()) {
    const first = group.levels[0]
    const groupLayers = group.levels.flatMap((level) => layersByStock.get(stockKey(level.productId, level.warehouseId)) ?? [])
    const qty = group.levels.reduce((sum, level) => sum.add(toDecimal(level.quantity)), new Prisma.Decimal(0))
    const value = layersValue(groupLayers)
    const oldest = oldestOpenLayerAt(groupLayers)
    if (!oldest) missingLayerRows += 1

    const productEvidence = evidence.byProduct.get(first.productId)
    const sale = productEvidence
      ? perWarehouse
        ? combineEvidence([productEvidence.byWarehouse.get(first.warehouseId) ?? emptyEvidence(), productEvidence.unattributed])
        : filters.warehouseId
          ? combineEvidence([productEvidence.byWarehouse.get(filters.warehouseId) ?? emptyEvidence(), productEvidence.unattributed])
          : combineEvidence([...productEvidence.byWarehouse.values(), productEvidence.unattributed])
      : emptyEvidence()

    const ageDays = oldest ? ageInDays(oldest, now) : null
    const daysSinceLastSale = sale.lastSaleAt ? ageInDays(sale.lastSaleAt, now) : null
    const cover = monthsOfCover(qty, sale.soldQty)
    const row: SlowStockReportRow = {
      productId: first.productId,
      warehouseId: perWarehouse ? first.warehouseId : null,
      sku: first.product.sku,
      productName: first.product.name,
      productType: first.product.type,
      categoryName: first.product.category?.name ?? null,
      supplierNames: supplierNames(first.product),
      warehouseCode: perWarehouse ? first.warehouse.code : filters.warehouseId ? first.warehouse.code : 'All',
      stockUnit: first.product.stockUnit,
      qty: roundQuantity(qty, 4).toString(),
      valueBase: costVisible ? roundQuantity(value, 6).toString() : null,
      oldestLayerAt: oldest ? oldest.toISOString() : null,
      oldestLayerAgeDays: ageDays,
      ageBand: ageDays == null ? null : ageBandFor(ageDays),
      lastSaleAt: sale.lastSaleAt ? sale.lastSaleAt.toISOString() : null,
      daysSinceLastSale,
      soldQtyInWindow: roundQuantity(sale.soldQty, 4).toString(),
      ratePer30Days: unitsPer30Days(sale.soldQty).toString(),
      monthsOfCover: cover ? cover.toString() : null,
    }
    if (matchesSlowStockFilters(row, { minAgeDays, noSaleDays, minValueBase: minValue })) rows.push(row)
  }
  return buildReport(rows, missingLayerRows)
}

export function emptySlowStockReportForSourceLimit(
  filters: SlowStockFilters,
  error: InventoryHealthSourceLimitError,
  now = new Date(),
): SlowStockReport {
  const windowTo = startOfUtcDay(now)
  return {
    generatedAt: now.toISOString(),
    rateWindowDays: SLOW_STOCK_RATE_WINDOW_DAYS,
    rateWindowDateFrom: dateOnly(subtractUtcDays(windowTo, SLOW_STOCK_RATE_WINDOW_DAYS - 1)),
    rateWindowDateTo: dateOnly(windowTo),
    perWarehouse: filters.perWarehouse === true,
    costVisible: filters.includeCost === true,
    rows: [],
    pageInfo: pageInfo(0, 1, clampPageSize(filters.pageSize)),
    totals: { rows: 0, qty: '0', valueBase: filters.includeCost === true ? '0' : null },
    bandSummary: [],
    notices: [sourceLimitNotice(error)],
  }
}
