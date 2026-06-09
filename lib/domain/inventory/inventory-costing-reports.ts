import { LandedCostMethod, Prisma, StockMovementType } from '@/app/generated/prisma/client'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { db } from '@/lib/db'
import {
  calculateAccountBalanceVarianceBase,
  findLatestAccountBalanceSnapshot,
  getAccountBalancePeriodMovement,
  MissingAccountBalanceSnapshotError,
} from '@/lib/domain/accounting/account-balance-snapshots'
import { getOnHandAsOf, type OnHandAsOfRow } from '@/lib/domain/inventory/get-on-hand-as-of'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'
import { calculateInventoryTurnover, normalizeVelocityWindow } from '@/lib/domain/inventory/velocity'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly as utcDateOnly, exclusiveEndOfUtcDay, parseDateOnly as parseUtcDateOnly, subtractUtcDays } from '@/lib/domain/math/date-window'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import { syncXeroAccountBalanceSnapshots } from '@/lib/connectors/xero/account-balances'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { cache } from 'react'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const INVENTORY_COSTING_EXPORT_ROW_LIMIT = 100000
const SOURCE_SCAN_PAGE_SIZE = 1000
const INVENTORY_TURNOVER_COGS_SOURCE_ROW_LIMIT = 100000
const INVENTORY_TURNOVER_SNAPSHOT_SOURCE_ROW_LIMIT = 100000
const NEAR_ZERO_LANDED_GOODS_UNIT_COST_BASE = '0.01'
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

const COGS_GROUPS = ['product', 'category', 'warehouse', 'customer', 'channel'] as const
export const INVENTORY_TURNOVER_GROUP_OPTIONS = [
  { value: 'product', label: 'Product' },
  { value: 'category', label: 'Category' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'supplier', label: 'Supplier' },
] as const
const INVENTORY_TURNOVER_GROUPS = INVENTORY_TURNOVER_GROUP_OPTIONS.map((option) => option.value)
const LANDED_COST_METHODS = new Set(Object.values(LandedCostMethod))

export type InventoryCostingReportType = 'inventory-valuation' | 'cogs' | 'landed-cost' | 'inventory-turnover'
export type CogsGroupBy = typeof COGS_GROUPS[number]
export type InventoryTurnoverGroupBy = typeof INVENTORY_TURNOVER_GROUPS[number]
export type InventoryCostingGroupBy = CogsGroupBy | InventoryTurnoverGroupBy

export type InventoryCostingSearchParams = Record<string, string | string[] | undefined>

export type InventoryCostingFilters = {
  asOf?: string
  dateFrom?: string
  dateTo?: string
  warehouseId?: string
  categoryId?: string
  supplierId?: string
  product?: string
  includeZero?: boolean
  groupBy?: InventoryCostingGroupBy
  landedCostMethod?: LandedCostMethod
  page?: number
  pageSize?: number
}

export type InventoryCostingFilterUiValues = {
  asOf?: string
  dateFrom?: string
  dateTo?: string
  warehouseId?: string
  categoryId?: string
  supplierId?: string
  product?: string
  includeZero?: boolean
  groupBy?: string
  landedCostMethod?: string
  pageSize?: string
}

export type InventoryValuationReportRow = {
  productId: string
  warehouseId: string
  sku: string
  productName: string
  categoryName: string | null
  supplierNames: string[]
  warehouseCode: string
  warehouseName: string
  stockUnit: string
  qty: string
  unitCostBase: string | null
  totalValueBase: string
  glBalanceBase: string | null
  glVarianceBase: string | null
}

export type InventoryValuationReport = {
  asOf: string
  generatedAt: string
  source: string
  anchorDate: string | null
  valueReplayReliable: boolean
  missingValueMovementCount: number
  orphanWarehouseMovementCount: number
  rows: InventoryValuationReportRow[]
  pageInfo: PageInfo
  totals: {
    qty: string
    totalValueBase: string
    glBalanceBase: string | null
    glVarianceBase: string | null
  }
  notices: string[]
}

export type CogsReportRow = {
  groupKey: string
  groupLabel: string
  sku: string | null
  productId: string | null
  productName: string | null
  categoryName: string | null
  warehouseCode: string | null
  customerName: string | null
  channel: string | null
  qty: string
  cogsBase: string
  revenueBase: string | null
  grossMarginBase: string | null
  grossMarginPct: string | null
  movementCount: number
  revenueCaptured: boolean
}

export type CogsReport = {
  dateFrom: string
  dateTo: string
  generatedAt: string
  groupBy: CogsGroupBy
  rows: CogsReportRow[]
  pageInfo: PageInfo
  totals: {
    qty: string
    cogsBase: string
    revenueBase: string
    grossMarginBase: string
    revenueCapturedRows: number
    glBalanceBase: string | null
    glVarianceBase: string | null
  }
  notices: string[]
}

export type InventoryTurnoverReportRow = {
  groupKey: string
  groupLabel: string
  sku: string | null
  productId: string | null
  productName: string | null
  categoryName: string | null
  warehouseCode: string | null
  supplierName: string | null
  cogsBase: string
  averageInventoryValueBase: string
  turnoverRatio: string | null
  daysInventoryOutstanding: string | null
  cogsEntryCount: number
  snapshotDayCount: number
}

export type InventoryTurnoverReport = {
  dateFrom: string
  dateTo: string
  generatedAt: string
  groupBy: InventoryTurnoverGroupBy
  periodDays: number
  rows: InventoryTurnoverReportRow[]
  pageInfo: PageInfo
  totals: {
    cogsBase: string
    averageInventoryValueBase: string
    turnoverRatio: string | null
    daysInventoryOutstanding: string | null
    cogsEntryCount: number
    snapshotDayCount: number
  }
  notices: string[]
}

export class InventoryTurnoverSourceLimitError extends SourceScanTooLargeError {
  source: 'COGS' | 'snapshot'
  rowCount: number
  limit: number

  constructor(source: 'COGS' | 'snapshot', rowCount: number, limit: number) {
    super(`Inventory turnover ${source} scan`, limit, {
      rowCount,
      message: `Inventory turnover ${source} scan exceeds ${limit.toLocaleString()} rows. Narrow the date range or filters and retry.`,
    })
    this.name = 'InventoryTurnoverSourceLimitError'
    this.source = source
    this.rowCount = rowCount
    this.limit = limit
  }
}

export type LandedCostReportRow = {
  poId: string
  poReference: string
  supplierName: string
  status: string
  createdAt: string
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  qty: string
  goodsUnitCostBase: string
  landedUnitCostBase: string
  landedUpliftUnitBase: string
  landedUpliftPct: string | null
  goodsValueBase: string
  landedValueBase: string
  landedCostMethod: LandedCostMethod
  revaluationCount: number
}

