import { Prisma, type ProductType, type StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { getOnHandAsOf as defaultGetOnHandAsOf } from '@/lib/domain/inventory/get-on-hand-as-of'
import {
  loadReservationSourceRows as defaultLoadReservationSourceRows,
  type ReservationBreakdownClient,
  type ReservationBreakdownRow,
} from '@/lib/domain/inventory/reservation-breakdown'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 500
const DEFAULT_NEGATIVE_STOCK_LOOKBACK_DAYS = 90
const ZERO = new Prisma.Decimal(0)
const PRODUCT_TYPES = ['SIMPLE', 'VARIABLE', 'VARIANT', 'KIT', 'BOM', 'NON_INVENTORY'] as const

type ProductMeta = {
  id: string
  sku: string
  name: string
  type: ProductType
  stockUnit: string
  categoryName: string | null
  supplierNames: string[]
}

type WarehouseMeta = {
  id: string
  code: string
  name: string
}

export type StockPositionReportDeps = {
  client?: typeof db
  getOnHandAsOf?: typeof defaultGetOnHandAsOf
  loadReservationSourceRows?: typeof defaultLoadReservationSourceRows
}

export type StockPositionFilters = {
  asOf?: string
  dateFrom?: string
  dateTo?: string
  warehouseId?: string
  categoryId?: string
  supplierId?: string
  productType?: ProductType
  includeZero?: boolean
  page?: number
  pageSize?: number
}

export type StockPositionFilterOptions = {
  warehouses: Array<{ id: string; code: string; name: string }>
  categories: Array<{ id: string; name: string }>
  suppliers: Array<{ id: string; name: string }>
  productTypes: ProductType[]
}

export type PageInfo = {
  page: number
  pageSize: number
  totalRows: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export type StockOnHandReportRow = {
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
  quantity: string
  reservedQty: string
  availableQty: string
  unitCostBase: string | null
  totalValueBase: string
}

export type StockOnHandReport = {
  asOf: string
  generatedAt: string
  source: string
  anchorDate: string | null
  valueReplayReliable: boolean
  reservedQtyScope: 'current'
  missingValueMovementCount: number
  orphanWarehouseMovementCount: number
  rows: StockOnHandReportRow[]
  pageInfo: PageInfo
  totals: {
    quantity: string
    reservedQty: string
    availableQty: string
    totalValueBase: string
  }
}

export type StockAllocationReportRow = {
  productId: string
  warehouseId: string
  sku: string
  productName: string
  productType: ProductType
  categoryName: string | null
  warehouseCode: string
  warehouseName: string
  stockUnit: string
  source: ReservationBreakdownRow['source']
  referenceId: string
  referenceLabel: string
  referenceHref: string | null
  expectedDate: string | null
  ageBucket: string
  reservedQty: string
  stockLevelReservedQty: string
  driftQty: string
}

export type StockAllocationReport = {
  generatedAt: string
  rows: StockAllocationReportRow[]
  pageInfo: PageInfo
  totals: {
    reservedQty: string
    stockLevelReservedQty: string
    driftQty: string
  }
}

export type NegativeStockReportRow = {
  productId: string
  warehouseId: string
  sku: string
  productName: string
  productType: ProductType
  categoryName: string | null
  warehouseCode: string
  warehouseName: string
  stockUnit: string
  currentQty: string
  minimumQty: string
  firstNegativeAt: string | null
  lastMovementAt: string | null
  movementCount: number
  status: 'currently_negative' | 'historical_negative'
}

export type NegativeStockReport = {
  dateFrom: string
  dateTo: string
  generatedAt: string
  rows: NegativeStockReportRow[]
  pageInfo: PageInfo
  totals: {
    currentNegativeRows: number
    historicalNegativeRows: number
    minimumQty: string
  }
}

type ProductWhereInput = Prisma.ProductWhereInput

function clampPage(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

function clampPageSize(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
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

function decimalString(value: Decimal, places = 4): string {
  return roundQuantity(value, places).toString()
}

function moneyString(value: Decimal): string {
  return roundQuantity(value, 6).toString()
}

function parseDateOnly(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!, 0, 0, 0, 0))
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function endOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 23, 59, 59, 999))
}

