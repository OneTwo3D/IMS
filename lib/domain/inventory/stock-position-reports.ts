import { cache } from 'react'
import { Prisma, ProductType, type StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { getOnHandAsOf as defaultGetOnHandAsOf } from '@/lib/domain/inventory/get-on-hand-as-of'
import {
  loadReservationSourceRows as defaultLoadReservationSourceRows,
  type ReservationBreakdownClient,
  type ReservationBreakdownRow,
} from '@/lib/domain/inventory/reservation-breakdown'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { startOfNextUtcDay } from '@/lib/domain/math/date-window'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
export const STOCK_POSITION_FILTER_OPTION_LIMIT = 25
export const STOCK_POSITION_FILTER_OPTION_MAX_LIMIT = 50
export const STOCK_POSITION_FILTER_QUERY_MAX_LENGTH = 100
const DEFAULT_NEGATIVE_STOCK_LOOKBACK_DAYS = 90
const NEGATIVE_STOCK_MOVEMENT_PAGE_SIZE = 10000
const ZERO = new Prisma.Decimal(0)
const PRODUCT_TYPES = Object.values(ProductType)

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

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

type FindUniqueDelegate = {
  findUnique(args?: unknown): Promise<unknown | null>
}

export type StockPositionReportClient = {
  warehouse: FindManyDelegate
  productCategory: FindManyDelegate
  supplier: FindManyDelegate
  product: FindManyDelegate
  stockLevel: FindManyDelegate
  inventoryReservationSnapshot: FindManyDelegate
  inventoryReservationSnapshotRun: FindUniqueDelegate
  stockMovement: FindManyDelegate
}

export type StockPositionReportDeps = {
  client?: StockPositionReportClient
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
  thresholdDays?: number
  // audit-00o7: reorder-report-only filters (other stock-position reports ignore
  // these, like thresholdDays). Applied inside getReorderReport.
  abcClass?: 'A' | 'B' | 'C'
  urgency?: 'critical' | 'reorder' | 'watch'
  search?: string
  // audit-32cl: target weeks of supply for the order-up-to suggested quantity
  // (reorder-report-only). Defaults to DEFAULT_TARGET_COVER_WEEKS when unset.
  targetCoverWeeks?: number
  page?: number
  pageSize?: number
}

export type StockPositionFilterOption = {
  id: string
  label: string
  description?: string
}

export type StockPositionFilterOptionType = 'warehouse' | 'category' | 'supplier'

export type StockPositionFilterOptionPage = {
  options: StockPositionFilterOption[]
  hasMore: boolean
  limit: number
  selectedHydrated: boolean
}

export type StockPositionFilterOptions = {
  warehouses: StockPositionFilterOption[]
  categories: StockPositionFilterOption[]
  suppliers: StockPositionFilterOption[]
  productTypes: ProductType[]
}

export type StockPositionFilterOptionInputs = {
  selectedWarehouseId?: string
  selectedCategoryId?: string
  selectedSupplierId?: string
  limit?: number
}

export type StockPositionFilterOptionSearch = {
  type: StockPositionFilterOptionType
  query?: string
  selectedId?: string
  limit?: number
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
  reservationQtySource: StockOnHandReservationQtySource
  reservationSnapshotDate: string | null
  reservationSourceCount: number | null
  unitCostBase: string | null
  totalValueBase: string
}

export type StockOnHandReservationQtySource =
  | 'current'
  | 'snapshot'
  | 'snapshot_zero'
  | 'current_missing_snapshot'

export type StockOnHandReservedQtyScope =
  | 'current'
  | 'snapshot'
  | 'current_missing_snapshot'
  | 'mixed_snapshot_current_missing'

export type StockOnHandReport = {
  asOf: string
  generatedAt: string
  source: string
  anchorDate: string | null
  valueReplayReliable: boolean
  reservedQtyScope: StockOnHandReservedQtyScope
  reservationSnapshotDate: string | null
  reservationSnapshotCount: number
  missingReservationSnapshotCount: number
  currentReservationFallbackCount: number
  missingValueMovementCount: number
  orphanWarehouseMovementCount: number
  currentValueDriftCount: number
  postAsOfRevaluationCount: number
  staleSnapshotCount: number
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

type ProductMetaQueryRow = {
  id: string
  sku: string
  name: string
  type: ProductType
  stockUnit: string
  category: { name: string } | null
  supplierProducts: Array<{ supplier: { name: string } }>
}

type ReservedStockLevelRow = {
  productId: string
  warehouseId: string
  reservedQty: DecimalInput
}

type ReservationSnapshotReportRow = {
  productId: string
  warehouseId: string
  reservedQty: DecimalInput
  availableQty: DecimalInput
  reservationSourceCount: number
}

type ReservationSnapshotRunReportRow = {
  snapshotDate: Date
  stockLevelCount: number
  reservationSnapshotCount: number
}

type StockLevelQuantityRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
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

function clampFilterOptionLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return STOCK_POSITION_FILTER_OPTION_LIMIT
  return Math.min(parsed, STOCK_POSITION_FILTER_OPTION_MAX_LIMIT)
}

function normalizeFilterOptionQuery(value: string | undefined): string | undefined {
  const query = value
    ?.normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STOCK_POSITION_FILTER_QUERY_MAX_LENGTH)
  return query || undefined
}