export type LandedCostReport = {
  dateFrom: string
  dateTo: string
  generatedAt: string
  rows: LandedCostReportRow[]
  pageInfo: PageInfo
  totals: {
    qty: string
    goodsValueBase: string
    landedValueBase: string
    upliftBase: string
    revaluationRuns: number
  }
  methodSummary: Array<{ method: LandedCostMethod; poLineCount: number; goodsValueBase: string; landedValueBase: string; upliftBase: string }>
  notices: string[]
}

type ProductMeta = {
  id: string
  sku: string
  name: string
  stockUnit: string
  category: { name: string } | null
  supplierProducts: Array<{ supplier: { id: string; name: string } }>
}

type WarehouseMeta = {
  id: string
  code: string
  name: string
}

type CogsEntryRow = {
  id: string
  qty: DecimalInput
  totalCostBase: DecimalInput
  createdAt: Date
  movement: {
    id: string
    referenceType: string | null
    referenceId: string | null
    fromWarehouseId: string | null
    toWarehouseId: string | null
    product: ProductMeta
    fromWarehouse: WarehouseMeta | null
    toWarehouse: WarehouseMeta | null
  }
}

type SalesOrderRevenueRow = {
  id: string
  customerName: string | null
  shoppingLinks: Array<{ connector: string }>
  lines: Array<{ productId: string | null; totalBase: DecimalInput }>
}

type LandedCostLineRow = {
  id: string
  qty: DecimalInput
  unitCostBase: DecimalInput
  landedUnitCostBase: DecimalInput
  product: ProductMeta
  po: {
    id: string
    reference: string
    status: string
    createdAt: Date
    landedCostMethod: LandedCostMethod
    supplier: { name: string }
  }
}

type InventoryTurnoverSnapshotRow = {
  id: string
  snapshotDate: Date
  productId: string
  warehouseId: string
  valueBase: DecimalInput
  product: ProductMeta
  warehouse: WarehouseMeta
}

export type InventoryTurnoverCogsAggregationInput = {
  id: string
  cogsBase: DecimalInput
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  warehouseId: string | null
  warehouseCode: string | null
  warehouseName: string | null
  suppliers: Array<{ id: string; name: string }>
}

export type InventoryTurnoverSnapshotAggregationInput = {
  id: string
  snapshotDate: string | Date
  inventoryValueBase: DecimalInput
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  suppliers: Array<{ id: string; name: string }>
}

type RevenueKey = {
  orderId: string
  productId: string
}

export type CogsAggregationInput = {
  id: string
  qty: DecimalInput
  cogsBase: DecimalInput
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  warehouseId: string | null
  warehouseCode: string | null
  warehouseName: string | null
  customerName: string | null
  channel: string | null
  revenueKey?: string | null
  revenueBase: DecimalInput | null
}

export type LandedCostAggregationInput = {
  method: LandedCostMethod
  qty: DecimalInput
  goodsValueBase: DecimalInput
  landedValueBase: DecimalInput
}

type ProductWhere = Prisma.ProductWhereInput
type InventoryTurnoverReportClient = Pick<typeof db, 'cogsEntry' | 'inventorySnapshot'>
type ReportOptions = {
  paginate?: boolean
  client?: InventoryTurnoverReportClient
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

function clampPage(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 1
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(value!)))
}

function oneSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function isValidDateOnly(value: string | undefined): value is string {
  if (!value || !DATE_ONLY_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year!, month! - 1, day!))
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
}

function dateSearchParam(value: string | string[] | undefined): string | undefined {
  const param = oneSearchParam(value)
  return isValidDateOnly(param) ? param : undefined
}

function today(): string {
  return utcDateOnly(new Date())
}

function daysAgo(days: number): string {
  return utcDateOnly(subtractUtcDays(new Date(), days))
}

function parseDateOnly(value: string | undefined, fallback: string, endOfDay = false): Date {
  const source = isValidDateOnly(value) ? value : fallback
  return parseUtcDateOnly(source, parseUtcDateOnly(fallback, new Date()), { endOfDay })
}

function formatDateTime(value: Date): string {
  return value.toISOString()
}

function decimalString(value: DecimalInput, places = 4): string {
  return roundQuantity(value, places).toString()
}

function moneyString(value: DecimalInput): string {
  return roundQuantity(value, 6).toFixed(6)
}

function decimalZero(): Decimal {
  return toDecimal(0)
}

function productNameFilter(product: string | undefined): ProductWhere {
  const trimmed = product?.trim()
  if (!trimmed) return {}
  return {
    OR: [
      { sku: { contains: trimmed, mode: 'insensitive' } },
      { name: { contains: trimmed, mode: 'insensitive' } },
    ],
  }
}

function productWhere(filters: InventoryCostingFilters): ProductWhere {
  return {
    ...productNameFilter(filters.product),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.supplierId
      ? { supplierProducts: { some: { supplierId: filters.supplierId } } }
      : {}),
  }
}

function supplierNames(product: ProductMeta): string[] {
  return product.supplierProducts.map((entry) => entry.supplier.name).sort((a, b) => a.localeCompare(b))
}

function supplierMetas(product: ProductMeta): Array<{ id: string; name: string }> {
  return product.supplierProducts
    .map((entry) => entry.supplier)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

const loadConfiguredAccountingContext = cache(async (): Promise<{ connector: 'xero' | null; baseCurrency: string; inventoryAccountCode: string | null; cogsAccountCode: string | null }> => {
  const [baseCurrency, settings, plugins] = await Promise.all([getBaseCurrencyCode(), getXeroSettings(), getIntegrationPluginState()])
  return {
    connector: plugins.xero ? 'xero' : null,
    baseCurrency,
    inventoryAccountCode: settings.xero_inventory_account.trim() || null,
    cogsAccountCode: settings.xero_cogs_account.trim() || null,
  }
})

function hasInventoryValuationGlScope(filters: InventoryCostingFilters): boolean {
  return !filters.warehouseId &&
    !filters.categoryId &&
    !filters.supplierId &&
    !filters.product?.trim() &&
    !filters.includeZero
}

function hasCogsGlScope(filters: InventoryCostingFilters): boolean {
  return !filters.warehouseId &&
    !filters.categoryId &&
    !filters.supplierId &&
    !filters.product?.trim()
}

async function inventoryGlBalanceForDate(asOf: string, totalValueBase: Decimal, filters: InventoryCostingFilters): Promise<{ glBalanceBase: Decimal | null; glVarianceBase: Decimal | null; notices: string[] }> {
  if (!hasInventoryValuationGlScope(filters)) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['GL variance is account-level and is shown only for unfiltered inventory valuation totals.'],
    }
  }
  const context = await loadConfiguredAccountingContext()
  if (!context.connector) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['Xero is not enabled, so GL inventory variance is blank.'],
    }
  }
  if (!context.inventoryAccountCode) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['No Xero inventory asset account is configured, so GL variance is blank.'],
    }
  }
  const snapshot = await findLatestAccountBalanceSnapshot({
    connector: context.connector,
    accountCode: context.inventoryAccountCode,
    balanceDate: asOf,
    currency: context.baseCurrency,
  })
  if (!snapshot) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: [`No stored GL balance snapshot exists for inventory asset account ${context.inventoryAccountCode} on or before ${asOf}, so GL variance is blank.`],
    }
  }
  return {
    glBalanceBase: snapshot.amountBase,
    glVarianceBase: calculateAccountBalanceVarianceBase(totalValueBase, snapshot.amountBase),
    notices: [],
  }
}