function subtractDays(value: Date, days: number): Date {
  return new Date(value.getTime() - days * 24 * 60 * 60 * 1000)
}

function productWhere(filters: StockPositionFilters): ProductWhereInput {
  const productType = PRODUCT_TYPES.includes(filters.productType as typeof PRODUCT_TYPES[number])
    ? filters.productType
    : undefined
  return {
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(productType ? { type: productType } : {}),
    ...(filters.supplierId
      ? {
          supplierProducts: {
            some: { supplierId: filters.supplierId },
          },
        }
      : {}),
  }
}

function keepProduct(product: ProductMeta | undefined, filters: StockPositionFilters): product is ProductMeta {
  const productType = PRODUCT_TYPES.includes(filters.productType as typeof PRODUCT_TYPES[number])
    ? filters.productType
    : undefined
  if (!product) return false
  if (filters.categoryId && product.categoryName == null) return false
  if (productType && product.type !== productType) return false
  if (filters.supplierId && product.supplierNames.length === 0) return false
  return true
}

async function loadFilterOptions(client: typeof db = db): Promise<StockPositionFilterOptions> {
  const [warehouses, categories, suppliers] = await Promise.all([
    client.warehouse.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
    client.productCategory.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    client.supplier.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return {
    warehouses,
    categories,
    suppliers,
    productTypes: [...PRODUCT_TYPES],
  }
}

async function loadProductMeta(productIds: string[], filters: StockPositionFilters = {}, client: typeof db = db): Promise<Map<string, ProductMeta>> {
  if (productIds.length === 0) return new Map()
  const products = await client.product.findMany({
    where: {
      id: { in: Array.from(new Set(productIds)) },
      ...productWhere(filters),
    },
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
  })
  return new Map(products.map((product) => [
    product.id,
    {
      id: product.id,
      sku: product.sku,
      name: product.name,
      type: product.type,
      stockUnit: product.stockUnit,
      categoryName: product.category?.name ?? null,
      supplierNames: product.supplierProducts.map((supplierProduct) => supplierProduct.supplier.name),
    },
  ]))
}

async function loadWarehouseMeta(warehouseIds: string[], client: typeof db = db): Promise<Map<string, WarehouseMeta>> {
  if (warehouseIds.length === 0) return new Map()
  const warehouses = await client.warehouse.findMany({
    where: { id: { in: Array.from(new Set(warehouseIds)) } },
    select: { id: true, code: true, name: true },
  })
  return new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]))
}

async function loadReservedQty(rows: Array<{ productId: string; warehouseId: string }>, client: typeof db = db): Promise<Map<string, Decimal>> {
  if (rows.length === 0) return new Map()
  const pairs = rows.map((row) => ({
    productId: row.productId,
    warehouseId: row.warehouseId,
  }))
  const levels = await client.stockLevel.findMany({
    where: { OR: pairs },
    select: { productId: true, warehouseId: true, reservedQty: true },
  })
  return new Map(levels.map((level) => [
    stockKey(level.productId, level.warehouseId),
    toDecimal(level.reservedQty),
  ]))
}

function stockKey(productId: string, warehouseId: string): string {
  return `${productId}:${warehouseId}`
}

function referenceHref(source: ReservationBreakdownRow['source'], referenceId: string): string | null {
  switch (source) {
    case 'sales_order':
      return `/sales/${referenceId}`
    case 'production_order':
      return `/manufacturing/${referenceId}`
    case 'stock_transfer':
      return `/stock-control/transfers`
    default:
      return null
  }
}