export function normalizeStockPositionFilterOptionId(value: string | undefined | null): string | undefined {
  const id = value?.trim()
  if (!id || id.length > 100) return undefined
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined
}

export function stockPositionSelectedFilterOptionInputs(
  filters: Pick<StockPositionFilters, 'warehouseId' | 'categoryId' | 'supplierId'>,
): StockPositionFilterOptionInputs {
  return {
    selectedWarehouseId: filters.warehouseId,
    selectedCategoryId: filters.categoryId,
    selectedSupplierId: filters.supplierId,
  }
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

function subtractDays(value: Date, days: number): Date {
  return new Date(value.getTime() - days * 24 * 60 * 60 * 1000)
}

function productWhere(filters: StockPositionFilters): ProductWhereInput {
  const productType = PRODUCT_TYPES.includes(filters.productType as ProductType)
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
  const productType = PRODUCT_TYPES.includes(filters.productType as ProductType)
    ? filters.productType
    : undefined
  if (!product) return false
  if (productType && product.type !== productType) return false
  if (filters.supplierId && product.supplierNames.length === 0) return false
  return true
}

function warehouseOption(row: { id: string; code: string; name: string; active?: boolean }): StockPositionFilterOption {
  const label = `${row.code} - ${row.name}`
  return {
    id: row.id,
    label: row.active === false ? `${label} (inactive)` : label,
    description: row.code,
  }
}

function namedOption(row: { id: string; name: string; active?: boolean }): StockPositionFilterOption {
  return {
    id: row.id,
    label: row.active === false ? `${row.name} (inactive)` : row.name,
  }
}

function mergeSelectedOption(
  options: StockPositionFilterOption[],
  selected: StockPositionFilterOption | null,
  limit = STOCK_POSITION_FILTER_OPTION_LIMIT,
): { options: StockPositionFilterOption[]; selectedHydrated: boolean } {
  if (!selected || options.some((option) => option.id === selected.id)) {
    return { options: options.slice(0, limit), selectedHydrated: false }
  }
  return { options: [selected, ...options].slice(0, limit), selectedHydrated: true }
}

async function findSelectedWarehouseOption(
  client: StockPositionReportClient,
  selectedId: string | undefined,
): Promise<StockPositionFilterOption | null> {
  const id = normalizeStockPositionFilterOptionId(selectedId)
  if (!id) return null
  const rows = await client.warehouse.findMany({
    where: { id },
    select: { id: true, code: true, name: true, active: true },
    take: 1,
  }) as Array<{ id: string; code: string; name: string; active?: boolean }>
  return rows[0] ? warehouseOption(rows[0]) : null
}

async function findSelectedNamedOption(
  delegate: FindManyDelegate,
  selectedId: string | undefined,
  selectActive = false,
): Promise<StockPositionFilterOption | null> {
  const id = normalizeStockPositionFilterOptionId(selectedId)
  if (!id) return null
  const rows = await delegate.findMany({
    where: { id },
    select: selectActive ? { id: true, name: true, active: true } : { id: true, name: true },
    take: 1,
  }) as Array<{ id: string; name: string; active?: boolean }>
  return rows[0] ? namedOption(rows[0]) : null
}

async function loadWarehouseFilterOptions(input: {
  client: StockPositionReportClient
  query?: string
  selectedId?: string
  limit?: number
}): Promise<StockPositionFilterOptionPage> {
  const limit = clampFilterOptionLimit(input.limit)
  const query = normalizeFilterOptionQuery(input.query)
  const [rows, selected] = await Promise.all([
    input.client.warehouse.findMany({
      where: {
        active: true,
        ...(query
          ? {
              OR: [
                { code: { contains: query, mode: 'insensitive' } },
                { name: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, code: true, name: true, active: true },
      orderBy: [{ code: 'asc' }, { name: 'asc' }],
      take: limit + 1,
    }) as Promise<Array<{ id: string; code: string; name: string; active?: boolean }>>,
    findSelectedWarehouseOption(input.client, input.selectedId),
  ])
  const merged = mergeSelectedOption(rows.slice(0, limit).map(warehouseOption), selected, limit)
  return {
    options: merged.options,
    hasMore: rows.length > limit,
    limit,
    selectedHydrated: merged.selectedHydrated,
  }
}

async function loadNamedFilterOptions(input: {
  delegate: FindManyDelegate
  query?: string
  selectedId?: string
  limit?: number
  activeOnly?: boolean
}): Promise<StockPositionFilterOptionPage> {
  const limit = clampFilterOptionLimit(input.limit)
  const query = normalizeFilterOptionQuery(input.query)
  const [rows, selected] = await Promise.all([
    input.delegate.findMany({
      where: {
        ...(input.activeOnly ? { active: true } : {}),
        ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: limit + 1,
    }) as Promise<Array<{ id: string; name: string }>>,
    findSelectedNamedOption(input.delegate, input.selectedId, input.activeOnly),
  ])
  const merged = mergeSelectedOption(rows.slice(0, limit).map(namedOption), selected, limit)
  return {
    options: merged.options,
    hasMore: rows.length > limit,
    limit,
    selectedHydrated: merged.selectedHydrated,
  }
}

async function loadFilterOptions(
  input: StockPositionFilterOptionInputs = {},
  client: StockPositionReportClient = db as StockPositionReportClient,
): Promise<StockPositionFilterOptions> {
  const [warehouses, categories, suppliers] = await Promise.all([
    loadWarehouseFilterOptions({
      client,
      selectedId: input.selectedWarehouseId,
      limit: input.limit,
    }),
    loadNamedFilterOptions({
      delegate: client.productCategory,
      selectedId: input.selectedCategoryId,
      limit: input.limit,
      // ProductCategory has no active flag in Prisma; archived-category
      // filtering is intentionally asymmetric with Supplier/Warehouse.
    }),
    loadNamedFilterOptions({
      delegate: client.supplier,
      selectedId: input.selectedSupplierId,
      limit: input.limit,
      activeOnly: true,
    }),
  ])

  return {
    warehouses: warehouses.options,
    categories: categories.options,
    suppliers: suppliers.options,
    productTypes: [...PRODUCT_TYPES],
  }
}

export async function getStockPositionFilterOptionPage(
  input: StockPositionFilterOptionSearch,
  deps: StockPositionReportDeps = {},
): Promise<StockPositionFilterOptionPage> {
  const client = deps.client ?? db as StockPositionReportClient
  switch (input.type) {
    case 'warehouse':
      return loadWarehouseFilterOptions({
        client,
        query: input.query,
        selectedId: input.selectedId,
        limit: input.limit,
      })
    case 'category':
      return loadNamedFilterOptions({
        delegate: client.productCategory,
        query: input.query,
        selectedId: input.selectedId,
        limit: input.limit,
      })
    case 'supplier':
      return loadNamedFilterOptions({
        delegate: client.supplier,
        query: input.query,
        selectedId: input.selectedId,
        limit: input.limit,
        activeOnly: true,
      })
  }
}

const getCachedFilterOptions = cache(() => loadFilterOptions({}, db as StockPositionReportClient))

async function hydrateSelectedFilterOptions(
  options: StockPositionFilterOptions,
  input: StockPositionFilterOptionInputs,
  client: StockPositionReportClient,
): Promise<StockPositionFilterOptions> {
  const [warehouse, category, supplier] = await Promise.all([
    findSelectedWarehouseOption(client, input.selectedWarehouseId),
    findSelectedNamedOption(client.productCategory, input.selectedCategoryId),
    findSelectedNamedOption(client.supplier, input.selectedSupplierId, true),
  ])
  return {
    ...options,
    warehouses: mergeSelectedOption(options.warehouses, warehouse).options,
    categories: mergeSelectedOption(options.categories, category).options,
    suppliers: mergeSelectedOption(options.suppliers, supplier).options,
  }
}

async function loadProductMeta(productIds: string[], filters: StockPositionFilters = {}, client: StockPositionReportClient = db as StockPositionReportClient): Promise<Map<string, ProductMeta>> {
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
  }) as ProductMetaQueryRow[]
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

async function loadWarehouseMeta(warehouseIds: string[], client: StockPositionReportClient = db as StockPositionReportClient): Promise<Map<string, WarehouseMeta>> {
  if (warehouseIds.length === 0) return new Map()
  const warehouses = await client.warehouse.findMany({
    where: { id: { in: Array.from(new Set(warehouseIds)) } },
    select: { id: true, code: true, name: true },
  }) as WarehouseMeta[]
  return new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]))
}

function stockKey(productId: string, warehouseId: string): string {
  return `${productId}:${warehouseId}`
}

async function loadReservedQty(rows: Array<{ productId: string; warehouseId: string }>, client: StockPositionReportClient = db as StockPositionReportClient): Promise<Map<string, Decimal>> {
  if (rows.length === 0) return new Map()
  const productIds = Array.from(new Set(rows.map((row) => row.productId)))
  const warehouseIds = Array.from(new Set(rows.map((row) => row.warehouseId)))
  const requestedKeys = new Set(rows.map((row) => stockKey(row.productId, row.warehouseId)))
  const levels = await client.stockLevel.findMany({
    where: {
      productId: { in: productIds },
      warehouseId: { in: warehouseIds },
    },
    select: { productId: true, warehouseId: true, reservedQty: true },
  }) as ReservedStockLevelRow[]
  return new Map(levels
    .filter((level) => requestedKeys.has(stockKey(level.productId, level.warehouseId)))
    .map((level) => [
      stockKey(level.productId, level.warehouseId),
      toDecimal(level.reservedQty),
    ]))
}

async function loadReservationSnapshots(
  rows: Array<{ productId: string; warehouseId: string }>,
  snapshotDate: Date,
  client: StockPositionReportClient = db as StockPositionReportClient,
): Promise<Map<string, ReservationSnapshotReportRow>> {
  if (rows.length === 0) return new Map()
  const productIds = Array.from(new Set(rows.map((row) => row.productId)))
  const warehouseIds = Array.from(new Set(rows.map((row) => row.warehouseId)))
  const requestedKeys = new Set(rows.map((row) => stockKey(row.productId, row.warehouseId)))
  const snapshots = await client.inventoryReservationSnapshot.findMany({
    where: {
      snapshotDate,
      productId: { in: productIds },
      warehouseId: { in: warehouseIds },
    },
    select: {
      productId: true,
      warehouseId: true,
      reservedQty: true,
      availableQty: true,
      reservationSourceCount: true,
    },
  }) as ReservationSnapshotReportRow[]
  return new Map(snapshots
    // productId/warehouseId IN filters form a cartesian superset; keep only
    // the exact product/warehouse pairs requested by the report rows.
    .filter((snapshot) => requestedKeys.has(stockKey(snapshot.productId, snapshot.warehouseId)))
    .map((snapshot) => [stockKey(snapshot.productId, snapshot.warehouseId), snapshot]))
}

async function loadReservationSnapshotRun(
  snapshotDate: Date,
  client: StockPositionReportClient = db as StockPositionReportClient,
): Promise<ReservationSnapshotRunReportRow | null> {
  return await client.inventoryReservationSnapshotRun.findUnique({
    where: { snapshotDate },
    select: {
      snapshotDate: true,
      stockLevelCount: true,
      reservationSnapshotCount: true,
    },
  }) as ReservationSnapshotRunReportRow | null
}

function isEndOfUtcDay(value: Date): boolean {
  return value.getUTCHours() === 23 &&
    value.getUTCMinutes() === 59 &&
    value.getUTCSeconds() === 59 &&
    value.getUTCMilliseconds() === 999
}

function isReservationSnapshotEligibleSource(source: string): boolean {
  return source === 'snapshot_forward_replay' || source === 'future_snapshot_reverse_replay'
}

function snapshotDateFromAsOf(asOf: string): Date | null {
  // getOnHandAsOf date-only inputs return end-of-day UTC. Reservation snapshots
  // are daily end-of-day evidence, so mid-day asOf values cannot use them.
  const value = new Date(asOf)
  if (Number.isNaN(value.getTime()) || !isEndOfUtcDay(value)) return null
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

function reservationScopeFromCounts(input: {
  historical: boolean
  rows: number
  snapshotRows: number
  missingRows: number
}): StockOnHandReservedQtyScope {
  if (!input.historical) return 'current'
  if (input.rows === 0) return 'current'
  if (input.snapshotRows === input.rows) return 'snapshot'
  if (input.snapshotRows === 0 && input.missingRows > 0) return 'current_missing_snapshot'
  return 'mixed_snapshot_current_missing'
}

function referenceHref(source: ReservationBreakdownRow['source'], referenceId: string): string | null {
  switch (source) {
    case 'sales_order':
      return `/sales/${referenceId}`
    case 'production_order':
      return `/manufacturing/${referenceId}`
    case 'stock_transfer':
      return null
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

export async function getStockPositionFilterOptions(
  input: StockPositionFilterOptionInputs = {},
  deps: StockPositionReportDeps = {},
): Promise<StockPositionFilterOptions> {
  if (deps.client) return loadFilterOptions(input, deps.client)
  if (input.limit && clampFilterOptionLimit(input.limit) !== STOCK_POSITION_FILTER_OPTION_LIMIT) {
    return loadFilterOptions(input, db as StockPositionReportClient)
  }
  const options = await getCachedFilterOptions()
  const hasSelection = Boolean(input.selectedWarehouseId || input.selectedCategoryId || input.selectedSupplierId)
  return hasSelection
    ? hydrateSelectedFilterOptions(options, input, db as StockPositionReportClient)
    : options
}

export async function getStockOnHandReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; deps?: StockPositionReportDeps } = { paginate: true },
): Promise<StockOnHandReport> {
  const client = options.deps?.client ?? db as StockPositionReportClient
  const getOnHandAsOf = options.deps?.getOnHandAsOf ?? defaultGetOnHandAsOf
  const asOfResult = await getOnHandAsOf({
    asOf: filters.asOf,
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    productType: filters.productType,
    supplierId: filters.supplierId,
    excludeZero: !filters.includeZero,
  })
  const productIds = asOfResult.rows.map((row) => row.productId)
  const warehouseIds = asOfResult.rows.map((row) => row.warehouseId)
  const reservationSnapshotDate = isReservationSnapshotEligibleSource(asOfResult.source)
    ? snapshotDateFromAsOf(asOfResult.asOf)
    : null
  const historicalReservationMode = reservationSnapshotDate !== null
  const [products, warehouses, reservationSnapshotsByStock, reservationSnapshotRun] = await Promise.all([
    loadProductMeta(productIds, filters, client),
    loadWarehouseMeta(warehouseIds, client),
    reservationSnapshotDate
      ? loadReservationSnapshots(asOfResult.rows, reservationSnapshotDate, client)
      : Promise.resolve(new Map<string, ReservationSnapshotReportRow>()),
    reservationSnapshotDate
      ? loadReservationSnapshotRun(reservationSnapshotDate, client)
      : Promise.resolve(null),
  ])
  const rowsNeedingLiveReservations = asOfResult.rows.filter((row) => {
    if (!historicalReservationMode) return true
    const key = stockKey(row.productId, row.warehouseId)
    if (reservationSnapshotsByStock.has(key)) return false
    return reservationSnapshotRun == null
  })
  const reservedQtyByStock = await loadReservedQty(rowsNeedingLiveReservations, client)

  let reservationSnapshotCount = 0
  let missingReservationSnapshotCount = 0
  let currentReservationFallbackCount = 0
  const rows = asOfResult.rows
    .map((row): StockOnHandReportRow | null => {
      const product = products.get(row.productId)
      const warehouse = warehouses.get(row.warehouseId)
      if (!keepProduct(product, filters) || !warehouse) return null
      const quantity = toDecimal(row.qty)
      const key = stockKey(row.productId, row.warehouseId)
      const reservationSnapshot = reservationSnapshotsByStock.get(key)
      const reservationQtySource: StockOnHandReservationQtySource = reservationSnapshot
        ? 'snapshot'
        : historicalReservationMode && reservationSnapshotRun
          ? 'snapshot_zero'
        : historicalReservationMode
          ? 'current_missing_snapshot'
          : 'current'
      const reservedQty = reservationSnapshot
        ? toDecimal(reservationSnapshot.reservedQty)
        : reservationQtySource === 'snapshot_zero'
          ? ZERO
        : reservedQtyByStock.get(key) ?? ZERO
      const availableQty = reservationSnapshot
        ? toDecimal(reservationSnapshot.availableQty)
        : reservationQtySource === 'snapshot_zero'
          ? quantity
        : quantity.sub(reservedQty)
      if (reservationQtySource === 'snapshot' || reservationQtySource === 'snapshot_zero') {
        reservationSnapshotCount += 1
      } else if (historicalReservationMode) {
        missingReservationSnapshotCount += 1
        currentReservationFallbackCount += 1
      }
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
        reservationQtySource,
        reservationSnapshotDate: reservationSnapshotDate ? formatDateOnly(reservationSnapshotDate) : null,
        reservationSourceCount: reservationQtySource === 'snapshot_zero'
          ? 0
          : reservationSnapshot?.reservationSourceCount ?? null,
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
    reservedQtyScope: reservationScopeFromCounts({
      historical: historicalReservationMode,
      rows: rows.length,
      snapshotRows: reservationSnapshotCount,
      missingRows: missingReservationSnapshotCount,
    }),
    reservationSnapshotDate: reservationSnapshotDate ? formatDateOnly(reservationSnapshotDate) : null,
    reservationSnapshotCount,
    missingReservationSnapshotCount,
    currentReservationFallbackCount,
    missingValueMovementCount: asOfResult.missingValueMovementCount,
    orphanWarehouseMovementCount: asOfResult.orphanWarehouseMovementCount,
    currentValueDriftCount: asOfResult.currentValueDriftCount,
    postAsOfRevaluationCount: asOfResult.postAsOfRevaluationCount,
    staleSnapshotCount: asOfResult.staleSnapshotCount,
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
  const client = options.deps?.client ?? db as StockPositionReportClient
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
  }) as ReservedStockLevelRow[]
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
      const driftKind = driftQty.gt(0) ? 'unattributed' : 'over_attributed'
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
        referenceId: `other:${driftKind}:${key}`,
        referenceLabel: driftQty.gt(0) ? 'Unattributed reserved balance' : 'Over-attributed reserved balance',
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
      reservedQty: decimalString(totalKnownReserved),
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

type NegativeStockMovementRow = {
  id: string
  createdAt: Date
  type: StockMovementType
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  qty: DecimalInput
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

async function loadNegativeStockMovements(
  client: StockPositionReportClient,
  where: Prisma.StockMovementWhereInput,
): Promise<NegativeStockMovementRow[]> {
  const rows: NegativeStockMovementRow[] = []
  let cursor: { id: string } | undefined

  while (true) {
    const page = await client.stockMovement.findMany({
      where,
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
      take: NEGATIVE_STOCK_MOVEMENT_PAGE_SIZE,
      ...(cursor ? { cursor, skip: 1 } : {}),
    }) as NegativeStockMovementRow[]
    rows.push(...page)
    if (page.length < NEGATIVE_STOCK_MOVEMENT_PAGE_SIZE) break
    cursor = { id: page[page.length - 1]!.id }
  }

  return rows
}

export async function getNegativeStockReport(
  filters: StockPositionFilters = {},
  options: { paginate?: boolean; now?: () => Date; deps?: StockPositionReportDeps } = { paginate: true },
): Promise<NegativeStockReport> {
  const client = options.deps?.client ?? db as StockPositionReportClient
  const getOnHandAsOf = options.deps?.getOnHandAsOf ?? defaultGetOnHandAsOf
  const now = options.now?.() ?? new Date()
  const defaultFrom = subtractDays(now, DEFAULT_NEGATIVE_STOCK_LOOKBACK_DAYS)
  const dateFrom = parseDateOnly(filters.dateFrom, defaultFrom)
  const dateTo = parseDateOnly(filters.dateTo, now)
  const dateToExclusive = startOfNextUtcDay(dateTo)
  // The opening balance is the end of the previous UTC day; movements inside
  // dateFrom..dateTo are then replayed inclusively to find the trough.
  const openingAsOf = subtractDays(dateFrom, 1)
  const movementWhere: Prisma.StockMovementWhereInput = {
    createdAt: { gte: dateFrom, lt: dateToExclusive },
    ...(filters.warehouseId
      ? { OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] }
      : {}),
    product: productWhere(filters),
  }

  const [opening, movements, currentLevels] = await Promise.all([
    getOnHandAsOf({
      asOf: formatDateOnly(openingAsOf),
      warehouseId: filters.warehouseId,
      categoryId: filters.categoryId,
      productType: filters.productType,
      supplierId: filters.supplierId,
      excludeZero: false,
    }),
    loadNegativeStockMovements(client, movementWhere),
    client.stockLevel.findMany({
      where: {
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
        product: productWhere(filters),
      },
      select: { productId: true, warehouseId: true, quantity: true },
    }) as Promise<StockLevelQuantityRow[]>,
  ])

  const openingState = new Map<string, Decimal>()
  for (const row of opening.rows) {
    openingState.set(stockKey(row.productId, row.warehouseId), toDecimal(row.qty))
  }
  const state = new Map(openingState)

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
      minimumQty: openingState.get(key) ?? ZERO,
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