async function cogsGlMovementForPeriod(dateFrom: string, dateTo: string, cogsBase: Decimal, filters: InventoryCostingFilters): Promise<{ glBalanceBase: Decimal | null; glVarianceBase: Decimal | null; notices: string[] }> {
  if (!hasCogsGlScope(filters)) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['GL COGS variance is account-level and is shown only for unfiltered COGS totals.'],
    }
  }
  const context = await loadConfiguredAccountingContext()
  if (!context.connector) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['Xero is not enabled, so GL COGS variance is blank.'],
    }
  }
  if (!context.cogsAccountCode) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['No Xero COGS account is configured, so GL COGS variance is blank.'],
    }
  }
  const movement = await loadCogsGlMovementWithOnDemandSnapshotSync({
    connector: context.connector,
    accountCode: context.cogsAccountCode,
    dateFrom,
    dateTo,
    currency: context.baseCurrency,
  })
  if (!movement.ok) return missingCogsGlMovementResult(context.cogsAccountCode, dateFrom, dateTo, movement.notice)
  const notices = movement.movementBase.lt(0)
    ? ['GL COGS movement is negative. This can be caused by period-end reclassification, year-end close, or refunds; investigate before relying on the variance.']
    : []
  return {
    glBalanceBase: movement.movementBase,
    glVarianceBase: calculateAccountBalanceVarianceBase(cogsBase, movement.movementBase),
    notices,
  }
}

type CogsGlMovementLookup = Parameters<typeof getAccountBalancePeriodMovement>[0]

type CogsGlMovementResult =
  | { ok: true; movementBase: Decimal }
  | { ok: false; notice?: string }

async function loadCogsGlMovementWithOnDemandSnapshotSync(lookup: CogsGlMovementLookup): Promise<CogsGlMovementResult> {
  try {
    const movement = await getAccountBalancePeriodMovement(lookup)
    return { ok: true, movementBase: movement.movementBase }
  } catch (error) {
    if (!(error instanceof MissingAccountBalanceSnapshotError)) throw error
    if (lookup.connector !== 'xero') return { ok: false }

    const syncResult = await syncXeroAccountBalanceSnapshots({
      balanceDate: error.requiredBalanceDate,
      accountCodes: lookup.accountCode ? [lookup.accountCode] : undefined,
      syncRunId: `report-demand:${error.requiredBalanceDate}:${error.reason}`,
    })
    if (syncResult.errors.length > 0 || syncResult.persisted === 0) {
      return {
        ok: false,
        notice: `On-demand Xero Trial Balance sync for ${error.requiredBalanceDate} did not create the required GL balance snapshot.`,
      }
    }

    try {
      const movement = await getAccountBalancePeriodMovement(lookup)
      return { ok: true, movementBase: movement.movementBase }
    } catch (retryError) {
      if (retryError instanceof MissingAccountBalanceSnapshotError) return { ok: false }
      throw retryError
    }
  }
}

function missingCogsGlMovementResult(
  cogsAccountCode: string,
  dateFrom: string,
  dateTo: string,
  extraNotice?: string,
): { glBalanceBase: null; glVarianceBase: null; notices: string[] } {
  return {
    glBalanceBase: null,
    glVarianceBase: null,
    notices: [
      `No fresh opening and closing GL balance snapshots exist for COGS account ${cogsAccountCode} across ${dateFrom} to ${dateTo}. The opening snapshot must be from the day before the period start, so GL COGS variance is blank.`,
      ...(extraNotice ? [extraNotice] : []),
    ],
  }
}

function cogsGroupKey(input: CogsAggregationInput, groupBy: CogsGroupBy): string {
  switch (groupBy) {
    case 'category': return input.categoryName ?? 'Uncategorised'
    case 'warehouse': return input.warehouseId ?? 'unknown-warehouse'
    case 'customer': return input.customerName ?? 'Unknown customer'
    case 'channel': return input.channel ?? 'manual'
    case 'product':
    default: return input.productId
  }
}

function cogsGroupLabel(input: CogsAggregationInput, groupBy: CogsGroupBy): string {
  switch (groupBy) {
    case 'category': return input.categoryName ?? 'Uncategorised'
    case 'warehouse': return input.warehouseCode ? `${input.warehouseCode} — ${input.warehouseName ?? ''}`.trim() : 'Unknown warehouse'
    case 'customer': return input.customerName ?? 'Unknown customer'
    case 'channel': return input.channel ?? 'Manual'
    case 'product':
    default: return `${input.sku} — ${input.productName}`
  }
}

function isCogsGroupBy(value: InventoryCostingGroupBy | undefined): value is CogsGroupBy {
  return COGS_GROUPS.includes(value as CogsGroupBy)
}

function isInventoryTurnoverGroupBy(value: InventoryCostingGroupBy | undefined): value is InventoryTurnoverGroupBy {
  return INVENTORY_TURNOVER_GROUPS.includes(value as InventoryTurnoverGroupBy)
}

function dateOnly(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10)
  return value.toISOString().slice(0, 10)
}