function ageBucket(expectedDate: string | null, now = new Date()): string {
  if (!expectedDate) return 'undated'
  const expected = new Date(expectedDate)
  const days = Math.floor((expected.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  if (days < -30) return 'overdue_31_plus'
  if (days < -7) return 'overdue_8_30'
  if (days < 0) return 'overdue_1_7'
  if (days <= 7) return 'due_0_7'
  if (days <= 30) return 'due_8_30'
  return 'due_31_plus'
}

export async function getStockPositionFilterOptions(deps: StockPositionReportDeps = {}): Promise<StockPositionFilterOptions> {
  return loadFilterOptions(deps.client ?? db)
}

export async function getStockOnHandReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: StockPositionReportDeps } = { paginate: true },
): Promise<StockOnHandReport> {
  const client = options.deps?.client ?? db
  const getOnHandAsOf = options.deps?.getOnHandAsOf ?? defaultGetOnHandAsOf
  const asOfResult = await getOnHandAsOf({
    asOf: filters.asOf,
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    excludeZero: !filters.includeZero,
  })
  const productIds = asOfResult.rows.map((row) => row.productId)
  const warehouseIds = asOfResult.rows.map((row) => row.warehouseId)
  const [products, warehouses, reservedQtyByStock] = await Promise.all([
    loadProductMeta(productIds, filters, client),
    loadWarehouseMeta(warehouseIds, client),
    loadReservedQty(asOfResult.rows, client),
  ])

  const rows = asOfResult.rows
    .map((row): StockOnHandReportRow | null => {
      const product = products.get(row.productId)
      const warehouse = warehouses.get(row.warehouseId)
      if (!keepProduct(product, filters) || !warehouse) return null
      const quantity = toDecimal(row.qty)
      const reservedQty = reservedQtyByStock.get(stockKey(row.productId, row.warehouseId)) ?? ZERO
      const availableQty = quantity.sub(reservedQty)
      return {
        productId: row.productId,
        warehouseId: row.warehouseId,
        sku: product.sku,
        productName: product.name,
        productType: product.type,
        categoryName: product.categoryName,
        supplierNames: product.supplierNames,
        warehouseCode: warehouse.code,
        warehouseName: warehouse.name,
        stockUnit: product.stockUnit,
        quantity: decimalString(quantity),
        reservedQty: decimalString(reservedQty),
        availableQty: decimalString(availableQty),
        unitCostBase: row.unitCostBase,
        totalValueBase: moneyString(toDecimal(row.valueBase)),
      }
    })
    .filter((row): row is StockOnHandReportRow => row != null)
    .sort((a, b) => a.sku.localeCompare(b.sku) || a.warehouseCode.localeCompare(b.warehouseCode))

  const totals = rows.reduce(
    (sum, row) => ({
      quantity: sum.quantity.add(toDecimal(row.quantity)),
      reservedQty: sum.reservedQty.add(toDecimal(row.reservedQty)),
      availableQty: sum.availableQty.add(toDecimal(row.availableQty)),
      totalValueBase: sum.totalValueBase.add(toDecimal(row.totalValueBase)),
    }),
    { quantity: ZERO, reservedQty: ZERO, availableQty: ZERO, totalValueBase: ZERO },
  )
  const paged = options.paginate === false ? { rows, pageInfo: pageInfo(rows.length, 1, Math.max(rows.length, 1)) } : paginate(rows, filters)

  return {
    asOf: asOfResult.asOf,
    generatedAt: asOfResult.generatedAt,
    source: asOfResult.source,
    anchorDate: asOfResult.anchorDate,
    valueReplayReliable: asOfResult.valueReplayReliable,
    reservedQtyScope: 'current',
    missingValueMovementCount: asOfResult.missingValueMovementCount,
    orphanWarehouseMovementCount: asOfResult.orphanWarehouseMovementCount,
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      quantity: decimalString(totals.quantity),
      reservedQty: decimalString(totals.reservedQty),
      availableQty: decimalString(totals.availableQty),
      totalValueBase: moneyString(totals.totalValueBase),
    },
  }
}

