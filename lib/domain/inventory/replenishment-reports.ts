import { Prisma, ProductType, PurchaseOrderStatus, SalesOrderStatus, StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { calculateDailyVelocity, type VelocitySaleInput } from '@/lib/domain/inventory/velocity'
import type { PageInfo, StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { OPERATIONAL_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { getObservedLeadTimeP95BySupplierProduct } from '@/lib/domain/purchasing/purchasing-analytics'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const DEFAULT_DEMAND_WINDOW_DAYS = 90
const DEFAULT_LEAD_TIME_DAYS = 14
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
}

export type ReplenishmentReportDeps = {
  client?: ReplenishmentReportClient
  now?: () => Date
}

type SupplierProductRow = {
  supplierId: string
  supplierSku: string | null
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
  abcClass: string | null
  category: { id: string; name: string } | null
  supplierProducts: SupplierProductRow[]
}

type StockLevelRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
  reservedQty: DecimalInput
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
  supplierId: string | null
  supplierName: string | null
  supplierSku: string | null
  stockUnit: string
  availableQty: string
  inboundOpenPoQty: string
  averageDailyDemand: string
  leadTimeDays: number
  safetyStockQty: string
  reorderPoint: string
  configuredReorderQty: string
  suggestedReorderQty: string
  abcClass: string | null
  urgency: 'critical' | 'reorder' | 'watch'
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

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}

function subtractDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() - days)
  return next
}

function parsePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback
}

function quantityString(value: DecimalInput): string {
  return roundQuantity(value, 4).toString()
}