function paginate<Row>(rows: Row[], filters: InventoryCostingFilters, options: ReportOptions = {}): { rows: Row[]; pageInfo: PageInfo } {
  if (options.paginate === false) {
    return {
      rows,
      pageInfo: {
        page: 1,
        pageSize: rows.length,
        totalRows: rows.length,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    }
  }
  const page = clampPage(filters.page)
  const pageSize = clampPageSize(filters.pageSize)
  const info = pageInfo(rows.length, page, pageSize)
  return {
    rows: rows.slice((info.page - 1) * info.pageSize, info.page * info.pageSize),
    pageInfo: info,
  }
}

export function inventoryCostingFiltersFromSearch(searchParams: InventoryCostingSearchParams): InventoryCostingFilters {
  const groupBy = oneSearchParam(searchParams.groupBy)
  const landedCostMethod = oneSearchParam(searchParams.landedCostMethod)
  const validGroupBy = COGS_GROUPS.includes(groupBy as CogsGroupBy) || INVENTORY_TURNOVER_GROUPS.includes(groupBy as InventoryTurnoverGroupBy)
    ? groupBy as InventoryCostingGroupBy
    : undefined
  return {
    asOf: dateSearchParam(searchParams.asOf),
    dateFrom: dateSearchParam(searchParams.dateFrom),
    dateTo: dateSearchParam(searchParams.dateTo),
    warehouseId: oneSearchParam(searchParams.warehouseId),
    categoryId: oneSearchParam(searchParams.categoryId),
    supplierId: oneSearchParam(searchParams.supplierId),
    product: oneSearchParam(searchParams.product),
    includeZero: oneSearchParam(searchParams.includeZero) === '1',
    groupBy: validGroupBy,
    landedCostMethod: LANDED_COST_METHODS.has(landedCostMethod as LandedCostMethod) ? landedCostMethod as LandedCostMethod : undefined,
    page: Number(oneSearchParam(searchParams.page) ?? 1),
    pageSize: Number(oneSearchParam(searchParams.pageSize) ?? 100),
  }
}

export function inventoryCostingFiltersForUi(filters: InventoryCostingFilters): InventoryCostingFilterUiValues {
  return {
    asOf: filters.asOf,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    product: filters.product,
    includeZero: filters.includeZero,
    groupBy: filters.groupBy,
    landedCostMethod: filters.landedCostMethod,
    pageSize: String(filters.pageSize ?? DEFAULT_PAGE_SIZE),
  }
}

export function aggregateCogsRows(inputs: CogsAggregationInput[], groupBy: CogsGroupBy): CogsReportRow[] {
  const groups = new Map<string, {
    first: CogsAggregationInput
    qty: Decimal
    cogsBase: Decimal
    revenueBase: Decimal
    revenueCaptured: boolean
    revenueKeys: Set<string>
    movementIds: Set<string>
  }>()

  for (const input of inputs) {
    const key = cogsGroupKey(input, groupBy)
    const existing = groups.get(key) ?? {
      first: input,
      qty: decimalZero(),
      cogsBase: decimalZero(),
      revenueBase: decimalZero(),
      revenueCaptured: true,
      revenueKeys: new Set<string>(),
      movementIds: new Set<string>(),
    }
    existing.qty = existing.qty.add(toDecimal(input.qty))
    existing.cogsBase = existing.cogsBase.add(toDecimal(input.cogsBase))
    if (input.revenueBase == null) {
      existing.revenueCaptured = false
    } else if (!input.revenueKey || !existing.revenueKeys.has(input.revenueKey)) {
      existing.revenueBase = existing.revenueBase.add(toDecimal(input.revenueBase))
      if (input.revenueKey) existing.revenueKeys.add(input.revenueKey)
    }
    existing.movementIds.add(input.id)
    groups.set(key, existing)
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const revenueBase = group.revenueCaptured ? group.revenueBase : null
      const grossMarginBase = revenueBase ? revenueBase.sub(group.cogsBase) : null
      const grossMarginPct = revenueBase && !revenueBase.isZero()
        ? grossMarginBase!.div(revenueBase).mul(100)
        : null
      return {
        groupKey: key,
        groupLabel: cogsGroupLabel(group.first, groupBy),
        sku: groupBy === 'product' ? group.first.sku : null,
        productId: groupBy === 'product' ? group.first.productId : null,
        productName: groupBy === 'product' ? group.first.productName : null,
        categoryName: groupBy === 'category' ? group.first.categoryName : null,
        warehouseCode: groupBy === 'warehouse' ? group.first.warehouseCode : null,
        customerName: groupBy === 'customer' ? group.first.customerName : null,
        channel: groupBy === 'channel' ? group.first.channel : null,
        qty: decimalString(group.qty, 4),
        cogsBase: moneyString(group.cogsBase),
        revenueBase: revenueBase ? moneyString(revenueBase) : null,
        grossMarginBase: grossMarginBase ? moneyString(grossMarginBase) : null,
        grossMarginPct: grossMarginPct ? decimalString(grossMarginPct, 2) : null,
        movementCount: group.movementIds.size,
        revenueCaptured: group.revenueCaptured,
      }
    })
    .sort((a, b) => {
      const aCogs = toDecimal(a.cogsBase)
      const bCogs = toDecimal(b.cogsBase)
      if (aCogs.lt(bCogs)) return 1
      if (aCogs.gt(bCogs)) return -1
      return a.groupLabel.localeCompare(b.groupLabel)
    })
}

type TurnoverGroupMeta = {
  key: string
  label: string
  share: Decimal
  sku: string | null
  productId: string | null
  productName: string | null
  categoryName: string | null
  warehouseCode: string | null
  supplierName: string | null
}

function turnoverGroupMetas(
  input: InventoryTurnoverCogsAggregationInput | InventoryTurnoverSnapshotAggregationInput,
  groupBy: InventoryTurnoverGroupBy,
): TurnoverGroupMeta[] {
  switch (groupBy) {
    case 'category':
      return [{
        key: input.categoryName ?? 'uncategorised',
        label: input.categoryName ?? 'Uncategorised',
        share: new Prisma.Decimal(1),
        sku: null,
        productId: null,
        productName: null,
        categoryName: input.categoryName,
        warehouseCode: null,
        supplierName: null,
      }]
    case 'warehouse':
      return [{
        key: input.warehouseId ?? 'unknown-warehouse',
        label: input.warehouseCode ? `${input.warehouseCode} — ${input.warehouseName ?? ''}`.trim() : 'Unknown warehouse',
        share: new Prisma.Decimal(1),
        sku: null,
        productId: null,
        productName: null,
        categoryName: null,
        warehouseCode: input.warehouseCode,
        supplierName: null,
      }]
    case 'supplier': {
      if (input.suppliers.length === 0) return []
      const share = new Prisma.Decimal(1).div(input.suppliers.length)
      return input.suppliers.map((supplier) => ({
        key: supplier.id,
        label: supplier.name,
        share,
        sku: null,
        productId: null,
        productName: null,
        categoryName: null,
        warehouseCode: null,
        supplierName: supplier.name,
      }))
    }
    case 'product':
    default:
      return [{
        key: input.productId,
        label: `${input.sku} — ${input.productName}`,
        share: new Prisma.Decimal(1),
        sku: input.sku,
        productId: input.productId,
        productName: input.productName,
        categoryName: input.categoryName,
        warehouseCode: null,
        supplierName: null,
      }]
  }
}