export async function getStockAllocationReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: StockPositionReportDeps } = { paginate: true },
): Promise<StockAllocationReport> {
  const client = options.deps?.client ?? db
  const loadReservationSourceRows = options.deps?.loadReservationSourceRows ?? defaultLoadReservationSourceRows
  const stockLevels = await client.stockLevel.findMany({
    where: {
      reservedQty: { gt: 0 },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      product: productWhere(filters),
    },
    select: {
      productId: true,
      warehouseId: true,
      reservedQty: true,
    },
    orderBy: [{ product: { sku: 'asc' } }, { warehouse: { code: 'asc' } }],
  })
  const sourceRows = await loadReservationSourceRows(client as unknown as ReservationBreakdownClient, {
    warehouseId: filters.warehouseId,
  })
  const stockLevelKeys = new Set(stockLevels.map((level) => stockKey(level.productId, level.warehouseId)))
  const rowsByStock = new Map<string, ReservationBreakdownRow[]>()
  for (const row of sourceRows) {
    const key = stockKey(row.productId, row.warehouseId)
    if (!stockLevelKeys.has(key)) continue
    if (!rowsByStock.has(key)) rowsByStock.set(key, [])
    rowsByStock.get(key)!.push(row)
  }

  const [products, warehouses] = await Promise.all([
    loadProductMeta(stockLevels.map((level) => level.productId), filters, client),
    loadWarehouseMeta(stockLevels.map((level) => level.warehouseId), client),
  ])

  const rows: StockAllocationReportRow[] = []
  let totalStockLevelReserved = ZERO
  let totalKnownReserved = ZERO
  let totalDrift = ZERO
  for (const stockLevel of stockLevels) {
    const product = products.get(stockLevel.productId)
    const warehouse = warehouses.get(stockLevel.warehouseId)
    if (!keepProduct(product, filters) || !warehouse) continue

    const key = stockKey(stockLevel.productId, stockLevel.warehouseId)
    const stockLevelReservedQty = toDecimal(stockLevel.reservedQty)
    const knownRows = rowsByStock.get(key) ?? []
    const knownReservedQty = knownRows.reduce((sum, row) => sum.add(toDecimal(row.qty)), ZERO)
    const driftQty = stockLevelReservedQty.sub(knownReservedQty)
    totalStockLevelReserved = totalStockLevelReserved.add(stockLevelReservedQty)
    totalKnownReserved = totalKnownReserved.add(knownReservedQty)
    totalDrift = totalDrift.add(driftQty)

    for (const row of knownRows) {
      rows.push({
        productId: stockLevel.productId,
        warehouseId: stockLevel.warehouseId,
        sku: product.sku,
        productName: product.name,
        productType: product.type,
        categoryName: product.categoryName,
        warehouseCode: warehouse.code,
        warehouseName: warehouse.name,
        stockUnit: product.stockUnit,
        source: row.source,
        referenceId: row.referenceId,
        referenceLabel: row.referenceLabel,
        referenceHref: referenceHref(row.source, row.referenceId),
        expectedDate: row.expectedDate,
        ageBucket: ageBucket(row.expectedDate),
        reservedQty: decimalString(toDecimal(row.qty)),
        stockLevelReservedQty: decimalString(stockLevelReservedQty),
        driftQty: decimalString(driftQty),
      })
    }

    if (driftQty.abs().gt('0.0001')) {
      rows.push({
        productId: stockLevel.productId,
        warehouseId: stockLevel.warehouseId,
        sku: product.sku,
        productName: product.name,
        productType: product.type,
        categoryName: product.categoryName,
        warehouseCode: warehouse.code,
        warehouseName: warehouse.name,
        stockUnit: product.stockUnit,
        source: 'other',
        referenceId: key,
        referenceLabel: 'Unattributed reserved balance',
        referenceHref: null,
        expectedDate: null,
        ageBucket: 'undated',
        reservedQty: decimalString(driftQty),
        stockLevelReservedQty: decimalString(stockLevelReservedQty),
        driftQty: decimalString(driftQty),
      })
    }
  }

  rows.sort((a, b) => a.sku.localeCompare(b.sku)
    || a.warehouseCode.localeCompare(b.warehouseCode)
    || a.source.localeCompare(b.source)
    || a.referenceLabel.localeCompare(b.referenceLabel))
  const paged = options.paginate === false ? { rows, pageInfo: pageInfo(rows.length, 1, Math.max(rows.length, 1)) } : paginate(rows, filters)

  return {
    generatedAt: new Date().toISOString(),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      reservedQty: decimalString(totalKnownReserved.add(totalDrift)),
      stockLevelReservedQty: decimalString(totalStockLevelReserved),
      driftQty: decimalString(totalDrift),
    },
  }
}

