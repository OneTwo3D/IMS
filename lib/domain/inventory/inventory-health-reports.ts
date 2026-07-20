import { Prisma, ProductType, StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import {
  bucketInventoryAging,
  calculateDailyVelocity,
  calculateDeadStock,
  saleMovementCogsBase,
  type AgingBucketDefinition,
  type AgingLayerInput,
  type DeadStockRow,
  type InventoryPositionInput,
  type VelocitySaleInput,
} from '@/lib/domain/inventory/velocity'
import type { PageInfo, StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { HISTORICAL_IMPORT_REFERENCE_TYPES } from '@/lib/domain/inventory/stock-movement-value'
import { exclusiveEndOfUtcDay, subtractUtcDays } from '@/lib/domain/math/date-window'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const COST_LAYER_SOURCE_ROW_LIMIT = 100000
const KIT_ITEM_SOURCE_ROW_LIMIT = 50000
const FUTURE_COGS_SOURCE_ROW_LIMIT = 100000
const DEAD_STOCK_STOCK_LEVEL_ROW_LIMIT = 100000
const DEAD_STOCK_COST_LAYER_ROW_LIMIT = 100000
const DEAD_STOCK_SALE_MOVEMENT_ROW_LIMIT = 100000

/**
 * The only movement shape allowed to carry demand with no warehouse: a historical/initial sales import.
 * Both warehouse columns null AND a historical referenceType, matching the repository invariant — a bare
 * `fromWarehouseId: null` is NOT sufficient, because deleting a warehouse nulls the column on ordinary
 * dispatches (optional relation, Prisma's default onDelete: SetNull).
 */
const HISTORICAL_IMPORT_MOVEMENT_SHAPE = {
  fromWarehouseId: null,
  toWarehouseId: null,
  referenceType: { in: [...HISTORICAL_IMPORT_REFERENCE_TYPES] },
} as const
const DEFAULT_DEAD_STOCK_THRESHOLD_DAYS = 90
const DEFAULT_DEAD_STOCK_LOOKBACK_DAYS = 365
const PRODUCT_TYPES = Object.values(ProductType)

export const INVENTORY_AGING_KIT_MODE = 'component' as const

export class InventoryHealthSourceLimitError extends SourceScanTooLargeError {
  constructor(limit: number, scanLabel: string) {
    super(`Inventory health ${scanLabel}`, limit, {
      message: `Inventory health ${scanLabel} exceeds ${limit.toLocaleString()} rows. Narrow product, warehouse, category, supplier, type, or date filters and retry.`,
    })
    this.name = 'InventoryHealthSourceLimitError'
  }

  get scanLabel(): string {
    return this.source.replace(/^Inventory health /, '')
  }
}

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type InventoryHealthReportClient = {
  stockLevel: FindManyDelegate
  stockMovement: FindManyDelegate
  costLayer: FindManyDelegate
  cogsEntry: FindManyDelegate
  kitItem: FindManyDelegate
}

export type InventoryHealthReportDeps = {
  client?: InventoryHealthReportClient
  now?: () => Date
}

export type InventoryAgingSource = 'cost_layer' | 'kit_component'

export type InventoryAgingReportRow = {
  productId: string
  warehouseId: string
  sku: string
  productName: string
  productType: ProductType
  categoryName: string | null
  supplierNames: string[]
  warehouseCode: string
  warehouseName: string
  stockUnit: string
  bucket: string
  minAgeDays: number
  maxAgeDays: number | null
  qty: string
  valueBase: string
  source: InventoryAgingSource
}

export type InventoryAgingReport = {
  asOf: string
  generatedAt: string
  kitAgingMode: typeof INVENTORY_AGING_KIT_MODE
  rows: InventoryAgingReportRow[]
  pageInfo: PageInfo
  totals: {
    qty: string
    valueBase: string
  }
  bucketSummary: Array<{
    bucket: string
    minAgeDays: number
    maxAgeDays: number | null
    qty: string
    valueBase: string
  }>
  notices: string[]
}

export type DeadStockReportRow = DeadStockRow & {
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  productType: ProductType
  stockUnit: string
}

export type DeadStockReport = {
  asOf: string
  generatedAt: string
  thresholdDays: number
  velocityWindowDateFrom: string
  velocityWindowDateTo: string
  rows: DeadStockReportRow[]
  pageInfo: PageInfo
  totals: {
    qty: string
    valueBase: string
    neverSoldRows: number
  }
  notices: string[]
}

type CostLayerAgingRow = {
  id: string
  productId: string
  warehouseId: string
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
  receivedAt: Date
  product: {
    id: string
    sku: string
    name: string
    type: ProductType
    stockUnit: string
    category: { name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  }
  warehouse: {
    id: string
    code: string
    name: string
  }
}

type FutureCogsRow = {
  costLayerId: string
  qty: DecimalInput
}

type KitItemAgingRow = {
  parentProductId: string
  componentProductId: string
  qty: DecimalInput
  parentProduct: {
    id: string
    sku: string
    name: string
    type: ProductType
    stockUnit: string
    category: { name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  }
  component: CostLayerAgingRow['product']
}

type AgingLayerWithContext = AgingLayerInput & {
  productType: ProductType
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  stockUnit: string
  source: InventoryAgingSource
}

type DeadStockLevelRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
  product: {
    id: string
    sku: string
    name: string
    type: ProductType
    stockUnit: string
    createdAt: Date
    category: { name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  }
  warehouse: {
    id: string
    code: string
    name: string
  }
}

type DeadStockCostLayerRow = {
  productId: string
  warehouseId: string
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
  receivedAt: Date
}

type DeadStockSaleMovementRow = {
  id: string
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  referenceType: string | null
  qty: DecimalInput
  totalValueBase: DecimalInput | null
  cogsEntries: Array<{ totalCostBase: DecimalInput }>
  createdAt: Date
  product: {
    id: string
    sku: string
    name: string
    category: { name: string } | null
    supplierProducts: Array<{ supplier: { name: string } }>
  }
}

function clampPage(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

function clampPageSize(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(Math.max(parsed, MIN_PAGE_SIZE), MAX_PAGE_SIZE)
}

function pageInfo(totalRows: number, page: number, pageSize: number): PageInfo {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  return {
    page: safePage,
    pageSize,
    totalRows,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPreviousPage: safePage > 1,
  }
}

function paginate<T>(rows: T[], filters: Pick<StockPositionFilters, 'page' | 'pageSize'>): { rows: T[]; pageInfo: PageInfo } {
  const info = pageInfo(rows.length, clampPage(filters.page), clampPageSize(filters.pageSize))
  const start = (info.page - 1) * info.pageSize
  return { rows: rows.slice(start, start + info.pageSize), pageInfo: info }
}

function parseAsOf(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T23:59:59.999Z`)
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function subtractDays(value: Date, days: number): Date {
  return subtractUtcDays(value, days)
}

function parseThresholdDays(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_DEAD_STOCK_THRESHOLD_DAYS
  return parsed
}

function validProductType(value: unknown): ProductType | undefined {
  return PRODUCT_TYPES.includes(value as ProductType) ? value as ProductType : undefined
}

function supplierNames(product: { supplierProducts: Array<{ supplier: { name: string } }> }): string[] {
  return product.supplierProducts.map((supplierProduct) => supplierProduct.supplier.name)
}

function rejectOverLimit(rows: unknown[], limit: number, label: string): void {
  if (rows.length > limit) {
    throw new InventoryHealthSourceLimitError(limit, label)
  }
}

function stockKey(productId: string, warehouseId: string): string {
  return `${productId}:${warehouseId}`
}

function productWhere(filters: StockPositionFilters, typeOverride?: Prisma.EnumProductTypeFilter | ProductType): Prisma.ProductWhereInput {
  const productType = validProductType(filters.productType)
  return {
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.supplierId ? { supplierProducts: { some: { supplierId: filters.supplierId } } } : {}),
    ...(typeOverride ? { type: typeOverride } : productType ? { type: productType } : {}),
  }
}

function directLayerProductTypeFilter(filters: StockPositionFilters): Prisma.EnumProductTypeFilter | ProductType {
  const productType = validProductType(filters.productType)
  if (productType === ProductType.KIT) return ProductType.KIT
  return productType ?? { not: ProductType.KIT }
}

async function loadFutureCogsByLayer(
  client: InventoryHealthReportClient,
  layerIds: string[],
  asOf: Date,
): Promise<Map<string, Prisma.Decimal>> {
  if (layerIds.length === 0) return new Map()
  const rows = await client.cogsEntry.findMany({
    where: {
      costLayerId: { in: layerIds },
      createdAt: { gt: asOf },
    },
    select: {
      costLayerId: true,
      qty: true,
    },
    take: FUTURE_COGS_SOURCE_ROW_LIMIT + 1,
  }) as FutureCogsRow[]
  rejectOverLimit(rows, FUTURE_COGS_SOURCE_ROW_LIMIT, 'future COGS scan')

  const byLayer = new Map<string, Prisma.Decimal>()
  for (const row of rows) {
    byLayer.set(row.costLayerId, (byLayer.get(row.costLayerId) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }
  return byLayer
}

async function loadCostLayerContexts(
  client: InventoryHealthReportClient,
  filters: StockPositionFilters,
  asOf: Date,
): Promise<Array<{ row: CostLayerAgingRow; qtyAsOf: Prisma.Decimal; valueAsOf: Prisma.Decimal }>> {
  const productType = validProductType(filters.productType)
  if (productType === ProductType.KIT) return []

  const layers = await client.costLayer.findMany({
    where: {
      receivedAt: { lte: asOf },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      product: productWhere(filters, directLayerProductTypeFilter(filters)),
    },
    select: {
      id: true,
      productId: true,
      warehouseId: true,
      remainingQty: true,
      unitCostBase: true,
      receivedAt: true,
      product: {
        select: {
          id: true,
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
      warehouse: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }, { receivedAt: 'asc' }],
    take: COST_LAYER_SOURCE_ROW_LIMIT + 1,
  }) as CostLayerAgingRow[]
  rejectOverLimit(layers, COST_LAYER_SOURCE_ROW_LIMIT, 'cost-layer scan')

  const futureCogsByLayer = await loadFutureCogsByLayer(client, layers.map((layer) => layer.id), asOf)
  return layers.flatMap((row) => {
    const qtyAsOf = toDecimal(row.remainingQty).add(futureCogsByLayer.get(row.id) ?? 0)
    if (qtyAsOf.lte(0)) return []
    return [{
      row,
      qtyAsOf,
      valueAsOf: qtyAsOf.mul(toDecimal(row.unitCostBase)),
    }]
  })
}

function buildDirectAgingLayers(
  contexts: Array<{ row: CostLayerAgingRow; qtyAsOf: Prisma.Decimal; valueAsOf: Prisma.Decimal }>,
): AgingLayerWithContext[] {
  return contexts.map(({ row, qtyAsOf, valueAsOf }) => ({
    productId: row.productId,
    sku: row.product.sku,
    productName: row.product.name,
    productType: row.product.type,
    categoryName: row.product.category?.name ?? null,
    supplierNames: supplierNames(row.product),
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    warehouseName: row.warehouse.name,
    stockUnit: row.product.stockUnit,
    qty: qtyAsOf,
    valueBase: valueAsOf,
    receivedAt: row.receivedAt,
    source: 'cost_layer',
  }))
}

async function loadKitAgingLayers(
  client: InventoryHealthReportClient,
  filters: StockPositionFilters,
  asOf: Date,
): Promise<AgingLayerWithContext[]> {
  const productType = validProductType(filters.productType)
  if (productType && productType !== ProductType.KIT) return []

  const kitItems = await client.kitItem.findMany({
    where: {
      parentProduct: productWhere({ ...filters, productType: ProductType.KIT }),
    },
    select: {
      parentProductId: true,
      componentProductId: true,
      qty: true,
      parentProduct: {
        select: {
          id: true,
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
      component: {
        select: {
          id: true,
          sku: true,
          name: true,
          type: true,
          stockUnit: true,
          category: { select: { name: true } },
          supplierProducts: {
            select: { supplier: { select: { name: true } } },
            orderBy: { supplier: { name: 'asc' } },
          },
        },
      },
    },
    orderBy: [{ parentProduct: { sku: 'asc' } }, { sortOrder: 'asc' }],
    take: KIT_ITEM_SOURCE_ROW_LIMIT + 1,
  }) as KitItemAgingRow[]
  rejectOverLimit(kitItems, KIT_ITEM_SOURCE_ROW_LIMIT, 'KIT item scan')
  if (kitItems.length === 0) return []

  const componentIds = Array.from(new Set(kitItems.map((item) => item.componentProductId)))
  const componentLayers = await client.costLayer.findMany({
    where: {
      productId: { in: componentIds },
      receivedAt: { lte: asOf },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    },
    select: {
      id: true,
      productId: true,
      warehouseId: true,
      remainingQty: true,
      unitCostBase: true,
      receivedAt: true,
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          type: true,
          stockUnit: true,
          category: { select: { name: true } },
          supplierProducts: { select: { supplier: { select: { name: true } } } },
        },
      },
      warehouse: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }, { receivedAt: 'asc' }],
    take: COST_LAYER_SOURCE_ROW_LIMIT + 1,
  }) as CostLayerAgingRow[]
  rejectOverLimit(componentLayers, COST_LAYER_SOURCE_ROW_LIMIT, 'KIT component cost-layer scan')
  const futureCogsByLayer = await loadFutureCogsByLayer(client, componentLayers.map((layer) => layer.id), asOf)
  const layersByComponent = new Map<string, CostLayerAgingRow[]>()
  for (const layer of componentLayers) {
    layersByComponent.set(layer.productId, [...(layersByComponent.get(layer.productId) ?? []), layer])
  }

  return kitItems.flatMap((item) => {
    const factor = toDecimal(item.qty)
    if (factor.lte(0)) return []
    return (layersByComponent.get(item.componentProductId) ?? []).flatMap((layer) => {
      const componentQtyAsOf = toDecimal(layer.remainingQty).add(futureCogsByLayer.get(layer.id) ?? 0)
      if (componentQtyAsOf.lte(0)) return []
      return [{
        productId: layer.productId,
        sku: layer.product.sku,
        productName: `${layer.product.name} for ${item.parentProduct.sku}`,
        productType: layer.product.type,
        categoryName: layer.product.category?.name ?? null,
        supplierNames: supplierNames(item.component),
        warehouseId: layer.warehouseId,
        warehouseCode: layer.warehouse.code,
        warehouseName: layer.warehouse.name,
        stockUnit: layer.product.stockUnit,
        qty: componentQtyAsOf,
        valueBase: componentQtyAsOf.mul(toDecimal(layer.unitCostBase)),
        receivedAt: layer.receivedAt,
        source: 'kit_component' as const,
      }]
    })
  })
}

function bucketKey(layer: AgingLayerWithContext, bucket: string): string {
  return `${layer.productId}:${layer.productName}:${layer.warehouseId}:${layer.source}:${bucket}`
}

function toReportRows(layers: AgingLayerWithContext[], asOf: Date, buckets?: AgingBucketDefinition[]): InventoryAgingReportRow[] {
  const rowsByBucket = new Map<string, InventoryAgingReportRow>()
  for (const layer of layers) {
    for (const bucket of bucketInventoryAging([layer], asOf, buckets)) {
      const key = bucketKey(layer, bucket.bucket)
      const current = rowsByBucket.get(key)
      if (current) {
        rowsByBucket.set(key, {
          ...current,
          qty: roundQuantity(toDecimal(current.qty).add(bucket.qty), 4).toString(),
          valueBase: roundQuantity(toDecimal(current.valueBase).add(bucket.valueBase), 6).toString(),
        })
      } else {
        rowsByBucket.set(key, {
          ...bucket,
          productType: layer.productType,
          warehouseId: layer.warehouseId,
          warehouseCode: layer.warehouseCode,
          warehouseName: layer.warehouseName,
          stockUnit: layer.stockUnit,
          source: layer.source,
        })
      }
    }
  }

  return [...rowsByBucket.values()].sort((a, b) => (
    a.sku.localeCompare(b.sku) ||
    a.warehouseCode.localeCompare(b.warehouseCode) ||
    a.minAgeDays - b.minAgeDays
  ))
}

function summarizeBuckets(rows: InventoryAgingReportRow[]): InventoryAgingReport['bucketSummary'] {
  const byBucket = new Map<string, { minAgeDays: number; maxAgeDays: number | null; qty: Prisma.Decimal; valueBase: Prisma.Decimal }>()
  for (const row of rows) {
    const current = byBucket.get(row.bucket) ?? {
      minAgeDays: row.minAgeDays,
      maxAgeDays: row.maxAgeDays,
      qty: new Prisma.Decimal(0),
      valueBase: new Prisma.Decimal(0),
    }
    current.qty = current.qty.add(toDecimal(row.qty))
    current.valueBase = current.valueBase.add(toDecimal(row.valueBase))
    byBucket.set(row.bucket, current)
  }
  return [...byBucket.entries()]
    .map(([bucket, row]) => ({
      bucket,
      minAgeDays: row.minAgeDays,
      maxAgeDays: row.maxAgeDays,
      qty: roundQuantity(row.qty, 4).toString(),
      valueBase: roundQuantity(row.valueBase, 6).toString(),
    }))
    .sort((a, b) => a.minAgeDays - b.minAgeDays)
}

export async function getInventoryAgingReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: InventoryHealthReportDeps; buckets?: AgingBucketDefinition[] } = { paginate: true },
): Promise<InventoryAgingReport> {
  const client = options.deps?.client ?? db as InventoryHealthReportClient
  const now = options.deps?.now ?? (() => new Date())
  const asOf = parseAsOf(filters.asOf, now())
  const productType = validProductType(filters.productType)
  const [directContexts, kitLayers] = await Promise.all([
    loadCostLayerContexts(client, filters, asOf),
    productType === ProductType.KIT ? loadKitAgingLayers(client, filters, asOf) : Promise.resolve([]),
  ])
  const directLayers = buildDirectAgingLayers(directContexts)
  const layers = productType === ProductType.KIT
    ? kitLayers
    : directLayers
  const rows = toReportRows(layers, asOf, options.buckets)
  const totals = rows.reduce((sum, row) => ({
    qty: sum.qty.add(toDecimal(row.qty)),
    valueBase: sum.valueBase.add(toDecimal(row.valueBase)),
  }), { qty: new Prisma.Decimal(0), valueBase: new Prisma.Decimal(0) })
  const paged = options.paginate === false ? { rows, pageInfo: pageInfo(rows.length, 1, Math.max(rows.length, 1)) } : paginate(rows, filters)
  const kitNotice = productType === ProductType.KIT
    ? 'KIT aging shows component-layer quantity and value for components used by matching KIT SKUs; totals are component exposure, not additional physical stock.'
    : 'Virtual KIT SKUs are excluded from the default aging list; filter Type to KIT to inspect component-based kit exposure.'
  const valueNotice = 'Aging value uses the current CostLayer.unitCostBase; retrospective landed-cost revaluations are not replayed for historical as-of dates.'

  return {
    asOf: asOf.toISOString(),
    generatedAt: now().toISOString(),
    kitAgingMode: INVENTORY_AGING_KIT_MODE,
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      qty: roundQuantity(totals.qty, 4).toString(),
      valueBase: roundQuantity(totals.valueBase, 6).toString(),
    },
    bucketSummary: summarizeBuckets(rows),
    notices: [kitNotice, valueNotice],
  }
}

export function emptyInventoryAgingReportForSourceLimit(
  filters: StockPositionFilters,
  error: InventoryHealthSourceLimitError,
  now = new Date(),
): InventoryAgingReport {
  const asOf = parseAsOf(filters.asOf, now)
  return {
    asOf: asOf.toISOString(),
    generatedAt: now.toISOString(),
    kitAgingMode: INVENTORY_AGING_KIT_MODE,
    rows: [],
    pageInfo: pageInfo(0, 1, clampPageSize(filters.pageSize)),
    totals: { qty: '0', valueBase: '0' },
    bucketSummary: [],
    notices: [error.message],
  }
}

function deadStockVelocityWindow(asOf: Date, thresholdDays: number): { dateFrom: Date; dateTo: Date } {
  const lookbackDays = Math.max(DEFAULT_DEAD_STOCK_LOOKBACK_DAYS, thresholdDays)
  const asOfDayStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()))
  const asOfDayEnd = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 23, 59, 59, 999))
  return {
    dateFrom: subtractDays(asOfDayStart, lookbackDays - 1),
    dateTo: asOfDayEnd,
  }
}

async function loadDeadStockPositions(
  client: InventoryHealthReportClient,
  filters: StockPositionFilters,
): Promise<{ positions: Array<InventoryPositionInput & Omit<DeadStockReportRow, keyof DeadStockRow>>; notices: string[] }> {
  const levels = await client.stockLevel.findMany({
    where: {
      quantity: { gt: 0 },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      product: productWhere(filters),
    },
    select: {
      productId: true,
      warehouseId: true,
      quantity: true,
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          type: true,
          stockUnit: true,
          createdAt: true,
          category: { select: { name: true } },
          supplierProducts: {
            ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
            select: { supplier: { select: { name: true } } },
            orderBy: { supplier: { name: 'asc' } },
          },
        },
      },
      warehouse: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }],
    take: DEAD_STOCK_STOCK_LEVEL_ROW_LIMIT + 1,
  }) as DeadStockLevelRow[]
  rejectOverLimit(levels, DEAD_STOCK_STOCK_LEVEL_ROW_LIMIT, 'stock-level scan')
  if (levels.length === 0) return { positions: [], notices: [] }

  const productIds = Array.from(new Set(levels.map((level) => level.productId)))
  const warehouseIds = Array.from(new Set(levels.map((level) => level.warehouseId)))
  const costLayers = await client.costLayer.findMany({
    where: {
      productId: { in: productIds },
      warehouseId: { in: warehouseIds },
    },
    select: {
      productId: true,
      warehouseId: true,
      remainingQty: true,
      unitCostBase: true,
      receivedAt: true,
    },
    take: DEAD_STOCK_COST_LAYER_ROW_LIMIT + 1,
  }) as DeadStockCostLayerRow[]
  rejectOverLimit(costLayers, DEAD_STOCK_COST_LAYER_ROW_LIMIT, 'cost-layer valuation and first-stocked scan')

  const valueByStock = new Map<string, Prisma.Decimal>()
  const firstStockedByStock = new Map<string, Date>()
  for (const layer of costLayers) {
    const key = stockKey(layer.productId, layer.warehouseId)
    const remainingQty = toDecimal(layer.remainingQty)
    if (remainingQty.gt(0)) {
      valueByStock.set(
        key,
        (valueByStock.get(key) ?? new Prisma.Decimal(0)).add(remainingQty.mul(toDecimal(layer.unitCostBase))),
      )
    }
    const existingFirstStocked = firstStockedByStock.get(key)
    if (!existingFirstStocked || layer.receivedAt.getTime() < existingFirstStocked.getTime()) {
      firstStockedByStock.set(key, layer.receivedAt)
    }
  }

  const positions = levels.map((level) => {
    const key = stockKey(level.productId, level.warehouseId)
    return {
      productId: level.productId,
      warehouseId: level.warehouseId,
      sku: level.product.sku,
      productName: level.product.name,
      productType: level.product.type,
      categoryName: level.product.category?.name ?? null,
      supplierNames: supplierNames(level.product),
      warehouseCode: level.warehouse.code,
      warehouseName: level.warehouse.name,
      stockUnit: level.product.stockUnit,
      key,
      qty: toDecimal(level.quantity),
      valueBase: valueByStock.get(key) ?? new Prisma.Decimal(0),
      firstStockedAt: firstStockedByStock.get(key) ?? level.product.createdAt,
    }
  })
  const missingCostLayerCount = positions.filter((position) => toDecimal(position.valueBase).eq(0)).length
  return {
    positions,
    notices: missingCostLayerCount > 0
      ? [`${missingCostLayerCount.toLocaleString()} stocked row(s) have no positive cost-layer value; dead-stock value is reported as 0 for those rows.`]
      : [],
  }
}

async function loadDeadStockVelocityRows(
  client: InventoryHealthReportClient,
  filters: StockPositionFilters,
  velocityWindow: { dateFrom: Date; dateTo: Date },
): Promise<VelocitySaleInput[]> {
  const dateToExclusive = exclusiveEndOfUtcDay(velocityWindow.dateTo)
  const movements = await client.stockMovement.findMany({
    where: {
      type: StockMovementType.SALE_DISPATCH,
      createdAt: { gte: velocityWindow.dateFrom, lt: dateToExclusive },
      // Admit warehouse-less rows alongside warehouse-attributed ones (o3d-t9k). Historical/initial sales
      // imports record past sales as warehouse-less SALE_DISPATCH movements that exist purely as demand
      // evidence (migration 20260616120000_exempt_historical_imports_from_cogs_guard); excluding them
      // would report a SKU that is demonstrably selling as never-sold/dead. attributeWarehouseLessDemand
      // below spreads them across the product's positions.
      //
      // The NULL branch demands the EXACT import shape — both warehouses null AND a historical
      // referenceType — not merely a missing fromWarehouseId. The warehouse relations are optional with
      // no explicit onDelete, so Prisma defaults to SetNull: deleting a warehouse rewrites its ordinary
      // SalesOrder dispatches into the warehouse-less shape. Treating those as unattributed demand would
      // spread one warehouse's sales across every warehouse holding the product and suppress legitimate
      // dead-stock rows for the whole lookback window. Anything warehouse-less WITHOUT that provenance is
      // excluded here, which is what already happened to it downstream (it could match no position).
      ...(filters.warehouseId
        ? { OR: [{ fromWarehouseId: filters.warehouseId }, HISTORICAL_IMPORT_MOVEMENT_SHAPE] }
        : { OR: [{ fromWarehouseId: { not: null } }, HISTORICAL_IMPORT_MOVEMENT_SHAPE] }),
      // Only products that actually hold stock in scope can produce a dead-stock row, so anything else is
      // wasted budget against DEAD_STOCK_SALE_MOVEMENT_ROW_LIMIT. That matters most for the NULL branch
      // above: without this, imported history for stock held ENTIRELY in other warehouses would be
      // admitted by a warehouse-filtered query and could trip the limit, turning a small in-scope report
      // into an empty page or a 413 export.
      //
      // Expressed as a RELATION PREDICATE, not an id list. Passing the loaded position product ids as
      // `productId: { in: [...] }` would bind one parameter per id, and positions are capped at 100k while
      // PostgreSQL takes at most 32,767 bind values — so a large tenant would get a P2029 bind error
      // instead of a report, below the advertised position cap and not converted to the source-limit
      // response. A subquery mirrors loadDeadStockPositions' own filter with no parameter growth.
      product: {
        ...productWhere(filters),
        stockLevels: {
          some: {
            quantity: { gt: 0 },
            ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
          },
        },
      },
    },
    select: {
      id: true,
      productId: true,
      fromWarehouseId: true,
      toWarehouseId: true,
      referenceType: true,
      qty: true,
      totalValueBase: true,
      cogsEntries: { select: { totalCostBase: true } },
      createdAt: true,
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          category: { select: { name: true } },
          supplierProducts: {
            ...(filters.supplierId ? { where: { supplierId: filters.supplierId } } : {}),
            select: { supplier: { select: { name: true } } },
            orderBy: { supplier: { name: 'asc' } },
          },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: DEAD_STOCK_SALE_MOVEMENT_ROW_LIMIT + 1,
  }) as DeadStockSaleMovementRow[]
  rejectOverLimit(movements, DEAD_STOCK_SALE_MOVEMENT_ROW_LIMIT, 'sale-dispatch movement scan')

  const historicalReferenceTypes: ReadonlySet<string> = new Set(HISTORICAL_IMPORT_REFERENCE_TYPES)

  return movements.flatMap((movement) => {
    const qty = toDecimal(movement.qty)
    if (qty.lt(0)) {
      throw new Error(`SALE_DISPATCH movement ${movement.id} has negative qty: ${qty.toString()}`)
    }
    // Belt and braces with the query's HISTORICAL_IMPORT_MOVEMENT_SHAPE: a warehouse-less row is only
    // demand-without-a-warehouse if it really is an import. Enforcing it here too means the invariant does
    // not rest solely on the where clause, so a future edit there cannot silently start spreading an
    // ordinary dispatch (warehouse deleted => fromWarehouseId nulled) across every warehouse.
    // The full import shape, matching HISTORICAL_IMPORT_MOVEMENT_SHAPE exactly: BOTH warehouse columns
    // null and a historical referenceType. Checking only fromWarehouseId would leave the guard weaker than
    // the query it is meant to backstop, so a row with a destination warehouse could still be spread
    // across every warehouse if the predicate were ever loosened.
    if (!movement.fromWarehouseId) {
      const isHistoricalImport = movement.toWarehouseId == null && historicalReferenceTypes.has(movement.referenceType ?? '')
      if (!isHistoricalImport) return []
    }
    return [{
      key: movement.fromWarehouseId ? stockKey(movement.productId, movement.fromWarehouseId) : movement.productId,
      productId: movement.productId,
      sku: movement.product.sku,
      productName: movement.product.name,
      categoryName: movement.product.category?.name ?? null,
      supplierNames: supplierNames(movement.product),
      qty,
      cogsBase: saleMovementCogsBase(movement),
      occurredAt: movement.createdAt,
    }]
  })
}

/**
 * Attribute warehouse-less demand to every position of that product (o3d-t9k).
 *
 * Sales rows are matched to stock positions by `productId:warehouseId`. A warehouse-less movement was
 * keyed by bare `productId`, which is a key space no position ever occupies — so its demand evidence was
 * silently discarded and the SKU read as never-sold even when the reorder report was simultaneously
 * recommending more of it.
 *
 * The source data does not say which warehouse shipped these, so the evidence is attributed WHOLE to each
 * position rather than being split. That is deliberate: the question dead stock answers is "has this sold
 * recently?", and over-attributing demand merely declines to call something dead, whereas splitting (or
 * dropping) it can liquidate stock that is actually selling. It also matches the reorder report, which
 * counts unassigned demand toward every warehouse (o3d-s8n.1).
 *
 * COLLAPSED FIRST, then attributed. Cloning each movement per position would allocate movements ×
 * warehouses objects — up to DEAD_STOCK_SALE_MOVEMENT_ROW_LIMIT (100k) × N, which is millions in a
 * many-warehouse tenant and defeats a source guard that ran before the fan-out. Collapsing is exact here
 * because calculateDailyVelocity is an associative fold (sum qty/cogs/revenue, min/max dates) and the
 * source query is already bounded to the velocity window, so no out-of-window row can be folded in. The
 * result is at most 2 rows per (product, position): a second zero-quantity row carries firstSaleAt so the
 * fold's min/max still reproduces both ends of the range exactly, and every additive field (qty, cogs,
 * revenue) is summed into the aggregate and zeroed on the carrier.
 *
 * A movement whose product has no position in scope stays dropped — there is nothing to report it against.
 */
export function attributeWarehouseLessDemand<T extends VelocitySaleInput>(
  sales: T[],
  positions: Array<{ productId: string; warehouseId: string }>,
): VelocitySaleInput[] {
  const isUnattributed = (sale: T) => (sale.key ?? sale.productId) === sale.productId
  if (!sales.some(isUnattributed)) return sales

  const warehousesByProduct = new Map<string, string[]>()
  for (const position of positions) {
    const list = warehousesByProduct.get(position.productId)
    if (list) list.push(position.warehouseId)
    else warehousesByProduct.set(position.productId, [position.warehouseId])
  }

  type Collapsed = {
    sample: T
    categoryName: string | null | undefined
    supplierNames: string[] | undefined
    qty: Decimal
    cogsBase: Decimal
    revenueBase: Decimal
    firstSaleAt: Date
    lastSaleAt: Date
  }
  const collapsedByProduct = new Map<string, Collapsed>()
  const attributed: VelocitySaleInput[] = []

  for (const sale of sales) {
    if (!isUnattributed(sale)) {
      attributed.push(sale)
      continue
    }
    // Validate PER ROW, before anything is summed. calculateDailyVelocity rejects negative inputs per
    // input row; if the collapse summed first, a negative row could cancel a positive one and slip past.
    for (const [field, value] of [['qty', sale.qty], ['cogsBase', sale.cogsBase ?? 0], ['revenueBase', sale.revenueBase ?? 0]] as const) {
      if (toDecimal(value).lt(0)) {
        throw new Error(`attributeWarehouseLessDemand received a negative ${field} for product ${sale.productId}`)
      }
    }
    const occurredAt = new Date(sale.occurredAt)
    const current = collapsedByProduct.get(sale.productId)
    if (!current) {
      collapsedByProduct.set(sale.productId, {
        sample: sale,
        categoryName: sale.categoryName,
        supplierNames: sale.supplierNames,
        qty: toDecimal(sale.qty),
        cogsBase: toDecimal(sale.cogsBase ?? 0),
        revenueBase: toDecimal(sale.revenueBase ?? 0),
        firstSaleAt: occurredAt,
        lastSaleAt: occurredAt,
      })
      continue
    }
    // calculateDailyVelocity takes the LAST defined value for these, so the collapse must too or the
    // helper is not the exact equivalent it claims to be.
    if (sale.categoryName != null) current.categoryName = sale.categoryName
    if (sale.supplierNames != null) current.supplierNames = sale.supplierNames
    current.qty = current.qty.add(toDecimal(sale.qty))
    current.cogsBase = current.cogsBase.add(toDecimal(sale.cogsBase ?? 0))
    current.revenueBase = current.revenueBase.add(toDecimal(sale.revenueBase ?? 0))
    if (occurredAt < current.firstSaleAt) current.firstSaleAt = occurredAt
    if (occurredAt > current.lastSaleAt) current.lastSaleAt = occurredAt
  }

  for (const [productId, collapsed] of collapsedByProduct) {
    for (const warehouseId of warehousesByProduct.get(productId) ?? []) {
      const key = stockKey(productId, warehouseId)
      const metadata = { categoryName: collapsed.categoryName, supplierNames: collapsed.supplierNames }
      attributed.push({ ...collapsed.sample, ...metadata, key, qty: collapsed.qty, cogsBase: collapsed.cogsBase, revenueBase: collapsed.revenueBase, occurredAt: collapsed.lastSaleAt })
      // Zero-quantity carrier so the fold's min still sees the true first sale. Skipped when the window
      // holds a single sale date, where the row above already carries both ends.
      if (collapsed.firstSaleAt.getTime() !== collapsed.lastSaleAt.getTime()) {
        // Every ADDITIVE field must be zeroed here, not just qty — inheriting them from `sample` would
        // double-count. revenueBase is unused by the dead-stock loader today but the helper is generic.
        attributed.push({ ...collapsed.sample, ...metadata, key, qty: 0, cogsBase: 0, revenueBase: 0, occurredAt: collapsed.firstSaleAt })
      }
    }
  }

  return attributed
}

export async function getDeadStockReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: InventoryHealthReportDeps } = { paginate: true },
): Promise<DeadStockReport> {
  const client = options.deps?.client ?? db as InventoryHealthReportClient
  const now = options.deps?.now ?? (() => new Date())
  const asOf = parseAsOf(filters.asOf, now())
  const thresholdDays = parseThresholdDays(filters.thresholdDays)
  const velocityWindow = deadStockVelocityWindow(asOf, thresholdDays)
  // Positions load FIRST so the movement scan can be bounded to products that actually hold stock in
  // scope (o3d-t9k). Nothing else can produce a dead-stock row.
  const { positions, notices: positionNotices } = await loadDeadStockPositions(client, filters)
  const sales = positions.length === 0
    ? []
    : await loadDeadStockVelocityRows(client, filters, velocityWindow)
  const velocityRows = calculateDailyVelocity(attributeWarehouseLessDemand(sales, positions), velocityWindow)
  const positionsByKey = new Map(positions.map((position) => [
    position.key ?? stockKey(position.productId, position.warehouseId),
    position,
  ]))
  const deadRows = calculateDeadStock(positions, velocityRows, {
    asOf,
    thresholdDays,
    velocityWindow,
    excludeNeverSoldNewerThanThreshold: true,
  })
  const rows = deadRows.map((row) => {
    const position = positionsByKey.get(row.key ?? row.productId)
    if (!position) throw new Error(`Dead-stock position context missing for stock key ${row.key ?? row.productId}`)
    return {
      ...position,
      ...row,
      productId: position.productId,
      warehouseId: position.warehouseId,
    }
  }) as DeadStockReportRow[]
  const totals = rows.reduce((sum, row) => ({
    qty: sum.qty.add(toDecimal(row.qty)),
    valueBase: sum.valueBase.add(toDecimal(row.valueBase)),
    neverSoldRows: sum.neverSoldRows + (row.lastSaleAt == null ? 1 : 0),
  }), { qty: new Prisma.Decimal(0), valueBase: new Prisma.Decimal(0), neverSoldRows: 0 })
  const paged = options.paginate === false ? { rows, pageInfo: pageInfo(rows.length, 1, Math.max(rows.length, 1)) } : paginate(rows, filters)

  return {
    asOf: asOf.toISOString(),
    generatedAt: now().toISOString(),
    thresholdDays,
    velocityWindowDateFrom: dateOnly(velocityWindow.dateFrom),
    velocityWindowDateTo: dateOnly(velocityWindow.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      qty: roundQuantity(totals.qty, 4).toString(),
      valueBase: roundQuantity(totals.valueBase, 6).toString(),
      neverSoldRows: totals.neverSoldRows,
    },
    notices: [
      `Dead-stock detection uses SALE_DISPATCH movements from ${dateOnly(velocityWindow.dateFrom)} to ${dateOnly(velocityWindow.dateTo)}; older sales are treated as outside the demand window.`,
      'Returns are not netted off for demand evidence; a SKU sold and returned still counts as having demand in the window.',
      'Never-sold products first stocked less than the selected threshold ago are excluded.',
      ...positionNotices,
    ],
  }
}

export function emptyDeadStockReportForSourceLimit(
  filters: StockPositionFilters,
  error: InventoryHealthSourceLimitError,
  now = new Date(),
): DeadStockReport {
  const asOf = parseAsOf(filters.asOf, now)
  const thresholdDays = parseThresholdDays(filters.thresholdDays)
  const velocityWindow = deadStockVelocityWindow(asOf, thresholdDays)
  return {
    asOf: asOf.toISOString(),
    generatedAt: now.toISOString(),
    thresholdDays,
    velocityWindowDateFrom: dateOnly(velocityWindow.dateFrom),
    velocityWindowDateTo: dateOnly(velocityWindow.dateTo),
    rows: [],
    pageInfo: pageInfo(0, 1, clampPageSize(filters.pageSize)),
    totals: { qty: '0', valueBase: '0', neverSoldRows: 0 },
    notices: [error.message],
  }
}