export function aggregateInventoryTurnoverRows(
  cogsInputs: InventoryTurnoverCogsAggregationInput[],
  snapshotInputs: InventoryTurnoverSnapshotAggregationInput[],
  groupBy: InventoryTurnoverGroupBy,
  periodDays: number,
): InventoryTurnoverReportRow[] {
  const groups = new Map<string, {
    meta: TurnoverGroupMeta
    cogsBase: Decimal
    cogsEntryIds: Set<string>
    snapshotValueByDay: Map<string, Decimal>
  }>()

  const getGroup = (meta: TurnoverGroupMeta) => {
    const existing = groups.get(meta.key)
    if (existing) return existing
    const created = {
      meta,
      cogsBase: decimalZero(),
      cogsEntryIds: new Set<string>(),
      snapshotValueByDay: new Map<string, Decimal>(),
    }
    groups.set(meta.key, created)
    return created
  }

  for (const input of cogsInputs) {
    for (const meta of turnoverGroupMetas(input, groupBy)) {
      const group = getGroup(meta)
      group.cogsBase = group.cogsBase.add(toDecimal(input.cogsBase).mul(meta.share))
      group.cogsEntryIds.add(input.id)
    }
  }

  for (const input of snapshotInputs) {
    const day = dateOnly(input.snapshotDate)
    for (const meta of turnoverGroupMetas(input, groupBy)) {
      const group = getGroup(meta)
      group.snapshotValueByDay.set(day, (group.snapshotValueByDay.get(day) ?? decimalZero()).add(toDecimal(input.inventoryValueBase).mul(meta.share)))
    }
  }

  return [...groups.values()]
    .map((group) => {
      const snapshotValueTotal = [...group.snapshotValueByDay.values()].reduce((sum, value) => sum.add(value), decimalZero())
      const averageInventoryValueBase = group.snapshotValueByDay.size > 0 ? snapshotValueTotal.div(group.snapshotValueByDay.size) : decimalZero()
      const turnover = calculateInventoryTurnover({
        cogsBase: group.cogsBase,
        averageInventoryValueBase,
        periodDays,
      })
      return {
        groupKey: group.meta.key,
        groupLabel: group.meta.label,
        sku: group.meta.sku,
        productId: group.meta.productId,
        productName: group.meta.productName,
        categoryName: group.meta.categoryName,
        warehouseCode: group.meta.warehouseCode,
        supplierName: group.meta.supplierName,
        cogsBase: moneyString(group.cogsBase),
        averageInventoryValueBase: moneyString(averageInventoryValueBase),
        turnoverRatio: turnover.turnoverRatio,
        daysInventoryOutstanding: turnover.daysInventoryOutstanding,
        cogsEntryCount: group.cogsEntryIds.size,
        snapshotDayCount: group.snapshotValueByDay.size,
      }
    })
    .sort((a, b) => {
      const aRatio = a.turnoverRatio == null ? new Prisma.Decimal(-1) : toDecimal(a.turnoverRatio)
      const bRatio = b.turnoverRatio == null ? new Prisma.Decimal(-1) : toDecimal(b.turnoverRatio)
      if (aRatio.lt(bRatio)) return 1
      if (aRatio.gt(bRatio)) return -1
      return a.groupLabel.localeCompare(b.groupLabel)
    })
}

export function aggregateLandedCostMethods(inputs: LandedCostAggregationInput[]): LandedCostReport['methodSummary'] {
  const groups = new Map<LandedCostMethod, { count: number; goodsValueBase: Decimal; landedValueBase: Decimal }>()
  for (const input of inputs) {
    const existing = groups.get(input.method) ?? {
      count: 0,
      goodsValueBase: decimalZero(),
      landedValueBase: decimalZero(),
    }
    existing.count += 1
    existing.goodsValueBase = existing.goodsValueBase.add(toDecimal(input.goodsValueBase))
    existing.landedValueBase = existing.landedValueBase.add(toDecimal(input.landedValueBase))
    groups.set(input.method, existing)
  }
  return [...groups.entries()]
    .map(([method, group]) => ({
      method,
      poLineCount: group.count,
      goodsValueBase: moneyString(group.goodsValueBase),
      landedValueBase: moneyString(group.landedValueBase),
      upliftBase: moneyString(group.landedValueBase.sub(group.goodsValueBase)),
    }))
    .sort((a, b) => a.method.localeCompare(b.method))
}

async function loadProductMetas(productIds: string[]): Promise<Map<string, ProductMeta>> {
  const rows = productIds.length === 0
    ? []
    : await db.product.findMany({
        where: { id: { in: [...new Set(productIds)] } },
        select: {
          id: true,
          sku: true,
          name: true,
          stockUnit: true,
          category: { select: { name: true } },
          supplierProducts: { select: { supplier: { select: { id: true, name: true } } } },
        },
      })
  return new Map(rows.map((row) => [row.id, row]))
}

async function loadWarehouseMetas(warehouseIds: string[]): Promise<Map<string, WarehouseMeta>> {
  const rows = warehouseIds.length === 0
    ? []
    : await db.warehouse.findMany({
        where: { id: { in: [...new Set(warehouseIds)] } },
        select: { id: true, code: true, name: true },
      })
  return new Map(rows.map((row) => [row.id, row]))
}

export async function getInventoryValuationReport(filters: InventoryCostingFilters = {}, options: ReportOptions = {}): Promise<InventoryValuationReport> {
  const asOf = filters.asOf ?? today()
  const snapshot = await getOnHandAsOf({
    asOf,
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productSearch: filters.product?.trim() || undefined,
    excludeZero: !filters.includeZero,
  })
  const [productMetas, warehouseMetas] = await Promise.all([
    loadProductMetas(snapshot.rows.map((row) => row.productId)),
    loadWarehouseMetas(snapshot.rows.map((row) => row.warehouseId)),
  ])
  const allRows = snapshot.rows
    .map((row: OnHandAsOfRow): InventoryValuationReportRow | null => {
      const product = productMetas.get(row.productId)
      const warehouse = warehouseMetas.get(row.warehouseId)
      if (!product || !warehouse) return null
      return {
        productId: row.productId,
        warehouseId: row.warehouseId,
        sku: product.sku,
        productName: product.name,
        categoryName: product.category?.name ?? null,
        supplierNames: supplierNames(product),
        warehouseCode: warehouse.code,
        warehouseName: warehouse.name,
        stockUnit: product.stockUnit,
        qty: row.qty,
        unitCostBase: row.unitCostBase,
        totalValueBase: row.valueBase,
        glBalanceBase: null,
        glVarianceBase: null,
      }
    })
    .filter((row): row is InventoryValuationReportRow => row !== null)
    .sort((a, b) => a.sku.localeCompare(b.sku) || a.warehouseCode.localeCompare(b.warehouseCode))

  const totals = allRows.reduce(
    (sum, row) => ({
      qty: sum.qty.add(toDecimal(row.qty)),
      totalValueBase: sum.totalValueBase.add(toDecimal(row.totalValueBase)),
    }),
    { qty: decimalZero(), totalValueBase: decimalZero() },
  )
  const gl = await inventoryGlBalanceForDate(snapshot.asOf, totals.totalValueBase, filters)
  const paged = paginate(allRows, filters, options)
  return {
    asOf: snapshot.asOf,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    anchorDate: snapshot.anchorDate,
    valueReplayReliable: snapshot.valueReplayReliable,
    missingValueMovementCount: snapshot.missingValueMovementCount,
    orphanWarehouseMovementCount: snapshot.orphanWarehouseMovementCount,
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      qty: decimalString(totals.qty, 4),
      totalValueBase: moneyString(totals.totalValueBase),
      glBalanceBase: gl.glBalanceBase ? moneyString(gl.glBalanceBase) : null,
      glVarianceBase: gl.glVarianceBase ? moneyString(gl.glVarianceBase) : null,
    },
    notices: [
      ...gl.notices,
      snapshot.valueReplayReliable ? '' : 'This as-of valuation includes movements without value evidence or orphan warehouse movement rows.',
    ].filter(Boolean),
  }
}

function revenueKey(input: RevenueKey): string {
  return `${input.orderId}:${input.productId}`
}

