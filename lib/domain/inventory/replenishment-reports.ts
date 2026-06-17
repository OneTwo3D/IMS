import { Prisma, ProductType, PurchaseOrderStatus, SalesOrderStatus, StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly, defaultUtcDateWindow, exclusiveEndOfUtcDay } from '@/lib/domain/math/date-window'
import { calculateDailyVelocity, type VelocitySaleInput } from '@/lib/domain/inventory/velocity'
import type { PageInfo, StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { REORDER_ELIGIBLE_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { SourceScanTooLargeError, assertSourceLimit } from '@/lib/security/source-scan-error'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const DEFAULT_DEMAND_WINDOW_DAYS = 90
const DEFAULT_LEAD_TIME_DAYS = 14

// Median (rounded to whole days) of a set of observed lead times, or null when empty.
function medianLeadTimeDays(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const raw = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return Math.max(1, Math.round(raw))
}
// Default replenishment cover: when a product drops to its reorder point, suggest
// ordering back up to roughly this many weeks of forecast demand ON TOP of the
// reorder point (an order-up-to level). Matches the retired forecast's 8-week lot.
const DEFAULT_TARGET_COVER_WEEKS = 8
// Upper bound (one year) so a crafted URL/CSV param can't request absurd order-up-to
// levels and generate runaway suggested quantities.
const MAX_TARGET_COVER_WEEKS = 52
const REPLENISHMENT_PRODUCT_TYPES: ProductType[] = [
  ProductType.SIMPLE,
  ProductType.VARIANT,
  ProductType.KIT,
  ProductType.BOM,
]
const OPEN_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.PO_SENT,
  PurchaseOrderStatus.SHIPPED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
]
const ACTIVE_SALES_ORDER_STATUSES: SalesOrderStatus[] = [
  SalesOrderStatus.DRAFT,
  SalesOrderStatus.PENDING_PAYMENT,
  SalesOrderStatus.ON_HOLD,
  SalesOrderStatus.PROCESSING,
  SalesOrderStatus.ALLOCATED,
  SalesOrderStatus.PICKING,
  SalesOrderStatus.PACKING,
  SalesOrderStatus.SHIPPED,
  SalesOrderStatus.DELIVERED,
  SalesOrderStatus.PARTIALLY_REFUNDED,
]

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type ReplenishmentReportClient = {
  product: FindManyDelegate
  stockLevel: FindManyDelegate
  stockMovement: FindManyDelegate
  purchaseOrderLine: FindManyDelegate
  purchaseReceipt: FindManyDelegate
  salesOrderLine: FindManyDelegate
  orderAllocation: FindManyDelegate
  shipmentLine: FindManyDelegate
  productionOrder: FindManyDelegate
  bomItem: FindManyDelegate
}

export type ReplenishmentReportDeps = {
  client?: ReplenishmentReportClient
  now?: () => Date
}

type SupplierProductRow = {
  supplierId: string
  supplierSku: string | null
  lastUnitCost: DecimalInput
  leadTimeDays: number | null
  supplier: { name: string }
}

type ProductPlanningRow = {
  id: string
  sku: string
  name: string
  type: ProductType
  stockUnit: string
  reorderPoint: DecimalInput | null
  reorderQty: DecimalInput | null
  safetyStockQty: DecimalInput | null
  leadTimeDays: number | null
  observedLeadTimeDays: number | null
  category: { id: string; name: string } | null
  preferredSupplierId: string | null
  preferredSupplier: { id: string; name: string } | null
  supplierProducts: SupplierProductRow[]
}

type StockLevelRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
  reservedQty: DecimalInput
  warehouse?: { code: string; name: string } | null
}

type SaleMovementRow = {
  productId: string
  qty: DecimalInput
  totalValueBase: DecimalInput | null
  createdAt: Date
  product: {
    sku: string
    name: string
    category: { id: string; name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  }
}

type OpenPoLineRow = {
  productId: string
  qty: DecimalInput
  qtyReceived: DecimalInput
  qtyReturned: DecimalInput
  po: {
    supplierId: string
    expectedDelivery: Date | null
    destinationWarehouseId: string | null
    supplier: { name: string }
  }
}

type BackorderSalesLineRow = {
  id: string
  orderId: string
  productId: string | null
  sku: string | null
  description: string
  qty: DecimalInput
  order: {
    orderNumber: string | null
    createdAt: Date
    expectedDelivery: Date | null
    status: SalesOrderStatus
  }
  product: {
    id: string
    sku: string
    name: string
    type: ProductType
    stockUnit: string
    category: { id: string; name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  } | null
}

type AllocationRow = {
  lineId: string
  qty: DecimalInput
}

type ShipmentLineRow = {
  lineId: string
  qty: DecimalInput
  shipment: { status: string }
}

type ProductionOrderRow = {
  id: string
  reference: string
  status: string
  warehouseId: string
  qtyPlanned: DecimalInput
  qtyProduced: DecimalInput
  scheduledAt: Date | null
  outputProduct: { sku: string; name: string }
  warehouse: { code: string; name: string }
  bom: {
    items: Array<{
      componentProductId: string
      qty: DecimalInput
      component: {
        id: string
        sku: string
        name: string
        type: ProductType
        stockUnit: string
        category: { id: string; name: string } | null
        supplierProducts: Array<{ supplier: { name: string } }>
      }
    }>
  }
}

export type ReorderReportRow = {
  productId: string
  sku: string
  productName: string
  productType: ProductType
  categoryName: string | null
  /**
   * For purchased products: the chosen supplier's id. For BOM (manufactured)
   * products: null — manufacturers come from the latest ProductionOrder, not
   * from the SupplierProduct catalog.
   */
  supplierId: string | null
  /**
   * Display label for the Supplier column. Purchased products: supplier name.
   * BOM products: "Manufactured by <name>" if the latest ProductionOrder for
   * the product has a manufacturer set, otherwise "Manufactured in-house".
   * Products with neither end up "Unassigned".
   */
  supplierName: string | null
  supplierSku: string | null
  stockUnit: string
  availableQty: string
  warehouseAvailabilityBreakdown: string
  inboundOpenPoQty: string
  averageDailyDemand: string
  leadTimeDays: number
  safetyStockQty: string
  reorderPoint: string
  configuredReorderQty: string
  suggestedReorderQty: string
  // Always computed (by demand volume) — never null. See computeAbcByVolume.
  abcClass: 'A' | 'B' | 'C'
  urgency: 'critical' | 'reorder' | 'watch'
  /**
   * Why this product needs replenishment. Sources are:
   *   - "Direct sales" — average daily demand > 0 from the velocity window
   *   - "BOM <parent SKU>" — listed once per parent BOM whose suggested
   *     reorder quantity drives component demand into this product
   * For finished goods (SIMPLE/VARIANT/KIT) the list is typically just
   * ["Direct sales"]. For raw materials it can include multiple BOM parents.
   */
  neededFor: string[]
}

export type ReorderReport = {
  generatedAt: string
  demandWindowDateFrom: string
  demandWindowDateTo: string
  rows: ReorderReportRow[]
  pageInfo: PageInfo
  totals: {
    availableQty: string
    inboundOpenPoQty: string
    suggestedReorderQty: string
  }
  notices: string[]
}

export type BackorderDemandReportRow = {
  productId: string
  sku: string
  productName: string
  productType: ProductType
  categoryName: string | null
  supplierNames: string[]
  stockUnit: string
  orderCount: number
  orderedQty: string
  committedQty: string
  allocatedQty: string
  backorderQty: string
  inboundOpenPoQty: string
  projectedFillDate: string | null
  oldestOrderAt: string
}

export type BackorderDemandReport = {
  generatedAt: string
  rows: BackorderDemandReportRow[]
  pageInfo: PageInfo
  totals: {
    orderedQty: string
    committedQty: string
    allocatedQty: string
    backorderQty: string
  }
  notices: string[]
}

export type ComponentShortageReportRow = {
  productId: string
  sku: string
  productName: string
  productType: ProductType
  categoryName: string | null
  supplierNames: string[]
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  stockUnit: string
  productionOrderCount: number
  requiredQty: string
  availableQty: string
  inboundOpenPoQty: string
  shortageQty: string
  earliestScheduledAt: string | null
  outputProducts: string[]
}

export type ComponentShortageReport = {
  generatedAt: string
  rows: ComponentShortageReportRow[]
  pageInfo: PageInfo
  totals: {
    requiredQty: string
    availableQty: string
    inboundOpenPoQty: string
    shortageQty: string
  }
  notices: string[]
}

function clientFromDeps(deps?: ReplenishmentReportDeps): ReplenishmentReportClient {
  return (deps?.client ?? db) as unknown as ReplenishmentReportClient
}

function nowFromDeps(deps?: ReplenishmentReportDeps): Date {
  return deps?.now?.() ?? new Date()
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(value as number)))
}

