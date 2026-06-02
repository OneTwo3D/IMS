import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import {
  bucketInventoryAging,
  type AgingBucketDefinition,
  type AgingLayerInput,
} from '@/lib/domain/inventory/velocity'
import type { PageInfo, StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const COST_LAYER_SOURCE_ROW_LIMIT = 100000
const KIT_ITEM_SOURCE_ROW_LIMIT = 50000
const FUTURE_COGS_SOURCE_ROW_LIMIT = 100000
const PRODUCT_TYPES = Object.values(ProductType)

export const INVENTORY_AGING_KIT_MODE = 'component' as const

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type InventoryHealthReportClient = {
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

function validProductType(value: unknown): ProductType | undefined {
  return PRODUCT_TYPES.includes(value as ProductType) ? value as ProductType : undefined
}

function supplierNames(product: CostLayerAgingRow['product'] | KitItemAgingRow['parentProduct']): string[] {
  return product.supplierProducts.map((supplierProduct) => supplierProduct.supplier.name)
}

function rejectOverLimit(rows: unknown[], limit: number, label: string): void {
  if (rows.length > limit) {
    throw new Error(`Inventory aging ${label} exceeds ${limit.toLocaleString()} rows. Narrow product, warehouse, category, supplier, type, or as-of filters and retry.`)
  }
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