async function loadRevenueByOrderProduct(orderIds: string[]): Promise<{
  revenueByOrderProduct: Map<string, Decimal>
  orderMetaById: Map<string, { customerName: string | null; channel: string | null }>
}> {
  const rows: SalesOrderRevenueRow[] = orderIds.length === 0
    ? []
    : await db.salesOrder.findMany({
        where: { id: { in: [...new Set(orderIds)] } },
        select: {
          id: true,
          customerName: true,
          shoppingLinks: { select: { connector: true } },
          lines: { select: { productId: true, totalBase: true } },
        },
      })
  const revenueByOrderProduct = new Map<string, Decimal>()
  const orderMetaById = new Map<string, { customerName: string | null; channel: string | null }>()
  for (const order of rows) {
    const channel = [...new Set(order.shoppingLinks.map((link) => link.connector))]
      .sort((a, b) => a.localeCompare(b))
      .join(',')
    orderMetaById.set(order.id, {
      customerName: order.customerName,
      channel: channel || 'manual',
    })
    for (const line of order.lines) {
      if (!line.productId) continue
      const key = revenueKey({ orderId: order.id, productId: line.productId })
      revenueByOrderProduct.set(key, (revenueByOrderProduct.get(key) ?? decimalZero()).add(toDecimal(line.totalBase)))
    }
  }
  return { revenueByOrderProduct, orderMetaById }
}