function pageInfo(totalRows: number, page: number | undefined, pageSize: number): PageInfo {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor(page ?? 1)))
  return {
    page: currentPage,
    pageSize,
    totalRows,
    totalPages,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1,
  }
}

function paginate<T>(rows: T[], page: number | undefined, pageSize: number, enabled: boolean): { rows: T[]; pageInfo: PageInfo } {
  const info = pageInfo(rows.length, page, pageSize)
  if (!enabled) return { rows, pageInfo: { ...info, page: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false } }
  const start = (info.page - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), pageInfo: info }
}

export function emptyReorderReportForSourceLimit(
  filters: StockPositionFilters,
  error: SourceScanTooLargeError,
  now = new Date(),
): ReorderReport {
  const demandDays = parsePositiveInteger(filters.thresholdDays, DEFAULT_DEMAND_WINDOW_DAYS)
  const window = demandWindow(now, demandDays)
  return {
    generatedAt: now.toISOString(),
    demandWindowDateFrom: dateOnly(window.dateFrom),
    demandWindowDateTo: dateOnly(window.dateTo),
    rows: [],
    pageInfo: pageInfo(0, filters.page, clampPageSize(filters.pageSize)),
    totals: { availableQty: '0', inboundOpenPoQty: '0', suggestedReorderQty: '0' },
    notices: [error.message],
  }
}

export function emptyBackorderDemandReportForSourceLimit(
  filters: StockPositionFilters,
  error: SourceScanTooLargeError,
  now = new Date(),
): BackorderDemandReport {
  return {
    generatedAt: now.toISOString(),
    rows: [],
    pageInfo: pageInfo(0, filters.page, clampPageSize(filters.pageSize)),
    totals: { orderedQty: '0', committedQty: '0', allocatedQty: '0', backorderQty: '0' },
    notices: [error.message],
  }
}

export function emptyComponentShortageReportForSourceLimit(
  filters: StockPositionFilters,
  error: SourceScanTooLargeError,
  now = new Date(),
): ComponentShortageReport {
  return {
    generatedAt: now.toISOString(),
    rows: [],
    pageInfo: pageInfo(0, filters.page, clampPageSize(filters.pageSize)),
    totals: { requiredQty: '0', availableQty: '0', inboundOpenPoQty: '0', shortageQty: '0' },
    notices: [error.message],
  }
}

function parsePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback
}

// Order-up-to suggested quantity. A product is only replenished once it has dropped
// below its reorder point (the trigger); the order then brings projected stock back
// up to an order-up-to level = reorderPoint + targetCoverQty (≈ targetCoverWeeks of
// forecast demand). A configured per-product reorder qty acts as a minimum lot size.
// When there's no demand (targetCoverQty = 0) this degrades to a plain top-up to the
// reorder point, preserving prior behaviour for non-moving stock.
function suggestedOrderUpToQty(
  reorderPoint: Prisma.Decimal,
  projectedAvailableQty: Prisma.Decimal,
  targetCoverQty: Prisma.Decimal,
  configuredReorderQty: Prisma.Decimal | null,
): Prisma.Decimal {
  if (projectedAvailableQty.gte(reorderPoint)) return new Prisma.Decimal(0)
  const orderUpToGap = reorderPoint.add(targetCoverQty).sub(projectedAvailableQty)
  if (orderUpToGap.lte(0)) return new Prisma.Decimal(0)
  return Prisma.Decimal.max(configuredReorderQty ?? new Prisma.Decimal(0), orderUpToGap)
}

function quantityString(value: DecimalInput): string {
  return roundQuantity(value, 4).toString()
}

// audit-5f19: the report deals in whole stockable units, so quantity columns render
// as integers. Stock/threshold figures round to the nearest unit; the suggested
// order quantity rounds UP (you must order enough whole units to cover the need).
function integerQuantityString(value: DecimalInput): string {
  return roundQuantity(value, 0).toString()
}

function ceilInteger(value: DecimalInput): Prisma.Decimal {
  return toDecimal(value).ceil()
}

function productWhere(filters: StockPositionFilters) {
  const filteredType = filters.productType && REPLENISHMENT_PRODUCT_TYPES.includes(filters.productType)
    ? filters.productType
    : undefined
  return {
    lifecycleStatus: { in: REORDER_ELIGIBLE_PRODUCT_STATUSES },
    type: filteredType ?? { in: REPLENISHMENT_PRODUCT_TYPES },
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.supplierId
      ? {
        OR: [
          { preferredSupplierId: filters.supplierId },
          { supplierProducts: { some: { supplierId: filters.supplierId } } },
        ],
      }
      : {}),
  }
}