type MovementEffect = {
  movementId: string
  createdAt: Date
  type: StockMovementType
  productId: string
  warehouseId: string
  qtyDelta: Decimal
}

function movementEffects(movement: {
  id: string
  createdAt: Date
  type: StockMovementType
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  qty: DecimalInput
}): MovementEffect[] {
  const qty = toDecimal(movement.qty)
  const effects: MovementEffect[] = []
  if (movement.fromWarehouseId) {
    effects.push({
      movementId: movement.id,
      createdAt: movement.createdAt,
      type: movement.type,
      productId: movement.productId,
      warehouseId: movement.fromWarehouseId,
      qtyDelta: qty.neg(),
    })
  }
  if (movement.toWarehouseId) {
    effects.push({
      movementId: movement.id,
      createdAt: movement.createdAt,
      type: movement.type,
      productId: movement.productId,
      warehouseId: movement.toWarehouseId,
      qtyDelta: qty,
    })
  }
  return effects
}

export async function getNegativeStockReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; now?: () => Date; deps?: StockPositionReportDeps } = { paginate: true },
): Promise<NegativeStockReport> {
  const client = options.deps?.client ?? db
  const getOnHandAsOf = options.deps?.getOnHandAsOf ?? defaultGetOnHandAsOf
  const now = options.now?.() ?? new Date()
  const defaultFrom = subtractDays(now, DEFAULT_NEGATIVE_STOCK_LOOKBACK_DAYS)
  const dateFrom = parseDateOnly(filters.dateFrom, defaultFrom)
  const dateTo = endOfUtcDay(parseDateOnly(filters.dateTo, now))
  const openingAsOf = subtractDays(dateFrom, 1)

  const [opening, movements, currentLevels] = await Promise.all([
    getOnHandAsOf({
      asOf: formatDateOnly(openingAsOf),
      warehouseId: filters.warehouseId,
      categoryId: filters.categoryId,
      excludeZero: false,
    }),
    client.stockMovement.findMany({
      where: {
        createdAt: { gte: dateFrom, lte: dateTo },
        ...(filters.warehouseId
          ? { OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] }
          : {}),
        product: productWhere(filters),
      },
      select: {
        id: true,
        createdAt: true,
        type: true,
        productId: true,
        fromWarehouseId: true,
        toWarehouseId: true,
        qty: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    client.stockLevel.findMany({
      where: {
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
        product: productWhere(filters),
      },
      select: { productId: true, warehouseId: true, quantity: true },
    }),
  ])

  const state = new Map<string, Decimal>()
  for (const row of opening.rows) {
    state.set(stockKey(row.productId, row.warehouseId), toDecimal(row.qty))
  }

  const candidates = new Map<string, {
    productId: string
    warehouseId: string
    minimumQty: Decimal
    firstNegativeAt: Date | null
    lastMovementAt: Date | null
    movementCount: number
  }>()

  function candidate(productId: string, warehouseId: string): {
    productId: string
    warehouseId: string
    minimumQty: Decimal
    firstNegativeAt: Date | null
    lastMovementAt: Date | null
    movementCount: number
  } {
    const key = stockKey(productId, warehouseId)
    const existing = candidates.get(key)
    if (existing) return existing
    const created = {
      productId,
      warehouseId,
      minimumQty: state.get(key) ?? ZERO,
      firstNegativeAt: null,
      lastMovementAt: null,
      movementCount: 0,
    }
    candidates.set(key, created)
    return created
  }

  for (const movement of movements) {
    for (const effect of movementEffects(movement)) {
      if (filters.warehouseId && effect.warehouseId !== filters.warehouseId) continue
      const key = stockKey(effect.productId, effect.warehouseId)
      const nextQty = (state.get(key) ?? ZERO).add(effect.qtyDelta)
      state.set(key, nextQty)
      const row = candidate(effect.productId, effect.warehouseId)
      row.movementCount += 1
      row.lastMovementAt = effect.createdAt
      if (nextQty.lt(row.minimumQty)) row.minimumQty = nextQty
      if (nextQty.lt(0) && row.firstNegativeAt == null) row.firstNegativeAt = effect.createdAt
    }
  }

  const currentByStock = new Map(currentLevels.map((level) => [
    stockKey(level.productId, level.warehouseId),
    toDecimal(level.quantity),
  ]))
  for (const level of currentLevels) {
    const currentQty = toDecimal(level.quantity)
    if (currentQty.lt(0)) {
      const row = candidate(level.productId, level.warehouseId)
      if (currentQty.lt(row.minimumQty)) row.minimumQty = currentQty
    }
  }

  const negativeCandidates = Array.from(candidates.values()).filter((row) => {
    const currentQty = currentByStock.get(stockKey(row.productId, row.warehouseId)) ?? ZERO
    return currentQty.lt(0) || row.minimumQty.lt(0)
  })
  const [products, warehouses] = await Promise.all([
    loadProductMeta(negativeCandidates.map((row) => row.productId), filters, client),
    loadWarehouseMeta(negativeCandidates.map((row) => row.warehouseId), client),
  ])

  const rows = negativeCandidates
    .map((row): NegativeStockReportRow | null => {
      const product = products.get(row.productId)
      const warehouse = warehouses.get(row.warehouseId)
      if (!keepProduct(product, filters) || !warehouse) return null
      const currentQty = currentByStock.get(stockKey(row.productId, row.warehouseId)) ?? ZERO
      return {
        productId: row.productId,
        warehouseId: row.warehouseId,
        sku: product.sku,
        productName: product.name,
        productType: product.type,
        categoryName: product.categoryName,
        warehouseCode: warehouse.code,
        warehouseName: warehouse.name,
        stockUnit: product.stockUnit,
        currentQty: decimalString(currentQty),
        minimumQty: decimalString(row.minimumQty),
        firstNegativeAt: row.firstNegativeAt?.toISOString() ?? null,
        lastMovementAt: row.lastMovementAt?.toISOString() ?? null,
        movementCount: row.movementCount,
        status: currentQty.lt(0) ? 'currently_negative' : 'historical_negative',
      }
    })
    .filter((row): row is NegativeStockReportRow => row != null)
    .sort((a, b) => a.sku.localeCompare(b.sku) || a.warehouseCode.localeCompare(b.warehouseCode))

  const minimumQty = rows.reduce((min, row) => {
    const qty = toDecimal(row.minimumQty)
    return qty.lt(min) ? qty : min
  }, ZERO)
  const paged = options.paginate === false ? { rows, pageInfo: pageInfo(rows.length, 1, Math.max(rows.length, 1)) } : paginate(rows, filters)

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
    generatedAt: now.toISOString(),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      currentNegativeRows: rows.filter((row) => row.status === 'currently_negative').length,
      historicalNegativeRows: rows.filter((row) => row.status === 'historical_negative').length,
      minimumQty: decimalString(minimumQty),
    },
  }
}