export async function getCogsReport(filters: InventoryCostingFilters = {}, options: ReportOptions = {}): Promise<CogsReport> {
  const dateFrom = filters.dateFrom ?? daysAgo(30)
  const dateTo = filters.dateTo ?? today()
  const from = parseDateOnly(dateFrom, daysAgo(30))
  const to = parseDateOnly(dateTo, today(), true)
  const toExclusive = exclusiveEndOfUtcDay(to)
  const groupBy = isCogsGroupBy(filters.groupBy) ? filters.groupBy : 'product'
  const cogsWhere: Prisma.CogsEntryWhereInput = {
    createdAt: { gte: from, lt: toExclusive },
    movement: {
      // COGS currently comes from outbound inventory consumption. Those
      // movements leave stock through fromWarehouseId; extend this if a future
      // COGS-producing movement records the warehouse on another side.
      ...(filters.warehouseId ? { fromWarehouseId: filters.warehouseId } : {}),
      product: productWhere(filters),
    },
  }
  const rows: CogsEntryRow[] = []
  let cursor: { id: string } | undefined
  while (true) {
    const chunk: CogsEntryRow[] = await db.cogsEntry.findMany({
      where: cogsWhere,
      select: {
        id: true,
        qty: true,
        totalCostBase: true,
        createdAt: true,
        movement: {
          select: {
            id: true,
            referenceType: true,
            referenceId: true,
            fromWarehouseId: true,
            toWarehouseId: true,
            product: {
              select: {
                id: true,
                sku: true,
                name: true,
                stockUnit: true,
                category: { select: { name: true } },
                supplierProducts: { select: { supplier: { select: { id: true, name: true } } } },
              },
            },
            fromWarehouse: { select: { id: true, code: true, name: true } },
            toWarehouse: { select: { id: true, code: true, name: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_SCAN_PAGE_SIZE,
      ...(cursor ? { cursor, skip: 1 } : {}),
    })
    rows.push(...chunk)
    if (chunk.length < SOURCE_SCAN_PAGE_SIZE) break
    cursor = { id: chunk[chunk.length - 1]!.id }
  }
  const sourceOrderIds = rows
    .map((row) => row.movement.referenceType === 'SalesOrder' ? row.movement.referenceId : null)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const { revenueByOrderProduct, orderMetaById } = await loadRevenueByOrderProduct(sourceOrderIds)
  const inputs: CogsAggregationInput[] = rows.map((row) => {
    const product = row.movement.product
    const warehouse = row.movement.fromWarehouse ?? row.movement.toWarehouse
    const orderId = row.movement.referenceType === 'SalesOrder' ? row.movement.referenceId : null
    const meta = orderId ? orderMetaById.get(orderId) : undefined
    const key = orderId ? revenueKey({ orderId, productId: product.id }) : null
    const revenueBase = key ? revenueByOrderProduct.get(key) ?? null : null
    return {
      id: row.movement.id,
      qty: row.qty,
      cogsBase: row.totalCostBase,
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      categoryName: product.category?.name ?? null,
      warehouseId: warehouse?.id ?? null,
      warehouseCode: warehouse?.code ?? null,
      warehouseName: warehouse?.name ?? null,
      customerName: meta?.customerName ?? null,
      channel: meta?.channel ?? null,
      revenueKey: key,
      revenueBase,
    }
  })
  const allRows = aggregateCogsRows(inputs, groupBy)
  const totals = allRows.reduce(
    (sum, row) => ({
      qty: sum.qty.add(toDecimal(row.qty)),
      cogsBase: sum.cogsBase.add(toDecimal(row.cogsBase)),
      revenueBase: sum.revenueBase.add(row.revenueBase == null ? 0 : row.revenueBase),
      grossMarginBase: sum.grossMarginBase.add(row.grossMarginBase == null ? 0 : row.grossMarginBase),
      revenueCapturedRows: sum.revenueCapturedRows + (row.revenueCaptured ? 1 : 0),
    }),
    { qty: decimalZero(), cogsBase: decimalZero(), revenueBase: decimalZero(), grossMarginBase: decimalZero(), revenueCapturedRows: 0 },
  )
  const gl = await cogsGlMovementForPeriod(dateFrom, dateTo, totals.cogsBase, filters)
  const paged = paginate(allRows, filters, options)
  return {
    dateFrom,
    dateTo,
    generatedAt: new Date().toISOString(),
    groupBy,
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      qty: decimalString(totals.qty, 4),
      cogsBase: moneyString(totals.cogsBase),
      revenueBase: moneyString(totals.revenueBase),
      grossMarginBase: moneyString(totals.grossMarginBase),
      revenueCapturedRows: totals.revenueCapturedRows,
      glBalanceBase: gl.glBalanceBase ? moneyString(gl.glBalanceBase) : null,
      glVarianceBase: gl.glVarianceBase ? moneyString(gl.glVarianceBase) : null,
    },
    notices: [
      ...gl.notices,
      allRows.some((row) => !row.revenueCaptured)
        ? 'Revenue and margin are shown only where COGS movement references can be matched to a sales order line for the same product.'
        : '',
    ].filter(Boolean),
  }
}

export function assertInventoryTurnoverSourceLimit(rowCount: number, limit: number, source: 'COGS' | 'snapshot'): void {
  if (rowCount <= limit) return
  throw new InventoryTurnoverSourceLimitError(source, rowCount, limit)
}

export function emptyInventoryTurnoverReportForSourceLimit(filters: InventoryCostingFilters, error: InventoryTurnoverSourceLimitError): InventoryTurnoverReport {
  const dateFrom = filters.dateFrom ?? daysAgo(90)
  const dateTo = filters.dateTo ?? today()
  const window = normalizeVelocityWindow({ dateFrom, dateTo })
  return {
    dateFrom,
    dateTo,
    generatedAt: new Date().toISOString(),
    groupBy: isInventoryTurnoverGroupBy(filters.groupBy) ? filters.groupBy : 'product',
    periodDays: window.days,
    rows: [],
    pageInfo: {
      page: 1,
      pageSize: filters.pageSize ?? DEFAULT_PAGE_SIZE,
      totalRows: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    },
    totals: {
      cogsBase: '0.000000',
      averageInventoryValueBase: '0.000000',
      turnoverRatio: null,
      daysInventoryOutstanding: null,
      cogsEntryCount: 0,
      snapshotDayCount: 0,
    },
    notices: [error.message],
  }
}

export async function getInventoryTurnoverReport(filters: InventoryCostingFilters = {}, options: ReportOptions = {}): Promise<InventoryTurnoverReport> {
  const client = options.client ?? db
  const dateFrom = filters.dateFrom ?? daysAgo(90)
  const dateTo = filters.dateTo ?? today()
  const window = normalizeVelocityWindow({ dateFrom, dateTo })
  const from = window.dateFrom
  const to = window.dateTo
  const toExclusive = exclusiveEndOfUtcDay(to)
  const snapshotFrom = window.dateFrom
  const snapshotTo = window.dateTo
  const groupBy = isInventoryTurnoverGroupBy(filters.groupBy) ? filters.groupBy : 'product'
  const periodDays = window.days
  const productFilter = productWhere(filters)

  const cogsRows: CogsEntryRow[] = await client.cogsEntry.findMany({
    where: {
      createdAt: { gte: from, lt: toExclusive },
      movement: {
        type: StockMovementType.SALE_DISPATCH,
        ...(filters.warehouseId ? { fromWarehouseId: filters.warehouseId } : {}),
        product: productFilter,
      },
    },
    select: {
      id: true,
      qty: true,
      totalCostBase: true,
      createdAt: true,
      movement: {
        select: {
          id: true,
          referenceType: true,
          referenceId: true,
          fromWarehouseId: true,
          toWarehouseId: true,
          product: {
            select: {
              id: true,
              sku: true,
              name: true,
              stockUnit: true,
              category: { select: { name: true } },
              supplierProducts: { select: { supplier: { select: { id: true, name: true } } } },
            },
          },
          fromWarehouse: { select: { id: true, code: true, name: true } },
          toWarehouse: { select: { id: true, code: true, name: true } },
        },
      },
    },
    // Newest-first keeps the limit probe deterministic; LIMIT + 1 always
    // rejects before any truncated newest-only sample can be reported.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: INVENTORY_TURNOVER_COGS_SOURCE_ROW_LIMIT + 1,
  })
  assertInventoryTurnoverSourceLimit(cogsRows.length, INVENTORY_TURNOVER_COGS_SOURCE_ROW_LIMIT, 'COGS')

  const snapshotRows: InventoryTurnoverSnapshotRow[] = await client.inventorySnapshot.findMany({
    where: {
      snapshotDate: { gte: snapshotFrom, lte: snapshotTo },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      product: productFilter,
    },
    select: {
      id: true,
      snapshotDate: true,
      productId: true,
      warehouseId: true,
      valueBase: true,
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          stockUnit: true,
          category: { select: { name: true } },
          supplierProducts: { select: { supplier: { select: { id: true, name: true } } } },
        },
      },
      warehouse: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ snapshotDate: 'desc' }, { id: 'desc' }],
    take: INVENTORY_TURNOVER_SNAPSHOT_SOURCE_ROW_LIMIT + 1,
  })
  assertInventoryTurnoverSourceLimit(snapshotRows.length, INVENTORY_TURNOVER_SNAPSHOT_SOURCE_ROW_LIMIT, 'snapshot')

  const cogsInputs: InventoryTurnoverCogsAggregationInput[] = cogsRows.map((row) => {
    const product = row.movement.product
    const warehouse = row.movement.fromWarehouse ?? row.movement.toWarehouse
    return {
      id: row.id,
      cogsBase: row.totalCostBase,
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      categoryName: product.category?.name ?? null,
      warehouseId: warehouse?.id ?? null,
      warehouseCode: warehouse?.code ?? null,
      warehouseName: warehouse?.name ?? null,
      suppliers: supplierMetas(product),
    }
  })
  const snapshotInputs: InventoryTurnoverSnapshotAggregationInput[] = snapshotRows.map((row) => ({
    id: row.id,
    snapshotDate: row.snapshotDate,
    inventoryValueBase: row.valueBase,
    productId: row.product.id,
    sku: row.product.sku,
    productName: row.product.name,
    categoryName: row.product.category?.name ?? null,
    warehouseId: row.warehouse.id,
    warehouseCode: row.warehouse.code,
    warehouseName: row.warehouse.name,
    suppliers: supplierMetas(row.product),
  }))
  const allRows = aggregateInventoryTurnoverRows(cogsInputs, snapshotInputs, groupBy, periodDays)
  const mappedSupplierCogsEntryCount = cogsInputs.filter((row) => groupBy !== 'supplier' || row.suppliers.length > 0).length
  const missingSupplierCogsEntryCount = groupBy === 'supplier'
    ? cogsInputs.filter((row) => row.suppliers.length === 0).length
    : 0
  const missingSupplierSnapshotRowCount = groupBy === 'supplier'
    ? snapshotInputs.filter((row) => row.suppliers.length === 0).length
    : 0
  const totals = allRows.reduce(
    (sum, row) => ({
      cogsBase: sum.cogsBase.add(toDecimal(row.cogsBase)),
      averageInventoryValueBase: sum.averageInventoryValueBase.add(toDecimal(row.averageInventoryValueBase)),
    }),
    { cogsBase: decimalZero(), averageInventoryValueBase: decimalZero() },
  )
  const turnover = calculateInventoryTurnover({
    cogsBase: totals.cogsBase,
    averageInventoryValueBase: totals.averageInventoryValueBase,
    periodDays,
  })
  const paged = paginate(allRows, filters, options)
  const multiSupplierRows = groupBy === 'supplier'
    ? cogsInputs.filter((row) => row.suppliers.length > 1).length + snapshotInputs.filter((row) => row.suppliers.length > 1).length
    : 0
  return {
    dateFrom,
    dateTo,
    generatedAt: new Date().toISOString(),
    groupBy,
    periodDays,
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      cogsBase: moneyString(totals.cogsBase),
      averageInventoryValueBase: moneyString(totals.averageInventoryValueBase),
      turnoverRatio: turnover.turnoverRatio,
      daysInventoryOutstanding: turnover.daysInventoryOutstanding,
      cogsEntryCount: mappedSupplierCogsEntryCount,
      snapshotDayCount: Math.max(0, ...allRows.map((row) => row.snapshotDayCount)),
    },
    notices: [
      cogsRows.length === 0
        ? 'No sales-dispatch COGS exists in this period, so turnover is based on zero sales COGS.'
        : '',
      snapshotRows.length === 0
        ? 'No inventory snapshots exist in this period, so turnover ratios and days-inventory-outstanding are blank.'
        : '',
      allRows.some((row) => row.turnoverRatio == null)
        ? 'Rows with zero observed average inventory value show blank turnover ratios to avoid division by zero.'
        : '',
      groupBy === 'supplier' && multiSupplierRows > 0
        ? 'Supplier grouping splits multi-supplier SKU COGS and snapshot value evenly across linked suppliers.'
        : '',
      missingSupplierCogsEntryCount > 0 || missingSupplierSnapshotRowCount > 0
        ? `${missingSupplierCogsEntryCount.toLocaleString()} COGS rows and ${missingSupplierSnapshotRowCount.toLocaleString()} snapshot rows are excluded from supplier grouping because the product has no supplier mapping.`
        : '',
    ].filter(Boolean),
  }
}