function componentMatchesFilters(
  component: {
    type: ProductType
    category: { id: string; name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  },
  filters: StockPositionFilters,
): boolean {
  if (!REPLENISHMENT_PRODUCT_TYPES.includes(component.type)) return false
  if (filters.productType && (!REPLENISHMENT_PRODUCT_TYPES.includes(filters.productType) || component.type !== filters.productType)) return false
  if (filters.categoryId && component.category?.id !== filters.categoryId) return false
  if (filters.supplierId && component.supplierProducts.length === 0) return false
  return true
}

function supplierNames(product: { supplierProducts: Array<{ supplier: { name: string } }> }): string[] {
  return product.supplierProducts.map((row) => row.supplier.name)
}

// audit-dxcz: ABC class is computed dynamically by demand volume rather than read
// from the stored product.abcClass field (which is unset for most products). A
// Pareto split on units sold in the demand window — top 80% of movement = A, next
// 15% = B, the rest (incl. zero-movement) = C — keeps the classification meaningful
// for both real sales and historical imports. Imports carry zero unit cost, so a
// value-weighted basis would read 0; units stay reliable. Ties break by productId
// so the A/B/C boundaries are deterministic across runs.
function computeAbcByVolume(unitsByProduct: Map<string, Prisma.Decimal>): Map<string, 'A' | 'B' | 'C'> {
  const ranked = [...unitsByProduct.entries()]
    .filter(([, units]) => units.gt(0))
    // Descending by units; ties break by a binary productId compare (not
    // locale-sensitive) so the A/B/C boundaries are deterministic across runs.
    .sort((a, b) => b[1].cmp(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const total = ranked.reduce((sum, [, units]) => sum.add(units), new Prisma.Decimal(0))
  const result = new Map<string, 'A' | 'B' | 'C'>()
  if (total.lte(0)) return result
  // Classify each SKU by the cumulative share of the SKUs ranked ABOVE it — i.e.
  // BEFORE adding its own units. The run of SKUs that builds up the first 80% of
  // movement is A, up to 95% is B, the rest is C. Measuring the share "before"
  // means the single largest mover (or any SKU that alone exceeds a band) still
  // lands in A, instead of being pushed to C by its own contribution.
  let cumulative = new Prisma.Decimal(0)
  for (const [productId, units] of ranked) {
    const shareBefore = cumulative.div(total)
    result.set(productId, shareBefore.lt(0.8) ? 'A' : shareBefore.lt(0.95) ? 'B' : 'C')
    cumulative = cumulative.add(units)
  }
  return result
}

function stockKey(productId: string, warehouseId: string | null | undefined): string {
  return `${productId}:${warehouseId ?? 'all'}`
}

function addToMap(map: Map<string, Prisma.Decimal>, key: string, value: DecimalInput): void {
  map.set(key, (map.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(value)))
}

function availabilityBreakdownByProduct(stockLevels: StockLevelRow[]): Map<string, string> {
  const byProductWarehouse = new Map<string, Prisma.Decimal>()
  // audit-ghuo: label warehouses by name (then code) — not the raw cuid id.
  const labelByWarehouseId = new Map<string, string>()
  for (const level of stockLevels) {
    addToMap(byProductWarehouse, stockKey(level.productId, level.warehouseId), toDecimal(level.quantity).sub(toDecimal(level.reservedQty)))
    if (!labelByWarehouseId.has(level.warehouseId)) {
      labelByWarehouseId.set(level.warehouseId, level.warehouse?.name?.trim() || level.warehouse?.code?.trim() || level.warehouseId)
    }
  }
  const byProduct = new Map<string, Array<{ label: string; warehouseId: string; available: Prisma.Decimal }>>()
  for (const [key, available] of byProductWarehouse.entries()) {
    const separator = key.lastIndexOf(':')
    const productId = key.slice(0, separator)
    const warehouseId = key.slice(separator + 1)
    const rows = byProduct.get(productId) ?? []
    rows.push({ label: labelByWarehouseId.get(warehouseId) ?? warehouseId, warehouseId, available })
    byProduct.set(productId, rows)
  }
  return new Map([...byProduct.entries()].map(([productId, rows]) => [
    productId,
    rows
      // Sort by label (explicit locale for cross-environment determinism); warehouseId
      // breaks ties so two same-named warehouses keep a stable order.
      .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || a.warehouseId.localeCompare(b.warehouseId))
      // Whole units, consistent with the integer Available column (audit-5f19).
      .map((row) => `${row.label}: ${integerQuantityString(row.available)}`)
      .join('; '),
  ]))
}

async function loadOpenPoLines(client: ReplenishmentReportClient, filters: StockPositionFilters): Promise<OpenPoLineRow[]> {
  const lines = await client.purchaseOrderLine.findMany({
    where: {
      po: {
        status: { in: OPEN_PO_STATUSES },
        ...(filters.warehouseId ? { destinationWarehouseId: filters.warehouseId } : {}),
      },
      product: productWhere(filters),
    },
    select: {
      productId: true,
      qty: true,
      qtyReceived: true,
      qtyReturned: true,
      po: {
        select: {
          supplierId: true,
          expectedDelivery: true,
          destinationWarehouseId: true,
          supplier: { select: { name: true } },
        },
      },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as OpenPoLineRow[]
  assertSourceLimit(lines.length, SOURCE_ROW_LIMIT, 'Replenishment open PO source rows')
  return lines
}

function inboundOpenPoByProduct(lines: OpenPoLineRow[]): Map<string, Prisma.Decimal> {
  const inbound = new Map<string, Prisma.Decimal>()
  for (const line of lines) {
    const qty = toDecimal(line.qty).sub(toDecimal(line.qtyReceived)).sub(toDecimal(line.qtyReturned))
    if (qty.gt(0)) addToMap(inbound, line.productId, qty)
  }
  return inbound
}

function inboundOpenPoByStock(lines: OpenPoLineRow[]): Map<string, Prisma.Decimal> {
  const inbound = new Map<string, Prisma.Decimal>()
  for (const line of lines) {
    const qty = toDecimal(line.qty).sub(toDecimal(line.qtyReceived)).sub(toDecimal(line.qtyReturned))
    if (qty.gt(0)) addToMap(inbound, stockKey(line.productId, line.po.destinationWarehouseId), qty)
  }
  return inbound
}

function earliestInboundDateByProduct(lines: OpenPoLineRow[]): Map<string, string> {
  const dates = new Map<string, Date>()
  for (const line of lines) {
    const qty = toDecimal(line.qty).sub(toDecimal(line.qtyReceived)).sub(toDecimal(line.qtyReturned))
    if (qty.lte(0) || !line.po.expectedDelivery) continue
    const existing = dates.get(line.productId)
    if (!existing || line.po.expectedDelivery.getTime() < existing.getTime()) dates.set(line.productId, line.po.expectedDelivery)
  }
  return new Map([...dates.entries()].map(([key, value]) => [key, dateOnly(value)]))
}

function demandWindow(now: Date, days: number): { dateFrom: Date; dateTo: Date; dateToExclusive: Date } {
  const window = defaultUtcDateWindow(now, days)
  return { ...window, dateToExclusive: exclusiveEndOfUtcDay(window.dateTo) }
}

async function loadVelocityRows(client: ReplenishmentReportClient, filters: StockPositionFilters, window: { dateFrom: Date; dateTo: Date; dateToExclusive: Date }): Promise<VelocitySaleInput[]> {
  const movements = await client.stockMovement.findMany({
    where: {
      type: StockMovementType.SALE_DISPATCH,
      createdAt: { gte: window.dateFrom, lt: window.dateToExclusive },
      product: productWhere(filters),
    },
    select: {
      productId: true,
      qty: true,
      totalValueBase: true,
      createdAt: true,
      product: {
        select: {
          sku: true,
          name: true,
          category: { select: { id: true, name: true } },
          supplierProducts: {
            ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
            select: { supplier: { select: { name: true } } },
          },
        },
      },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as SaleMovementRow[]
  assertSourceLimit(movements.length, SOURCE_ROW_LIMIT, 'Replenishment velocity source rows')

  return movements.map((movement) => ({
    productId: movement.productId,
    sku: movement.product.sku,
    productName: movement.product.name,
    categoryName: movement.product.category?.name ?? null,
    supplierNames: supplierNames(movement.product),
    qty: movement.qty,
    cogsBase: movement.totalValueBase ?? 0,
    occurredAt: movement.createdAt,
  }))
}

async function loadStockLevels(client: ReplenishmentReportClient, filters: StockPositionFilters): Promise<StockLevelRow[]> {
  const levels = await client.stockLevel.findMany({
    where: {
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      product: productWhere(filters),
    },
    select: {
      productId: true,
      warehouseId: true,
      quantity: true,
      reservedQty: true,
      warehouse: { select: { code: true, name: true } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as StockLevelRow[]
  assertSourceLimit(levels.length, SOURCE_ROW_LIMIT, 'Replenishment stock-level source rows')
  return levels
}

export async function getReorderReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: ReplenishmentReportDeps } = {},
): Promise<ReorderReport> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const demandDays = parsePositiveInteger(filters.thresholdDays, DEFAULT_DEMAND_WINDOW_DAYS)
  const targetCoverWeeks = Math.min(
    MAX_TARGET_COVER_WEEKS,
    parsePositiveInteger(filters.targetCoverWeeks, DEFAULT_TARGET_COVER_WEEKS),
  )
  // audit-5f19: by default only show products needing at least one unit reordered.
  // includeZero (the "show all products" toggle / CSV export) keeps every candidate,
  // including those with a zero suggested quantity.
  const includeAll = filters.includeZero === true
  const window = demandWindow(generatedAt, demandDays)
  const [products, stockLevels, velocityInputs, openPoLines, latestMoRows, bomItemRows] = await Promise.all([
    client.product.findMany({
      where: productWhere(filters),
      select: {
        id: true,
        sku: true,
        name: true,
        type: true,
        stockUnit: true,
        reorderPoint: true,
        reorderQty: true,
        safetyStockQty: true,
        leadTimeDays: true,
        observedLeadTimeDays: true,
        category: { select: { id: true, name: true } },
        preferredSupplierId: true,
        preferredSupplier: { select: { id: true, name: true } },
        supplierProducts: {
          ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
          select: {
            supplierId: true,
            supplierSku: true,
            lastUnitCost: true,
            leadTimeDays: true,
            supplier: { select: { name: true } },
          },
          orderBy: [{ lastUnitCost: 'asc' }, { updatedAt: 'desc' }],
        },
      },
      orderBy: { sku: 'asc' },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<ProductPlanningRow[]>,
    loadStockLevels(client, filters),
    loadVelocityRows(client, filters, window),
    loadOpenPoLines(client, filters),
    // Latest production order per BOM product, used both for the "Manufactured
    // by <name>" supplier-column label and as the warehouse fallback when
    // createReorderMOs creates a draft MO. Ordering is per-(outputProductId,
    // createdAt desc) and we keep only the first row seen per product.
    client.productionOrder.findMany({
      select: {
        outputProductId: true,
        warehouseId: true,
        manufacturerId: true,
        manufacturer: { select: { name: true } },
        outputProduct: { select: { type: true } },
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }],
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<Array<{
      outputProductId: string
      warehouseId: string
      manufacturerId: string | null
      manufacturer: { name: string } | null
      outputProduct: { type: ProductType }
      createdAt: Date
    }>>,
    // BOM-item rows for every active BOM whose parent is BOM-typed. The map
    // built from these drives component-demand expansion: when a BOM parent
    // needs N units, each of its components needs N × bomItem.qty more on
    // top of its own direct (sales-driven) demand.
    client.bomItem.findMany({
      where: { bom: { active: true }, parentProduct: { type: ProductType.BOM } },
      select: {
        parentProductId: true,
        componentProductId: true,
        qty: true,
      },
    }) as Promise<Array<{
      parentProductId: string
      componentProductId: string
      qty: DecimalInput
    }>>,
  ])
  assertSourceLimit(products.length, SOURCE_ROW_LIMIT, 'Replenishment product source rows')

  const availableByProduct = new Map<string, Prisma.Decimal>()
  for (const level of stockLevels) {
    addToMap(availableByProduct, level.productId, toDecimal(level.quantity).sub(toDecimal(level.reservedQty)))
  }
  const warehouseBreakdown = availabilityBreakdownByProduct(stockLevels)
  const inboundByProduct = inboundOpenPoByProduct(openPoLines)
  const velocityByProduct = new Map(calculateDailyVelocity(velocityInputs, window).map((row) => [row.productId, row]))
  const defaultLeadTimeSkus: string[] = []
  const derivedLeadTimeSkus: string[] = []

  // audit-ojp5: smarter lead-time default for products with no manual override and
  // no observed P95 (no PO history). Instead of jumping straight to the flat
  // DEFAULT_LEAD_TIME_DAYS, fall back to the MEDIAN observed lead time of the
  // product's supplier, then its category, derived from the catalogue rows already
  // loaded for this report. So a brand-new SKU inherits a realistic lead time from
  // its peers and can surface in the report, instead of always assuming 14 days.
  // (Computed from the loaded candidate set — no extra query; under a supplier/
  // category filter the medians are naturally scoped to that supplier/category.)
  const observedBySupplier = new Map<string, number[]>()
  const observedByCategory = new Map<string, number[]>()
  for (const product of products) {
    if (product.observedLeadTimeDays == null) continue
    const observed = product.observedLeadTimeDays
    for (const sp of product.supplierProducts) {
      const list = observedBySupplier.get(sp.supplierId) ?? []
      list.push(observed)
      observedBySupplier.set(sp.supplierId, list)
    }
    const categoryId = product.category?.id
    if (categoryId) {
      const list = observedByCategory.get(categoryId) ?? []
      list.push(observed)
      observedByCategory.set(categoryId, list)
    }
  }
  const supplierMedianLeadTime = new Map([...observedBySupplier].map(([k, v]) => [k, medianLeadTimeDays(v)!]))
  const categoryMedianLeadTime = new Map([...observedByCategory].map(([k, v]) => [k, medianLeadTimeDays(v)!]))

  // audit-dxcz: rank products by total units dispatched in the demand window, then
  // split into A/B/C with computeAbcByVolume. Reuses the velocity rows already loaded
  // above — no extra query, so the report's source-row limits still bound the work.
  const unitsByProduct = new Map<string, Prisma.Decimal>()
  for (const input of velocityInputs) {
    addToMap(unitsByProduct, input.productId, toDecimal(input.qty))
  }
  const abcByProduct = computeAbcByVolume(unitsByProduct)

  // Latest production order per product (most recent createdAt). Used to
  // derive the manufacturer label for BOM rows and as the warehouse fallback
  // when createReorderMOs creates a draft MO. Picked off the pre-sorted
  // findMany result so the first row seen per outputProductId wins.
  const latestMoByProduct = new Map<string, { manufacturerName: string | null; warehouseId: string }>()
  for (const row of latestMoRows) {
    if (!latestMoByProduct.has(row.outputProductId)) {
      latestMoByProduct.set(row.outputProductId, {
        manufacturerName: row.manufacturer?.name ?? null,
        warehouseId: row.warehouseId,
      })
    }
  }
  // BOM-item rows keyed by parent (the BOM-typed finished good). When that
  // parent needs replenishment we walk its items to add component demand.
  const bomItemsByParent = new Map<string, Array<{ componentProductId: string; qty: Prisma.Decimal }>>()
  for (const item of bomItemRows) {
    const list = bomItemsByParent.get(item.parentProductId) ?? []
    list.push({ componentProductId: item.componentProductId, qty: toDecimal(item.qty) })
    bomItemsByParent.set(item.parentProductId, list)
  }

  type Candidate = {
    product: ProductPlanningRow
    displaySupplier: { id: string; name: string; sku: string | null } | null
    availableQty: Prisma.Decimal
    inboundOpenPoQty: Prisma.Decimal
    projectedAvailableQty: Prisma.Decimal
    averageDailyDemand: Prisma.Decimal
    leadTimeDays: number
    safetyStockQty: Prisma.Decimal
    /** Reorder point before BOM-driven demand is folded in. */
    baseReorderPoint: Prisma.Decimal
    configuredReorderQty: Prisma.Decimal | null
    /** Weeks-of-supply cover (targetCoverWeeks × 7 × avgDailyDemand) added on top
     * of the reorder point to form the order-up-to level. */
    targetCoverQty: Prisma.Decimal
    abcClass: ReorderReportRow['abcClass']
  }
  const candidatesByProductId = new Map<string, Candidate>()
  for (const product of products) {
    const configuredReorderQty = product.reorderQty == null ? null : toDecimal(product.reorderQty)
    // reorderQty <= 0 used to be an immediate opt-out, but raw materials that
    // are pure components often never have one set. We still want them to
    // appear when a BOM parent drives demand into them, so the actual drop
    // happens in phase 2 once we know whether componentDemand fired.
    const preferredCatalog = product.preferredSupplierId
      ? product.supplierProducts.find((supplierProduct) => supplierProduct.supplierId === product.preferredSupplierId)
      : null
    const supplier = preferredCatalog ?? product.supplierProducts[0] ?? null
    const displaySupplier = supplier
      ? { id: supplier.supplierId, name: supplier.supplier.name, sku: supplier.supplierSku }
      : product.preferredSupplier
      ? { id: product.preferredSupplier.id, name: product.preferredSupplier.name, sku: null }
      : null
    const availableQty = availableByProduct.get(product.id) ?? new Prisma.Decimal(0)
    const inboundOpenPoQty = inboundByProduct.get(product.id) ?? new Prisma.Decimal(0)
    const projectedAvailableQty = availableQty.add(inboundOpenPoQty)
    const averageDailyDemand = toDecimal(velocityByProduct.get(product.id)?.dailyQtyVelocity ?? 0)
    // Product-level effective lead time. Precedence:
    //   1. manual override (Product.leadTimeDays)
    //   2. auto P95 from PO receipts (Product.observedLeadTimeDays, cron-maintained)
    //   3. smarter default for no-history products: supplier median, then category
    //      median, of observed lead times (audit-ojp5)
    //   4. flat DEFAULT_LEAD_TIME_DAYS as the final floor
    let leadTimeDays = product.leadTimeDays ?? product.observedLeadTimeDays ?? null
    if (leadTimeDays == null) {
      const supplierId = product.preferredSupplierId ?? product.supplierProducts[0]?.supplierId ?? null
      const supplierMedian = supplierId ? supplierMedianLeadTime.get(supplierId) ?? null : null
      const categoryMedian = product.category?.id ? categoryMedianLeadTime.get(product.category.id) ?? null : null
      const derived = supplierMedian ?? categoryMedian
      if (derived != null) {
        leadTimeDays = derived
        derivedLeadTimeSkus.push(product.sku)
      } else {
        leadTimeDays = DEFAULT_LEAD_TIME_DAYS
        defaultLeadTimeSkus.push(product.sku)
      }
    }
    const safetyStockQty = toDecimal(product.safetyStockQty ?? 0)
    const demandDuringLeadTime = averageDailyDemand.mul(leadTimeDays)
    const computedReorderPoint = demandDuringLeadTime.add(safetyStockQty)
    const baseReorderPoint = product.reorderPoint == null ? computedReorderPoint : toDecimal(product.reorderPoint)
    const targetCoverQty = averageDailyDemand.mul(new Prisma.Decimal(targetCoverWeeks).mul(7))
    const abcClass = abcByProduct.get(product.id) ?? 'C'
    candidatesByProductId.set(product.id, {
      product,
      displaySupplier,
      availableQty,
      inboundOpenPoQty,
      projectedAvailableQty,
      averageDailyDemand,
      leadTimeDays,
      safetyStockQty,
      baseReorderPoint,
      configuredReorderQty,
      targetCoverQty,
      abcClass,
    })
  }

  // Phase 1: for every BOM candidate that itself needs replenishment, derive
  // the additional demand its components inherit (suggestedReorderQty × bomItem.qty).
  //
  // Multi-level BOMs: a BOM's component can itself be a BOM, so demand must
  // cascade down. We process BOM candidates TOP-DOWN in topological order
  // (a parent BOM before any component BOM it drives) so that when we explode a
  // component BOM, the demand inherited from its parent(s) is already folded into
  // its reorder point — otherwise nested sub-components are understated. Ties
  // break by SKU for deterministic accumulation; any cycle remnant (BOMs should
  // be acyclic) is appended in SKU order so it's still processed once.
  const componentDemand = new Map<string, Prisma.Decimal>()
  const componentNeededFor = new Map<string, string[]>()
  const orderedCandidates = [...candidatesByProductId.values()].sort((a, b) => a.product.sku.localeCompare(b.product.sku))

  const bomCandidateIds = new Set(
    orderedCandidates.filter((c) => c.product.type === ProductType.BOM).map((c) => c.product.id),
  )
  // Adjacency (parent BOM → component BOMs) + in-degrees for a topological sort.
  const childBomsByParent = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const id of bomCandidateIds) indegree.set(id, 0)
  for (const parentId of bomCandidateIds) {
    const childBoms = [
      ...new Set(
        (bomItemsByParent.get(parentId) ?? [])
          .map((item) => item.componentProductId)
          .filter((cid) => bomCandidateIds.has(cid)),
      ),
    ]
    childBomsByParent.set(parentId, childBoms)
    for (const cid of childBoms) indegree.set(cid, (indegree.get(cid) ?? 0) + 1)
  }
  // Kahn topological order over BOM candidates (parents before components).
  const bomCandidateById = new Map(orderedCandidates.filter((c) => bomCandidateIds.has(c.product.id)).map((c) => [c.product.id, c]))
  const ready = orderedCandidates.filter((c) => bomCandidateIds.has(c.product.id) && (indegree.get(c.product.id) ?? 0) === 0).map((c) => c.product.id)
  const topoOrder: string[] = []
  const placed = new Set<string>()
  while (ready.length > 0) {
    const id = ready.shift()!
    if (placed.has(id)) continue
    placed.add(id)
    topoOrder.push(id)
    const children = (childBomsByParent.get(id) ?? []).slice().sort((a, b) =>
      (bomCandidateById.get(a)?.product.sku ?? '').localeCompare(bomCandidateById.get(b)?.product.sku ?? ''),
    )
    for (const cid of children) {
      indegree.set(cid, (indegree.get(cid) ?? 0) - 1)
      if ((indegree.get(cid) ?? 0) === 0) ready.push(cid)
    }
  }
  // Defensive: append any BOM not reached (cycle) so it's still exploded once.
  for (const c of orderedCandidates) {
    if (bomCandidateIds.has(c.product.id) && !placed.has(c.product.id)) topoOrder.push(c.product.id)
  }

  for (const productId of topoOrder) {
    const candidate = bomCandidateById.get(productId)
    if (!candidate) continue
    // Fold demand inherited from parent BOM(s) into this BOM's reorder point
    // BEFORE computing how many to build, so a sub-assembly driven by a parent
    // explodes the right quantity to ITS components. Ceil to whole units so
    // component demand matches the integer build quantity the parent row / a
    // draft MO would create.
    const inheritedDemand = componentDemand.get(productId) ?? new Prisma.Decimal(0)
    const ownSuggested = ceilInteger(suggestedOrderUpToQty(
      candidate.baseReorderPoint.add(inheritedDemand),
      candidate.projectedAvailableQty,
      candidate.targetCoverQty,
      candidate.configuredReorderQty,
    ))
    if (ownSuggested.lte(0)) continue
    const bomItems = bomItemsByParent.get(productId) ?? []
    for (const item of bomItems) {
      const extra = ownSuggested.mul(item.qty)
      const existing = componentDemand.get(item.componentProductId) ?? new Prisma.Decimal(0)
      componentDemand.set(item.componentProductId, existing.add(extra))
      const tags = componentNeededFor.get(item.componentProductId) ?? []
      tags.push(`BOM ${candidate.product.sku}`)
      componentNeededFor.set(item.componentProductId, tags)
    }
  }

  // Phase 2: build the final rows, folding any BOM-driven demand into the
  // candidate's reorder point and (re)computing the suggested quantity and
  // urgency band. Filter products that still don't need replenishment.
  const rows: ReorderReportRow[] = []
  for (const candidate of candidatesByProductId.values()) {
    const extraDemand = componentDemand.get(candidate.product.id) ?? new Prisma.Decimal(0)
    // Opt-out: reorderQty <= 0 means the operator explicitly told us not to
    // replenish this product, UNLESS a BOM parent is now driving demand into
    // it. In that case we still surface the shortfall so the operator can
    // act, even though no direct reorder cadence was configured.
    if (candidate.configuredReorderQty?.lte(0) && extraDemand.lte(0)) continue
    const reorderPoint = candidate.baseReorderPoint.add(extraDemand)
    // Round the order quantity UP to whole units — you can't order a fraction, and
    // it must cover the need. This integer drives the row, the totals, the "needs
    // reorder" filter, the sort, and downstream draft-PO creation.
    const suggestedReorderQty = ceilInteger(suggestedOrderUpToQty(
      reorderPoint,
      candidate.projectedAvailableQty,
      candidate.targetCoverQty,
      candidate.configuredReorderQty,
    ))
    // Default view shows only products needing at least one unit; the show-all
    // toggle / CSV export (includeAll) keeps zero-reorder products too.
    if (!includeAll && suggestedReorderQty.lt(1)) continue
    const urgency: ReorderReportRow['urgency'] = candidate.projectedAvailableQty.lte(0)
      ? 'critical'
      : candidate.projectedAvailableQty.lte(reorderPoint)
        ? 'reorder'
        : 'watch'

    // Supplier-column label policy: BOM rows surface manufacturer info from
    // the latest ProductionOrder; everything else shows the resolved supplier.
    const isBom = candidate.product.type === ProductType.BOM
    const mfg = isBom ? latestMoByProduct.get(candidate.product.id) : undefined
    const supplierName = isBom
      ? (mfg?.manufacturerName ? `Manufactured by ${mfg.manufacturerName}` : 'Manufactured in-house')
      : candidate.displaySupplier?.name ?? null
    const supplierId = isBom ? null : candidate.displaySupplier?.id ?? null
    const supplierSku = isBom ? null : candidate.displaySupplier?.sku ?? null

    // neededFor explains why this product is in the report. Direct sales
    // appears when there is any sales-driven daily demand; BOM tags come
    // from componentNeededFor (built above, may be empty for finished goods).
    const neededFor: string[] = []
    if (candidate.averageDailyDemand.gt(0)) neededFor.push('Direct sales')
    const bomTags = componentNeededFor.get(candidate.product.id)
    if (bomTags) {
      // Stable-sort + dedupe so the column is deterministic across runs.
      const uniqueBoms = [...new Set(bomTags)].sort()
      neededFor.push(...uniqueBoms)
    }
    // If neither direct sales nor BOM demand drives this row we still tag it
    // ("Stock policy") so the column never renders empty when a row is shown.
    if (neededFor.length === 0) neededFor.push('Stock policy')

    rows.push({
      productId: candidate.product.id,
      sku: candidate.product.sku,
      productName: candidate.product.name,
      productType: candidate.product.type,
      categoryName: candidate.product.category?.name ?? null,
      supplierId,
      supplierName,
      supplierSku,
      stockUnit: candidate.product.stockUnit,
      availableQty: integerQuantityString(candidate.availableQty),
      warehouseAvailabilityBreakdown: warehouseBreakdown.get(candidate.product.id) ?? '',
      inboundOpenPoQty: integerQuantityString(candidate.inboundOpenPoQty),
      // Daily demand is a rate, not a stock quantity — keep its fractional precision.
      averageDailyDemand: quantityString(candidate.averageDailyDemand),
      leadTimeDays: candidate.leadTimeDays,
      safetyStockQty: integerQuantityString(candidate.safetyStockQty),
      reorderPoint: integerQuantityString(reorderPoint),
      configuredReorderQty: integerQuantityString(candidate.configuredReorderQty ?? 0),
      suggestedReorderQty: suggestedReorderQty.toString(),
      abcClass: candidate.abcClass,
      urgency,
      neededFor,
    })
  }

  // audit-00o7: reorder-only filters (ABC class / urgency / text search) brought
  // over from the retired forecast page. Applied BEFORE sort/totals/pagination so
  // the summary cards, row count, pagination, and CSV all reflect the filtered set.
  const searchQuery = filters.search?.trim().toLowerCase()
  const displayRows = rows.filter((row) => {
    if (filters.abcClass && row.abcClass !== filters.abcClass) return false
    if (filters.urgency && row.urgency !== filters.urgency) return false
    if (searchQuery) {
      const haystack = `${row.sku} ${row.productName} ${row.supplierName ?? ''}`.toLowerCase()
      if (!haystack.includes(searchQuery)) return false
    }
    return true
  })

  // audit-5f19: highest suggested reorder quantity first so the products needing the
  // most reordering surface at the top; ties fall back to urgency then SKU.
  displayRows.sort((a, b) => {
    const urgencyOrder = { critical: 0, reorder: 1, watch: 2 }
    return toDecimal(b.suggestedReorderQty).cmp(toDecimal(a.suggestedReorderQty))
      || urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
      || a.sku.localeCompare(b.sku)
  })
  const totals = displayRows.reduce(
    (total, row) => ({
      availableQty: total.availableQty.add(row.availableQty),
      inboundOpenPoQty: total.inboundOpenPoQty.add(row.inboundOpenPoQty),
      suggestedReorderQty: total.suggestedReorderQty.add(row.suggestedReorderQty),
    }),
    { availableQty: new Prisma.Decimal(0), inboundOpenPoQty: new Prisma.Decimal(0), suggestedReorderQty: new Prisma.Decimal(0) },
  )
  const pageSize = clampPageSize(filters.pageSize)
  const paged = paginate(displayRows, filters.page, pageSize, options.paginate !== false)
  return {
    generatedAt: generatedAt.toISOString(),
    demandWindowDateFrom: dateOnly(window.dateFrom),
    demandWindowDateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      availableQty: integerQuantityString(totals.availableQty),
      inboundOpenPoQty: integerQuantityString(totals.inboundOpenPoQty),
      suggestedReorderQty: integerQuantityString(totals.suggestedReorderQty),
    },
    notices: [
      `Demand velocity uses SALE_DISPATCH movements from ${dateOnly(window.dateFrom)} to ${dateOnly(window.dateTo)}; returns are not netted.`,
      'Lead time uses the product manual override first, the auto P95 derived from PO receipts (Product.observedLeadTimeDays) second, then for products with no history the median observed lead time of their supplier (then category), and the flat 14-day default only when none of those exist.',
      'Suggested reorder quantity only applies the configured reorder quantity when projected available stock is below the reorder point; a configured reorderQty of 0 opts the SKU out of auto-reorder suggestions.',
      'ABC class is computed by demand volume over the window above (Pareto: top 80% of units = A, next 15% = B, remainder including no-movement = C), not the stored product field.',
      'When a product has multiple supplier-product rows, Reorder Planning chooses the lowest lastUnitCost supplier row as the default suggestion source.',
      ...(derivedLeadTimeSkus.length > 0 ? [`Supplier/category median lead time used for ${derivedLeadTimeSkus.length} SKU(s) with no configured or observed lead time of their own: ${derivedLeadTimeSkus.slice(0, 10).join(', ')}${derivedLeadTimeSkus.length > 10 ? ', ...' : ''}.`] : []),
      ...(defaultLeadTimeSkus.length > 0 ? [`Default ${DEFAULT_LEAD_TIME_DAYS}-day lead time used for ${defaultLeadTimeSkus.length} SKU(s) with no configured/observed lead time and no supplier or category peers to derive one from: ${defaultLeadTimeSkus.slice(0, 10).join(', ')}${defaultLeadTimeSkus.length > 10 ? ', ...' : ''}.`] : []),
    ],
  }
}

export async function getBackorderDemandReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: ReplenishmentReportDeps } = {},
): Promise<BackorderDemandReport> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const [lines, openPoLines] = await Promise.all([
    client.salesOrderLine.findMany({
      where: {
        productId: { not: null },
        order: { status: { in: ACTIVE_SALES_ORDER_STATUSES } },
        product: productWhere(filters),
      },
      select: {
        id: true,
        orderId: true,
        productId: true,
        sku: true,
        description: true,
        qty: true,
        order: { select: { orderNumber: true, createdAt: true, expectedDelivery: true, status: true } },
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            stockUnit: true,
            category: { select: { id: true, name: true } },
            supplierProducts: {
              ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
              select: { supplier: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: [{ order: { createdAt: 'asc' } }, { id: 'asc' }],
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<BackorderSalesLineRow[]>,
    loadOpenPoLines(client, filters),
  ])
  assertSourceLimit(lines.length, SOURCE_ROW_LIMIT, 'Backorder demand source rows')
  const lineIds = new Set(lines.map((line) => line.id))
  const [allocations, shipmentLines] = lineIds.size === 0
    ? [[], []] as [AllocationRow[], ShipmentLineRow[]]
    : await Promise.all([
      client.orderAllocation.findMany({
        where: { lineId: { in: [...lineIds] } },
        select: { lineId: true, qty: true },
        take: SOURCE_ROW_LIMIT + 1,
      }) as Promise<AllocationRow[]>,
      client.shipmentLine.findMany({
        where: { lineId: { in: [...lineIds] } },
        select: { lineId: true, qty: true, shipment: { select: { status: true } } },
        take: SOURCE_ROW_LIMIT + 1,
      }) as Promise<ShipmentLineRow[]>,
    ])
  assertSourceLimit(Math.max(allocations.length, shipmentLines.length), SOURCE_ROW_LIMIT, 'Backorder coverage source rows')
  const allocatedByLine = new Map<string, Prisma.Decimal>()
  for (const allocation of allocations) {
    if (lineIds.has(allocation.lineId)) addToMap(allocatedByLine, allocation.lineId, allocation.qty)
  }
  const committedByLine = new Map<string, Prisma.Decimal>()
  for (const shipmentLine of shipmentLines) {
    if (lineIds.has(shipmentLine.lineId) && shipmentLine.shipment.status !== 'PENDING') addToMap(committedByLine, shipmentLine.lineId, shipmentLine.qty)
  }
  const inboundByProduct = inboundOpenPoByProduct(openPoLines)
  const fillDateByProduct = earliestInboundDateByProduct(openPoLines)
  const rowsByProduct = new Map<string, BackorderDemandReportRow & { orderIds: Set<string> }>()
  for (const line of lines) {
    if (!line.productId || !line.product) continue
    const orderedQty = toDecimal(line.qty)
    const committedQty = Prisma.Decimal.min(orderedQty, committedByLine.get(line.id) ?? new Prisma.Decimal(0))
    const remainingAfterCommitted = Prisma.Decimal.max(new Prisma.Decimal(0), orderedQty.sub(committedQty))
    const openAllocationQty = Prisma.Decimal.max(new Prisma.Decimal(0), (allocatedByLine.get(line.id) ?? new Prisma.Decimal(0)).sub(committedQty))
    const allocatedQty = Prisma.Decimal.min(remainingAfterCommitted, openAllocationQty)
    const backorderQty = remainingAfterCommitted.sub(allocatedQty)
    if (backorderQty.lte(0)) continue
    const current = rowsByProduct.get(line.productId) ?? {
      productId: line.productId,
      sku: line.product.sku,
      productName: line.product.name,
      productType: line.product.type,
      categoryName: line.product.category?.name ?? null,
      supplierNames: supplierNames(line.product),
      stockUnit: line.product.stockUnit,
      orderCount: 0,
      orderedQty: '0',
      committedQty: '0',
      allocatedQty: '0',
      backorderQty: '0',
      inboundOpenPoQty: quantityString(inboundByProduct.get(line.productId) ?? 0),
      projectedFillDate: fillDateByProduct.get(line.productId) ?? null,
      oldestOrderAt: line.order.createdAt.toISOString(),
      orderIds: new Set<string>(),
    }
    current.orderIds.add(line.orderId)
    current.orderCount = current.orderIds.size
    current.orderedQty = quantityString(toDecimal(current.orderedQty).add(orderedQty))
    current.committedQty = quantityString(toDecimal(current.committedQty).add(committedQty))
    current.allocatedQty = quantityString(toDecimal(current.allocatedQty).add(allocatedQty))
    current.backorderQty = quantityString(toDecimal(current.backorderQty).add(backorderQty))
    if (line.order.createdAt.toISOString() < current.oldestOrderAt) current.oldestOrderAt = line.order.createdAt.toISOString()
    rowsByProduct.set(line.productId, current)
  }
  const rows = [...rowsByProduct.values()].map((row) => {
    const reportRow: BackorderDemandReportRow & { orderIds?: Set<string> } = { ...row }
    delete reportRow.orderIds
    return reportRow
  })
    .sort((a, b) => toDecimal(b.backorderQty).cmp(a.backorderQty) || a.sku.localeCompare(b.sku))
  const totals = rows.reduce(
    (total, row) => ({
      orderedQty: total.orderedQty.add(row.orderedQty),
      committedQty: total.committedQty.add(row.committedQty),
      allocatedQty: total.allocatedQty.add(row.allocatedQty),
      backorderQty: total.backorderQty.add(row.backorderQty),
    }),
    { orderedQty: new Prisma.Decimal(0), committedQty: new Prisma.Decimal(0), allocatedQty: new Prisma.Decimal(0), backorderQty: new Prisma.Decimal(0) },
  )
  const pageSize = clampPageSize(filters.pageSize)
  const paged = paginate(rows, filters.page, pageSize, options.paginate !== false)
  return {
    generatedAt: generatedAt.toISOString(),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      orderedQty: quantityString(totals.orderedQty),
      committedQty: quantityString(totals.committedQty),
      allocatedQty: quantityString(totals.allocatedQty),
      backorderQty: quantityString(totals.backorderQty),
    },
    notices: ['Backorder demand includes non-cancelled sales order lines where ordered qty exceeds committed shipment qty plus still-open allocation qty. Unassigned inbound POs are included in product totals but are not treated as warehouse-specific cover.'],
  }
}

export async function getComponentShortageReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: ReplenishmentReportDeps } = {},
): Promise<ComponentShortageReport> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const [orders, stockLevels, openPoLines] = await Promise.all([
    client.productionOrder.findMany({
      where: {
        status: { in: ['DRAFT', 'IN_PROGRESS'] },
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      },
      select: {
        id: true,
        reference: true,
        status: true,
        warehouseId: true,
        qtyPlanned: true,
        qtyProduced: true,
        scheduledAt: true,
        outputProduct: { select: { sku: true, name: true } },
        warehouse: { select: { code: true, name: true } },
        bom: {
          select: {
            items: {
              select: {
                componentProductId: true,
                qty: true,
                component: {
                  select: {
                    id: true,
                    sku: true,
                    name: true,
                    type: true,
                    stockUnit: true,
                    category: { select: { id: true, name: true } },
                    supplierProducts: {
                      ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
                      select: { supplier: { select: { name: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<ProductionOrderRow[]>,
    loadStockLevels(client, filters),
    loadOpenPoLines(client, filters),
  ])
  assertSourceLimit(orders.length, SOURCE_ROW_LIMIT, 'Component shortage production order source rows')
  const availableByStock = new Map<string, Prisma.Decimal>()
  for (const level of stockLevels) {
    addToMap(availableByStock, stockKey(level.productId, level.warehouseId), toDecimal(level.quantity).sub(toDecimal(level.reservedQty)))
  }
  const inboundByStock = inboundOpenPoByStock(openPoLines)
  const requirements = new Map<string, ComponentShortageReportRow & { orderIds: Set<string>; outputSet: Set<string> }>()
  for (const order of orders) {
    const remainingOutput = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(order.qtyPlanned).sub(toDecimal(order.qtyProduced)))
    if (remainingOutput.lte(0)) continue
    for (const item of order.bom.items) {
      const component = item.component
      if (!componentMatchesFilters(component, filters)) continue
      const key = stockKey(item.componentProductId, order.warehouseId)
      const requiredQty = remainingOutput.mul(toDecimal(item.qty))
      const current = requirements.get(key) ?? {
        productId: component.id,
        sku: component.sku,
        productName: component.name,
        productType: component.type,
        categoryName: component.category?.name ?? null,
        supplierNames: supplierNames(component),
        warehouseId: order.warehouseId,
        warehouseCode: order.warehouse.code,
        warehouseName: order.warehouse.name,
        stockUnit: component.stockUnit,
        productionOrderCount: 0,
        requiredQty: '0',
        availableQty: quantityString(availableByStock.get(key) ?? 0),
        inboundOpenPoQty: quantityString(inboundByStock.get(key) ?? 0),
        shortageQty: '0',
        earliestScheduledAt: order.scheduledAt?.toISOString() ?? null,
        outputProducts: [],
        orderIds: new Set<string>(),
        outputSet: new Set<string>(),
      }
      current.orderIds.add(order.id)
      current.outputSet.add(`${order.outputProduct.sku} ${order.outputProduct.name}`)
      current.productionOrderCount = current.orderIds.size
      current.outputProducts = [...current.outputSet].sort()
      current.requiredQty = quantityString(toDecimal(current.requiredQty).add(requiredQty))
      if (order.scheduledAt && (!current.earliestScheduledAt || order.scheduledAt.toISOString() < current.earliestScheduledAt)) current.earliestScheduledAt = order.scheduledAt.toISOString()
      requirements.set(key, current)
    }
  }
  const rows = [...requirements.values()]
    .map((row) => {
      const shortageQty = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(row.requiredQty).sub(row.availableQty).sub(row.inboundOpenPoQty))
      return { ...row, shortageQty: quantityString(shortageQty) }
    })
    .filter((row) => toDecimal(row.shortageQty).gt(0))
    .map((row) => {
      const reportRow: ComponentShortageReportRow & { orderIds?: Set<string>; outputSet?: Set<string> } = { ...row }
      delete reportRow.orderIds
      delete reportRow.outputSet
      return reportRow
    })
    .sort((a, b) => toDecimal(b.shortageQty).cmp(a.shortageQty) || a.sku.localeCompare(b.sku))
  const totals = rows.reduce(
    (total, row) => ({
      requiredQty: total.requiredQty.add(row.requiredQty),
      availableQty: total.availableQty.add(row.availableQty),
      inboundOpenPoQty: total.inboundOpenPoQty.add(row.inboundOpenPoQty),
      shortageQty: total.shortageQty.add(row.shortageQty),
    }),
    { requiredQty: new Prisma.Decimal(0), availableQty: new Prisma.Decimal(0), inboundOpenPoQty: new Prisma.Decimal(0), shortageQty: new Prisma.Decimal(0) },
  )
  const pageSize = clampPageSize(filters.pageSize)
  const paged = paginate(rows, filters.page, pageSize, options.paginate !== false)
  return {
    generatedAt: generatedAt.toISOString(),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      requiredQty: quantityString(totals.requiredQty),
      availableQty: quantityString(totals.availableQty),
      inboundOpenPoQty: quantityString(totals.inboundOpenPoQty),
      shortageQty: quantityString(totals.shortageQty),
    },
    notices: ['Component shortages include draft and in-progress production orders and subtract current available stock plus inbound open PO quantity for the production warehouse. POs without a destination warehouse are not treated as warehouse-specific cover.'],
  }
}