function productWhere(filters: StockPositionFilters) {
  const filteredType = filters.productType && REPLENISHMENT_PRODUCT_TYPES.includes(filters.productType)
    ? filters.productType
    : undefined
  return {
    lifecycleStatus: { in: OPERATIONAL_PRODUCT_STATUSES },
    type: filteredType ?? { in: REPLENISHMENT_PRODUCT_TYPES },
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.supplierId ? { supplierProducts: { some: { supplierId: filters.supplierId } } } : {}),
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

function stockKey(productId: string, warehouseId: string | null | undefined): string {
  return `${productId}:${warehouseId ?? 'all'}`
}

function addToMap(map: Map<string, Prisma.Decimal>, key: string, value: DecimalInput): void {
  map.set(key, (map.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(value)))
}

async function loadOpenPoLines(client: ReplenishmentReportClient, filters: StockPositionFilters): Promise<OpenPoLineRow[]> {
  return client.purchaseOrderLine.findMany({
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
  }) as Promise<OpenPoLineRow[]>
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

function demandWindow(now: Date, days: number): { dateFrom: Date; dateTo: Date } {
  const dateTo = endOfUtcDay(now)
  const dateFrom = subtractDays(startOfUtcDay(now), days - 1)
  return { dateFrom, dateTo }
}

async function loadVelocityRows(client: ReplenishmentReportClient, filters: StockPositionFilters, window: { dateFrom: Date; dateTo: Date }): Promise<VelocitySaleInput[]> {
  const movements = await client.stockMovement.findMany({
    where: {
      type: StockMovementType.SALE_DISPATCH,
      createdAt: { gte: window.dateFrom, lte: window.dateTo },
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
  if (movements.length > SOURCE_ROW_LIMIT) {
    throw new Error(`Replenishment velocity source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  }

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
  return client.stockLevel.findMany({
    where: {
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      product: productWhere(filters),
    },
    select: {
      productId: true,
      warehouseId: true,
      quantity: true,
      reservedQty: true,
    },
  }) as Promise<StockLevelRow[]>
}

export async function getReorderReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: ReplenishmentReportDeps } = {},
): Promise<ReorderReport> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const demandDays = parsePositiveInteger(filters.thresholdDays, DEFAULT_DEMAND_WINDOW_DAYS)
  const window = demandWindow(generatedAt, demandDays)
  const [products, stockLevels, velocityInputs, openPoLines, observedLeadTimeP95BySupplierProduct] = await Promise.all([
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
        abcClass: true,
          category: { select: { id: true, name: true } },
        supplierProducts: {
          ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
          select: {
            supplierId: true,
            supplierSku: true,
            leadTimeDays: true,
            supplier: { select: { name: true } },
          },
          orderBy: { updatedAt: 'desc' },
        },
      },
      orderBy: { sku: 'asc' },
    }) as Promise<ProductPlanningRow[]>,
    loadStockLevels(client, filters),
    loadVelocityRows(client, filters, window),
    loadOpenPoLines(client, filters),
    getObservedLeadTimeP95BySupplierProduct({
      client: { purchaseReceipt: client.purchaseReceipt },
      now: () => generatedAt,
    }),
  ])

  const availableByProduct = new Map<string, Prisma.Decimal>()
  for (const level of stockLevels) {
    addToMap(availableByProduct, level.productId, toDecimal(level.quantity).sub(toDecimal(level.reservedQty)))
  }
  const inboundByProduct = inboundOpenPoByProduct(openPoLines)
  const velocityByProduct = new Map(calculateDailyVelocity(velocityInputs, window).map((row) => [row.productId, row]))
  const defaultLeadTimeSkus: string[] = []

  const rows = products.flatMap<ReorderReportRow>((product) => {
    const configuredReorderQty = product.reorderQty == null ? null : toDecimal(product.reorderQty)
    if (configuredReorderQty?.lte(0)) return []
    const supplier = product.supplierProducts[0] ?? null
    const availableQty = availableByProduct.get(product.id) ?? new Prisma.Decimal(0)
    const inboundOpenPoQty = inboundByProduct.get(product.id) ?? new Prisma.Decimal(0)
    const projectedAvailableQty = availableQty.add(inboundOpenPoQty)
    const averageDailyDemand = toDecimal(velocityByProduct.get(product.id)?.dailyQtyVelocity ?? 0)
    const observedLeadTimeDays = supplier ? observedLeadTimeP95BySupplierProduct.get(`${supplier.supplierId}:${product.id}`) : undefined
    const leadTimeDays = supplier?.leadTimeDays ?? observedLeadTimeDays ?? DEFAULT_LEAD_TIME_DAYS
    if (supplier?.leadTimeDays == null && observedLeadTimeDays == null) defaultLeadTimeSkus.push(product.sku)
    const safetyStockQty = toDecimal(product.safetyStockQty ?? 0)
    const demandDuringLeadTime = averageDailyDemand.mul(leadTimeDays)
    const computedReorderPoint = demandDuringLeadTime.add(safetyStockQty)
    const reorderPoint = product.reorderPoint == null ? computedReorderPoint : toDecimal(product.reorderPoint)
    const gapQty = reorderPoint.sub(projectedAvailableQty)
    const suggestedReorderQty = gapQty.gt(0)
      ? Prisma.Decimal.max(configuredReorderQty ?? new Prisma.Decimal(0), gapQty)
      : new Prisma.Decimal(0)
    if (suggestedReorderQty.lte(0) && projectedAvailableQty.gt(reorderPoint)) return []
    const urgency: ReorderReportRow['urgency'] = projectedAvailableQty.lte(0)
      ? 'critical'
      : projectedAvailableQty.lte(reorderPoint)
        ? 'reorder'
        : 'watch'
    return [{
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      productType: product.type,
      categoryName: product.category?.name ?? null,
      supplierId: supplier?.supplierId ?? null,
      supplierName: supplier?.supplier.name ?? null,
      supplierSku: supplier?.supplierSku ?? null,
      stockUnit: product.stockUnit,
      availableQty: quantityString(availableQty),
      inboundOpenPoQty: quantityString(inboundOpenPoQty),
      averageDailyDemand: quantityString(averageDailyDemand),
      leadTimeDays,
      safetyStockQty: quantityString(safetyStockQty),
      reorderPoint: quantityString(reorderPoint),
      configuredReorderQty: quantityString(configuredReorderQty ?? 0),
      suggestedReorderQty: quantityString(suggestedReorderQty),
      abcClass: product.abcClass,
      urgency,
    }]
  })

  rows.sort((a, b) => {
    const urgencyOrder = { critical: 0, reorder: 1, watch: 2 }
    return urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || a.sku.localeCompare(b.sku)
  })
  const totals = rows.reduce(
    (total, row) => ({
      availableQty: total.availableQty.add(row.availableQty),
      inboundOpenPoQty: total.inboundOpenPoQty.add(row.inboundOpenPoQty),
      suggestedReorderQty: total.suggestedReorderQty.add(row.suggestedReorderQty),
    }),
    { availableQty: new Prisma.Decimal(0), inboundOpenPoQty: new Prisma.Decimal(0), suggestedReorderQty: new Prisma.Decimal(0) },
  )
  const pageSize = clampPageSize(filters.pageSize)
  const paged = paginate(rows, filters.page, pageSize, options.paginate !== false)
  return {
    generatedAt: generatedAt.toISOString(),
    demandWindowDateFrom: dateOnly(window.dateFrom),
    demandWindowDateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      availableQty: quantityString(totals.availableQty),
      inboundOpenPoQty: quantityString(totals.inboundOpenPoQty),
      suggestedReorderQty: quantityString(totals.suggestedReorderQty),
    },
    notices: [
      `Demand velocity uses SALE_DISPATCH movements from ${dateOnly(window.dateFrom)} to ${dateOnly(window.dateTo)}; returns are not netted.`,
      'Lead time uses SupplierProduct.leadTimeDays first, observed PurchaseReceipt P95 by supplier/SKU second, and the default 14 days only when neither exists.',
      'Suggested reorder quantity only applies the configured reorder quantity when projected available stock is below the reorder point; a configured reorderQty of 0 opts the SKU out of auto-reorder suggestions.',
      ...(defaultLeadTimeSkus.length > 0 ? [`Default ${DEFAULT_LEAD_TIME_DAYS}-day lead time used for ${defaultLeadTimeSkus.length} SKU(s) without configured or observed lead time: ${defaultLeadTimeSkus.slice(0, 10).join(', ')}${defaultLeadTimeSkus.length > 10 ? ', ...' : ''}.`] : []),
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
    }) as Promise<BackorderSalesLineRow[]>,
    loadOpenPoLines(client, filters),
  ])
  const lineIds = new Set(lines.map((line) => line.id))
  const [allocations, shipmentLines] = lineIds.size === 0
    ? [[], []] as [AllocationRow[], ShipmentLineRow[]]
    : await Promise.all([
      client.orderAllocation.findMany({
        where: { lineId: { in: [...lineIds] } },
        select: { lineId: true, qty: true },
      }) as Promise<AllocationRow[]>,
      client.shipmentLine.findMany({
        where: { lineId: { in: [...lineIds] } },
        select: { lineId: true, qty: true, shipment: { select: { status: true } } },
      }) as Promise<ShipmentLineRow[]>,
    ])
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
    }) as Promise<ProductionOrderRow[]>,
    loadStockLevels(client, filters),
    loadOpenPoLines(client, filters),
  ])
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