export async function getLandedCostReport(filters: InventoryCostingFilters = {}, options: ReportOptions = {}): Promise<LandedCostReport> {
  const dateFrom = filters.dateFrom ?? daysAgo(90)
  const dateTo = filters.dateTo ?? today()
  const from = parseDateOnly(dateFrom, daysAgo(90))
  const to = parseDateOnly(dateTo, today(), true)
  const toExclusive = exclusiveEndOfUtcDay(to)
  const landedCostWhere: Prisma.PurchaseOrderLineWhereInput = {
    po: {
      createdAt: { gte: from, lt: toExclusive },
      ...(filters.landedCostMethod ? { landedCostMethod: filters.landedCostMethod } : {}),
      ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
      ...(filters.warehouseId ? { destinationWarehouseId: filters.warehouseId } : {}),
    },
    product: productWhere(filters),
  }
  const rows: LandedCostLineRow[] = []
  let cursor: { id: string } | undefined
  while (true) {
    const chunk: LandedCostLineRow[] = await db.purchaseOrderLine.findMany({
      where: landedCostWhere,
      select: {
        id: true,
        qty: true,
        unitCostBase: true,
        landedUnitCostBase: true,
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            stockUnit: true,
            category: { select: { name: true } },
            supplierProducts: { select: { supplier: { select: { id: true, name: true } } } },
          },
        },
        po: {
          select: {
            id: true,
            reference: true,
            status: true,
            createdAt: true,
            landedCostMethod: true,
            supplier: { select: { name: true } },
          },
        },
      },
      orderBy: [{ po: { createdAt: 'desc' } }, { sortOrder: 'asc' }, { id: 'asc' }],
      take: SOURCE_SCAN_PAGE_SIZE,
      ...(cursor ? { cursor, skip: 1 } : {}),
    })
    rows.push(...chunk)
    if (chunk.length < SOURCE_SCAN_PAGE_SIZE) break
    cursor = { id: chunk[chunk.length - 1]!.id }
  }
  const poIds = [...new Set(rows.map((row) => row.po.id))]
  const revaluationRows = poIds.length === 0
    ? []
    : await db.landedCostRevaluationRun.findMany({
        where: { primaryPoId: { in: poIds } },
        select: { primaryPoId: true },
      })
  const revaluationCountByPo = new Map<string, number>()
  for (const run of revaluationRows) {
    if (!run.primaryPoId) continue
    revaluationCountByPo.set(run.primaryPoId, (revaluationCountByPo.get(run.primaryPoId) ?? 0) + 1)
  }
  let nearZeroGoodsUnitCostRows = 0
  const methodInputs: LandedCostAggregationInput[] = []
  const allRows: LandedCostReportRow[] = rows.map((row) => {
    const qty = toDecimal(row.qty)
    const goodsUnit = toDecimal(row.unitCostBase)
    const landedUnit = toDecimal(row.landedUnitCostBase)
    const goodsValue = qty.mul(goodsUnit)
    const landedValue = qty.mul(landedUnit)
    const upliftUnit = landedUnit.sub(goodsUnit)
    const upliftPct = goodsUnit.abs().lt(NEAR_ZERO_LANDED_GOODS_UNIT_COST_BASE)
      ? null
      : upliftUnit.div(goodsUnit).mul(100)
    if (goodsUnit.abs().lt(NEAR_ZERO_LANDED_GOODS_UNIT_COST_BASE)) nearZeroGoodsUnitCostRows += 1
    methodInputs.push({
      method: row.po.landedCostMethod,
      qty,
      goodsValueBase: goodsValue,
      landedValueBase: landedValue,
    })
    return {
      poId: row.po.id,
      poReference: row.po.reference,
      supplierName: row.po.supplier.name,
      status: row.po.status,
      createdAt: formatDateTime(row.po.createdAt),
      productId: row.product.id,
      sku: row.product.sku,
      productName: row.product.name,
      categoryName: row.product.category?.name ?? null,
      qty: decimalString(qty, 4),
      goodsUnitCostBase: moneyString(goodsUnit),
      landedUnitCostBase: moneyString(landedUnit),
      landedUpliftUnitBase: moneyString(upliftUnit),
      landedUpliftPct: upliftPct ? decimalString(upliftPct, 2) : null,
      goodsValueBase: moneyString(goodsValue),
      landedValueBase: moneyString(landedValue),
      landedCostMethod: row.po.landedCostMethod,
      revaluationCount: revaluationCountByPo.get(row.po.id) ?? 0,
    }
  })
  const totals = allRows.reduce(
    (sum, row) => ({
      qty: sum.qty.add(toDecimal(row.qty)),
      goodsValueBase: sum.goodsValueBase.add(toDecimal(row.goodsValueBase)),
      landedValueBase: sum.landedValueBase.add(toDecimal(row.landedValueBase)),
      revaluationRuns: sum.revaluationRuns + row.revaluationCount,
    }),
    { qty: decimalZero(), goodsValueBase: decimalZero(), landedValueBase: decimalZero(), revaluationRuns: 0 },
  )
  const methodSummary = aggregateLandedCostMethods(methodInputs)
  const paged = paginate(allRows, filters, options)
  return {
    dateFrom,
    dateTo,
    generatedAt: new Date().toISOString(),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      qty: decimalString(totals.qty, 4),
      goodsValueBase: moneyString(totals.goodsValueBase),
      landedValueBase: moneyString(totals.landedValueBase),
      upliftBase: moneyString(totals.landedValueBase.sub(totals.goodsValueBase)),
      revaluationRuns: totals.revaluationRuns,
    },
    methodSummary,
    notices: [
      nearZeroGoodsUnitCostRows > 0
        ? `${nearZeroGoodsUnitCostRows.toLocaleString()} landed-cost rows have near-zero goods unit cost, so uplift percentage is left blank.`
        : '',
    ].filter(Boolean),
  }
}

export const INVENTORY_COSTING_CSV_ROW_LIMIT = INVENTORY_COSTING_EXPORT_ROW_LIMIT
