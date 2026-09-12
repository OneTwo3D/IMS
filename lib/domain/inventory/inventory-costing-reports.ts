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
import { assertSourceLimit, SourceScanTooLargeError } from '@/lib/security/source-scan-error'
import { getAccountingSettings, getActiveAccountingConnectorInfo, syncAccountingAccountBalanceSnapshots } from '@/lib/accounting'
import { cache } from 'react'
import { BOUNDED_FIGURE_ROUNDING_NOTICE_COGS, REFUND_BASIS_NOTICE_COGS_MARGIN } from '@/lib/analytics/refund-figure-surfaces'
import type { BoundedFigureString, DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
import {
  boundedFigureString,
  marginFigureBoundDecimal,
  netLinearFigureBoundDecimal,
} from '@/lib/domain/sales/refund-basis-analytics'
import {
  addCredit,
  addUnplacedIntervals,
  comparableCredit,
  creditBasisComplete,
  emptyCredits,
  mergeCredits,
  offRowCreditSummary,
  refundLinesRaisedInPeriodWhere,
  scaleCredits,
  unabsorbedCreditInterval,
  unplacedCreditBound,
  unplacedCreditInterval,
  type CreditBuckets,
  type UnplacedCreditInterval,
} from '@/lib/domain/sales/refund-credit-buckets'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const INVENTORY_COSTING_EXPORT_ROW_LIMIT = 100000
const SOURCE_SCAN_PAGE_SIZE = 1000
const INVENTORY_TURNOVER_COGS_SOURCE_ROW_LIMIT = 100000
const INVENTORY_TURNOVER_SNAPSHOT_SOURCE_ROW_LIMIT = 100000
const COGS_REFUND_SOURCE_ROW_LIMIT = 100000
const COGS_REFUND_PRODUCT_SCOPE_LIMIT = 100000
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
  currentValueDriftCount: number
  postAsOfRevaluationCount: number
  staleSnapshotCount: number
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
  /**
   * Ex-VAT sales-line revenue behind this group's dispatches, LESS the NET-basis credit against the
   * same lines (o3d-rv4a). `null` where the dispatch could not be matched to a sales line at all —
   * the null-not-zero discipline this report already had, now also covering the credit that
   * therefore had nothing to be subtracted from.
   */
  revenueBase: BoundedFigureString | null
  /**
   * WHAT THE FIGURE BESIDE IT IS, not a decoration on it. `null` travels with a `null` amount: a
   * withheld figure bears no relation to anything, and `'exact'` there would read as a measurement.
   * See lib/domain/sales/derived-figure-bound.ts for what each verdict claims.
   */
  revenueBaseBound: DerivedFigureBound | null
  grossMarginBase: BoundedFigureString | null
  grossMarginBaseBound: DerivedFigureBound | null
  grossMarginPct: BoundedFigureString | null
  /**
   * Separate from the two linear bounds ON PURPOSE. Margin is a RATIO, so unsubtracted credit moves
   * the numerator and the denominator together and the direction is decided case by case — a row
   * whose revenue and margin are sound ceilings can carry a margin % that is not one.
   */
  grossMarginPctBound: DerivedFigureBound | null
  /** Credit against this group's lines, on the basis it was recorded on. Only `net` was subtracted. */
  refundsNetBasis: string
  refundsGrossBasis: string
  refundsUnknownBasis: string
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
    /**
     * THE THREE FIGURES ON THIS REPORT THAT CARRY A RELATION ARE TYPED SO THEY CANNOT BE ROUNDED THE
     * WRONG WAY (o3d-rv4a r2). `BoundedFigureString` is mintable only by `boundedFigureString`, which
     * demands the bound and rounds toward it; `moneyString` returns a plain `string` and no longer
     * typechecks here. Round 1 published these through ROUND_HALF_UP under a `≤`.
     */
    revenueBase: BoundedFigureString
    revenueBaseBound: DerivedFigureBound
    grossMarginBase: BoundedFigureString
    grossMarginBaseBound: DerivedFigureBound
    refundsNetBasis: string
    refundsGrossBasis: string
    refundsUnknownBasis: string
    /**
     * CREDIT THAT REACHED NO ROW, STATED ON ITS OWN BASIS AND NEVER AS ONE SUM. A net amount and a
     * gross amount added together are in no unit at all, and an operator reading that beside a NET
     * revenue column would take it for one. Three amounts per case:
     *   `Unattributed` — the credit line named no sales line and no product, so no revenue bucket
     *                    could own it (a shipping or monetary-only credit line).
     *   `OutsideReport` — it named one this report has no revenue row for: that dispatch is not in
     *                    the window, or its revenue could not be matched to a line.
     * Either makes the period figures bounded even where the credit is the figure's own unit — it is
     * real credit that nothing subtracted.
     */
    refundsUnattributedNetBasis: string
    refundsUnattributedGrossBasis: string
    refundsUnattributedUnknownBasis: string
    refundsOutsideReportNetBasis: string
    refundsOutsideReportGrossBasis: string
    refundsOutsideReportUnknownBasis: string
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
    shipmentLine?: { lineId: string; line: { id: string; productId: string | null; totalBase: DecimalInput } } | null
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

/**
 * `moneyString` FOR A FIGURE THAT CARRIES A RELATION — same six decimals, rounded toward the bound
 * rather than to nearest (o3d-rv4a r2, Codex round 2 HIGH 3).
 *
 * The file this feeds publishes six decimals, so the defect bites at the seventh: a true revenue of
 * 100.0000003167 under a `≤` printed as `100.000000` is a ceiling below the truth, in a CSV column,
 * where the reader has no tooltip and no page to compare it against. A CSV column that rounds a bound
 * the wrong way is the same defect as the page's, in a different skin.
 */
function boundedMoneyString(value: DecimalInput, bound: DerivedFigureBound): BoundedFigureString {
  return boundedFigureString(value, bound, 6)
}

/**
 * The margin RATIO, at the two decimals this report has always published it to, rounded toward its
 * OWN bound — which is not always the bound on the amounts beside it (`marginFigureBoundDecimal`).
 *
 * `trailingZeros: false` keeps `decimalString`'s trimmed shape, so an exact 60% still reads `60` and
 * not `60.00`. The trimming is cosmetic; the direction above it is not.
 */
function boundedPctString(value: DecimalInput, bound: DerivedFigureBound): BoundedFigureString {
  return boundedFigureString(value, bound, 2, false)
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

const loadConfiguredAccountingContext = cache(async (): Promise<{ connector: 'xero' | 'quickbooks' | null; baseCurrency: string; inventoryAccountCode: string | null; cogsAccountCode: string | null }> => {
  const [baseCurrency, settings, connectorInfo] = await Promise.all([getBaseCurrencyCode(), getAccountingSettings(), getActiveAccountingConnectorInfo()])
  return {
    connector: connectorInfo?.id ?? null,
    baseCurrency,
    inventoryAccountCode: settings.inventoryAccount.trim() || null,
    cogsAccountCode: settings.cogsAccount.trim() || null,
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
      notices: ['No accounting connector is enabled, so GL inventory variance is blank.'],
    }
  }
  if (!context.inventoryAccountCode) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['No inventory asset account is configured on the active accounting connector, so GL variance is blank.'],
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
      notices: ['No accounting connector is enabled, so GL COGS variance is blank.'],
    }
  }
  if (!context.cogsAccountCode) {
    return {
      glBalanceBase: null,
      glVarianceBase: null,
      notices: ['No COGS account is configured on the active accounting connector, so GL COGS variance is blank.'],
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

    // Connector-agnostic on-demand snapshot sync: dispatches to the active accounting
    // connector. Returns ok:false (with a notice) when the active connector can't
    // produce the snapshot — including QuickBooks, whose ingestion isn't implemented yet.
    const syncResult = await syncAccountingAccountBalanceSnapshots({
      balanceDate: error.requiredBalanceDate,
      accountCodes: lookup.accountCode ? [lookup.accountCode] : undefined,
      syncRunId: `report-demand:${error.requiredBalanceDate}:${error.reason}`,
    })
    if (syncResult.errors.length > 0 || syncResult.persisted === 0) {
      return {
        ok: false,
        notice: `On-demand GL Trial Balance sync for ${error.requiredBalanceDate} did not create the required GL balance snapshot.`,
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

/**
 * o3d-rv4a: THE CREDIT THIS REPORT HAS TO ACCOUNT FOR, ATTRIBUTED THROUGH ITS OWN REVENUE KEYS.
 *
 * `byRevenueKey` is keyed exactly as `resolveCogsRevenueKeys` keys revenue — `L:<salesLineId>` where
 * the report attributes at line granularity, `<orderId>:<productId>` where it falls back to the
 * blended pair — so the credit lands in the same bucket as the revenue it reverses and is split
 * across groups by the same quantity share. The other two hold what could not be keyed at all.
 */
export type CogsCreditInput = {
  byRevenueKey: Map<string, CreditBuckets>
  /** Named a sales line or product this report holds no revenue key for. */
  outsideReport: CreditBuckets
  /** Named nothing keyable: no sales line, no product, or no order behind it. */
  unattributed: CreditBuckets
}

/**
 * WHAT THE PERIOD FIGURES COULD NOT ABSORB, CARRIED UNROUNDED SO THE TOTALS CLASSIFY FROM THE FACT.
 *
 * o3d-la3n's finding, applied here: a bound is an INTERVAL, the endpoints ADD when figures are
 * summed, and the verdict is derived LAST, at the point of display. Reconstructing it from the rows'
 * published `refunds*Basis` strings would be the defect that issue is named for twice over — those
 * are SIGNED sums (a +120 and a -120 of gross credit cancel into a zero that is not negative) and
 * they are ROUNDED (summing rounded rows can publish a ceiling below the truth, o3d-l4zz).
 */
export type CogsCreditSummary = {
  /** Every row's credit, attributed. */
  attributed: CreditBuckets
  unattributed: CreditBuckets
  outsideReport: CreditBuckets
  /** The interval, in NET terms, of credit missing from the period revenue/margin. */
  unaccountedInterval: UnplacedCreditInterval
  /** False when ANY credit was left out of the period figures, for any reason. */
  basisComplete: boolean
}

/** THIS REPORT'S REVENUE IS EX-VAT `SalesOrderLine.totalBase`, so a NET-basis credit is its unit. */
const COGS_FIGURE_BASIS = 'NET' as const

function emptyCogsCreditInput(): CogsCreditInput {
  return { byRevenueKey: new Map(), outsideReport: emptyCredits(), unattributed: emptyCredits() }
}

/**
 * Back-compatible wrapper: the rows alone, for callers that publish no bound.
 *
 * `aggregateCogsReport` is what `getCogsReport` uses, because the totals need the unrounded credit
 * interval and a row list cannot carry it.
 */
export function aggregateCogsRows(inputs: CogsAggregationInput[], groupBy: CogsGroupBy, credits?: CogsCreditInput): CogsReportRow[] {
  return aggregateCogsReport(inputs, groupBy, credits).rows
}

/**
 * THE PERIOD TOTALS, UNROUNDED — the only shape in which they can be summed soundly (o3d-rv4a r2,
 * Codex round 2 HIGH 2).
 *
 * o3d-la3n (#678) settled this rule and round 1 of this branch broke it: endpoints ADD when figures
 * are summed, and the verdict is derived LAST, from the unrounded interval. Round 1 derived the
 * verdict from the unrounded interval and then rebuilt the AMOUNTS by parsing the rows' own
 * six-decimal strings back into Decimals — so the `≤` was about one number and the figure beside it
 * was another. Codex's counterexample: a £1 line split across 300 groups rounds to 0.003333 per row,
 * whose 300 strings sum to 0.999900, while the true completed-basis total with £0.0001 of gross-basis
 * credit is 0.999916667. The published ceiling sat BELOW the truth — which is not a loose bound, it is
 * a false statement wearing a `≤`.
 *
 * So the aggregate travels as Decimal and is rounded exactly once, by the caller, toward its bound.
 * A consequence worth stating because it looks like a defect and is not: the rows no longer add up to
 * the total on screen. Each row is rounded toward its own ceiling and the total is rounded toward the
 * total's, so a column of ceilings can exceed the ceiling of the sum. Both figures are sound bounds;
 * the alternative — making them tally — is precisely the arithmetic that produced a false one.
 */
export type CogsUnroundedTotals = {
  qty: Decimal
  cogsBase: Decimal
  revenueBase: Decimal
  grossMarginBase: Decimal
  revenueCapturedRows: number
}

export function aggregateCogsReport(
  inputs: CogsAggregationInput[],
  groupBy: CogsGroupBy,
  credits: CogsCreditInput = emptyCogsCreditInput(),
): { rows: CogsReportRow[]; credits: CogsCreditSummary; totals: CogsUnroundedTotals } {
  // A sales-order line (revenueKey = orderId:productId) can be fulfilled from
  // more than one group (e.g. split-warehouse dispatch produces two COGS
  // movements with the same revenueKey in different warehouse groups). Counting
  // the full line revenue in each group double-counts the report total
  // (cogs-audit scjz.50). Build per-line totals first, then allocate each line's
  // revenue across its groups in proportion to the qty fulfilled by that group.
  const lineRevenueByKey = new Map<string, { revenue: Decimal; totalQty: Decimal }>()
  for (const input of inputs) {
    if (!input.revenueKey || input.revenueBase == null) continue
    const existing = lineRevenueByKey.get(input.revenueKey)
    if (existing) {
      existing.totalQty = existing.totalQty.add(toDecimal(input.qty))
    } else {
      lineRevenueByKey.set(input.revenueKey, { revenue: toDecimal(input.revenueBase), totalQty: toDecimal(input.qty) })
    }
  }

  const groups = new Map<string, {
    first: CogsAggregationInput
    qty: Decimal
    cogsBase: Decimal
    revenueCaptured: boolean
    unkeyedRevenue: Decimal
    qtyByRevenueKey: Map<string, Decimal>
    movementIds: Set<string>
  }>()

  for (const input of inputs) {
    const key = cogsGroupKey(input, groupBy)
    const existing = groups.get(key) ?? {
      first: input,
      qty: decimalZero(),
      cogsBase: decimalZero(),
      revenueCaptured: true,
      unkeyedRevenue: decimalZero(),
      qtyByRevenueKey: new Map<string, Decimal>(),
      movementIds: new Set<string>(),
    }
    existing.qty = existing.qty.add(toDecimal(input.qty))
    existing.cogsBase = existing.cogsBase.add(toDecimal(input.cogsBase))
    if (input.revenueBase == null) {
      existing.revenueCaptured = false
    } else if (input.revenueKey) {
      existing.qtyByRevenueKey.set(input.revenueKey, (existing.qtyByRevenueKey.get(input.revenueKey) ?? decimalZero()).add(toDecimal(input.qty)))
    } else {
      // Unkeyed revenue cannot be cross-group-deduped or qty-allocated; preserve
      // the prior per-row behaviour of summing it directly into the group.
      existing.unkeyedRevenue = existing.unkeyedRevenue.add(toDecimal(input.revenueBase))
    }
    existing.movementIds.add(input.id)
    groups.set(key, existing)
  }

  // o3d-rv4a: the credit that reached a row, and the interval of credit nothing subtracted.
  const attributed = emptyCredits()
  const unaccounted: UnplacedCreditInterval[] = []
  // The period totals, accumulated from the UNROUNDED group figures as each row is built — never
  // reconstructed afterwards from the rows' published strings (Codex round 2 HIGH 2, above).
  const totals: CogsUnroundedTotals = {
    qty: decimalZero(),
    cogsBase: decimalZero(),
    revenueBase: decimalZero(),
    grossMarginBase: decimalZero(),
    revenueCapturedRows: 0,
  }
  const rows = [...groups.entries()]
    .map(([key, group]) => {
      // Sum this group's qty-proportional share of each line's revenue. When a
      // line's total fulfilled qty is zero (degenerate, e.g. fully reversed),
      // fall back to the full line revenue rather than dropping it.
      //
      // THE CREDIT AGAINST THAT LINE IS SHARED OUT BY THE SAME FACTOR, including the degenerate
      // fallback. Two halves of one subtraction have to be on one denominator: allocating revenue by
      // quantity share while charging every group the whole credit would understate margin by the
      // credit once per extra group — the mirror of the double-count scjz.50 fixed for revenue.
      const groupCredits = emptyCredits()
      const groupRevenue = [...group.qtyByRevenueKey.entries()].reduce((sum, [revKey, groupQty]) => {
        const line = lineRevenueByKey.get(revKey)
        if (!line) return sum
        const degenerate = !line.totalQty.gt(0)
        const share = degenerate ? line.revenue : line.revenue.mul(groupQty).div(line.totalQty)
        const credit = credits.byRevenueKey.get(revKey)
        if (credit) {
          mergeCredits(groupCredits, degenerate
            ? credit
            : scaleCredits(credit, groupQty, line.totalQty))
        }
        return sum.add(share)
      }, group.unkeyedRevenue)
      // Only the credit on this figure's OWN basis is the same unit as it, so only that is taken off.
      // Nothing is converted: on a mixed-rate order the rate behind a gross credit is not recoverable
      // from stored data (refund-basis-analytics.ts, o3d-w00's fail-closed conclusion).
      const revenueBase = group.revenueCaptured ? groupRevenue.sub(comparableCredit(groupCredits, COGS_FIGURE_BASIS)) : null
      const grossMarginBase = revenueBase ? revenueBase.sub(group.cogsBase) : null
      // The ratio guard is `revenue > 0`, matching the Gross Margin report's `pctString` exactly
      // (o3d-kyey), so `marginFigureBoundDecimal`'s published case analysis is true OF THIS REPORT
      // and not merely of a report shaped like it. Its case 2 reasons that a non-positive revenue
      // pins published and true margin both to zero, which is a claim about that guard. Before
      // o3d-rv4a this report divided by a NEGATIVE revenue and published the sign-flipped quotient
      // (revenue -20 against 40 of cost printed +300%), which no case of that analysis covers — and
      // a negative revenue was unreachable then and is routine now that credit is subtracted.
      const grossMarginPct = revenueBase == null
        ? null
        : revenueBase.gt(0) ? grossMarginBase!.div(revenueBase).mul(100) : decimalZero()
      mergeCredits(attributed, groupCredits)
      const basisComplete = creditBasisComplete(groupCredits, COGS_FIGURE_BASIS)
      if (group.revenueCaptured) {
        unaccounted.push(unplacedCreditInterval(groupCredits, COGS_FIGURE_BASIS))
      } else {
        // There is no figure on this row to subtract from, so even the same-basis credit is missing
        // from the period totals. `Unmatched` is the honest cell; a bounded zero would not be.
        unaccounted.push(unabsorbedCreditInterval(groupCredits, COGS_FIGURE_BASIS))
      }
      const unplaced = unplacedCreditBound(unplacedCreditInterval(groupCredits, COGS_FIGURE_BASIS))
      const linearBound = netLinearFigureBoundDecimal({ basisComplete, unplacedCredit: unplaced })
      const pctBound = grossMarginPct == null
        ? null
        : marginFigureBoundDecimal({ netRevenue: revenueBase!, cogs: group.cogsBase, unplacedCredit: unplaced, basisComplete })
      totals.qty = totals.qty.add(group.qty)
      totals.cogsBase = totals.cogsBase.add(group.cogsBase)
      // A withheld figure contributes NOTHING, which is what its null has always meant to the totals —
      // and the credit that reached it is carried in `unaccounted` above, so it bounds them instead.
      if (revenueBase) totals.revenueBase = totals.revenueBase.add(revenueBase)
      if (grossMarginBase) totals.grossMarginBase = totals.grossMarginBase.add(grossMarginBase)
      if (group.revenueCaptured) totals.revenueCapturedRows += 1
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
        // Each figure is rendered toward ITS OWN bound, and the ratio's bound is not the amounts'.
        revenueBase: revenueBase ? boundedMoneyString(revenueBase, linearBound) : null,
        revenueBaseBound: revenueBase ? linearBound : null,
        grossMarginBase: grossMarginBase ? boundedMoneyString(grossMarginBase, linearBound) : null,
        grossMarginBaseBound: grossMarginBase ? linearBound : null,
        grossMarginPct: grossMarginPct ? boundedPctString(grossMarginPct, pctBound!) : null,
        grossMarginPctBound: pctBound,
        refundsNetBasis: moneyString(groupCredits.net),
        refundsGrossBasis: moneyString(groupCredits.gross),
        refundsUnknownBasis: moneyString(groupCredits.unknown),
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
  // Credit that reached no row at all bounds the period figures WHATEVER BASIS IT IS ON. A NET credit
  // is `placeable` — it is the figure's own unit — so a completeness flag read off the basis alone
  // would publish the period revenue as exact with a credit note missing from it. Existence is
  // decided from the INTERVAL, never a sum: +100 NET against -100 GROSS cancels across bases, and
  // +120 GROSS against -120 GROSS cancels within one while their ex-VAT values need not.
  const offRow = offRowCreditSummary(credits.unattributed, credits.outsideReport)
  const unaccountedInterval = [...unaccounted, offRow.interval]
    .reduce(addUnplacedIntervals, { lower: decimalZero(), upper: decimalZero() })
  return {
    rows,
    totals,
    credits: {
      attributed,
      unattributed: credits.unattributed,
      outsideReport: credits.outsideReport,
      unaccountedInterval,
      // Both halves, as o3d-kyey's totals do it: the per-entry placeability flag (which a signed sum
      // cannot reproduce — a +5 and a -5 of unplaceable credit sum to zero while neither was
      // placeable) AND an all-zero interval, which is the only statement that nothing at all was
      // left out. Either one false makes the period figures bounded.
      basisComplete: creditBasisComplete(attributed, COGS_FIGURE_BASIS)
        && unaccountedInterval.lower.isZero() && unaccountedInterval.upper.isZero(),
    },
  }
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

/**
 * Window-wide average inventory value for the turnover report total row.
 *
 * The per-group rows each divide their snapshot value total by that group's own
 * distinct-day count, so summing the per-group averages (different denominators)
 * yields a wrong portfolio daily average and turnover ratio (cogs-audit scjz.46).
 * Instead, build a single window-wide day→value map (summing every group's share
 * onto the same day) and divide by the distinct snapshot days across the window —
 * mirroring getAverageInventoryValueBase in inventory-snapshot.ts.
 */
export function aggregateInventoryTurnoverTotalAverage(
  snapshotInputs: InventoryTurnoverSnapshotAggregationInput[],
  groupBy: InventoryTurnoverGroupBy,
): { averageInventoryValueBase: Decimal; snapshotDayCount: number } {
  const valueByDay = new Map<string, Decimal>()
  for (const input of snapshotInputs) {
    const day = dateOnly(input.snapshotDate)
    for (const meta of turnoverGroupMetas(input, groupBy)) {
      valueByDay.set(day, (valueByDay.get(day) ?? decimalZero()).add(toDecimal(input.inventoryValueBase).mul(meta.share)))
    }
  }
  if (valueByDay.size === 0) {
    return { averageInventoryValueBase: decimalZero(), snapshotDayCount: 0 }
  }
  const total = [...valueByDay.values()].reduce((sum, value) => sum.add(value), decimalZero())
  return { averageInventoryValueBase: total.div(valueByDay.size), snapshotDayCount: valueByDay.size }
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
    currentValueDriftCount: snapshot.currentValueDriftCount,
    postAsOfRevaluationCount: snapshot.postAsOfRevaluationCount,
    staleSnapshotCount: snapshot.staleSnapshotCount,
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      qty: decimalString(totals.qty, 4),
      totalValueBase: moneyString(totals.totalValueBase),
      glBalanceBase: gl.glBalanceBase ? moneyString(gl.glBalanceBase) : null,
      glVarianceBase: gl.glVarianceBase ? moneyString(gl.glVarianceBase) : null,
    },
    // Reason-specific reliability notices so a revaluation/drift cause is not
    // misreported as missing value evidence (scjz.43/.44).
    notices: [
      ...gl.notices,
      (snapshot.missingValueMovementCount > 0 || snapshot.orphanWarehouseMovementCount > 0)
        ? 'This as-of valuation includes movements without value evidence or orphan warehouse movement rows.'
        : '',
      snapshot.postAsOfRevaluationCount > 0
        ? 'This as-of valuation draws on a cost basis affected by a later cost-layer revaluation that the as-of replay did not apply, so it is not point-in-time accurate.'
        : '',
      snapshot.staleSnapshotCount > 0
        ? 'This as-of valuation uses snapshot rows flagged not point-in-time accurate when written (backfilled from a later cost basis or with a missing-value movement baked in).'
        : '',
      snapshot.currentValueDriftCount > 0
        ? 'This valuation has cost-layer quantities that diverge from stock levels (orphan layers or stock/cost-layer desync).'
        : '',
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

export type CogsRevenueRowInput = {
  orderId: string | null
  /** movement.productId (the consumed product — component for kit dispatch) */
  productId: string
  shipmentLine: { lineId: string; lineProductId: string | null; lineTotalBase: DecimalInput } | null
}

/**
 * Resolve the revenue key + base for each COGS row, attributing revenue at
 * sales-LINE granularity where the shipment-line link makes it unambiguous, so
 * an order with two same-product lines at different prices/warehouses reports
 * each line's actual revenue instead of one qty-blended figure (scjz.67).
 *
 * Switch is all-or-nothing per (order, product): line-level keys are used only
 * when EVERY COGS row of that pair links to a sales line of the same product —
 * otherwise the blended order:product fallback is kept for the whole pair. This
 * avoids mixing the two keying schemes (which would double-count) and preserves
 * today's behaviour for kit-component dispatch (line product = kit ≠ component)
 * and legacy unlinked rows. Returned array is aligned to `rows`.
 */
export function resolveCogsRevenueKeys(
  rows: CogsRevenueRowInput[],
  revenueByOrderProduct: Map<string, Decimal>,
): Array<{ revenueKey: string | null; revenueBase: Decimal | null }> {
  const lineLevelByOrderProduct = new Map<string, boolean>()
  for (const row of rows) {
    if (!row.orderId) continue
    const opk = revenueKey({ orderId: row.orderId, productId: row.productId })
    const lineLinked = row.shipmentLine != null && row.shipmentLine.lineProductId === row.productId
    lineLevelByOrderProduct.set(opk, (lineLevelByOrderProduct.get(opk) ?? true) && lineLinked)
  }

  return rows.map((row) => {
    if (!row.orderId) return { revenueKey: null, revenueBase: null }
    const opk = revenueKey({ orderId: row.orderId, productId: row.productId })
    if (lineLevelByOrderProduct.get(opk) && row.shipmentLine) {
      return {
        revenueKey: `L:${row.shipmentLine.lineId}`,
        revenueBase: toDecimal(row.shipmentLine.lineTotalBase),
      }
    }
    return { revenueKey: opk, revenueBase: revenueByOrderProduct.get(opk) ?? null }
  })
}

/**
 * A REFUND LINE AS THIS REPORT HAS TO ATTRIBUTE IT (o3d-rv4a).
 *
 * `salesOrderLine` is preferred over the refund line's own `productId` for the same reason
 * `resolveCogsRevenueKeys` prefers the shipment line's: the sales line is what the revenue being
 * reversed is denominated in, and for a KIT the two products differ.
 */
export type CogsRefundLineInput = {
  totalBase: DecimalInput
  productId: string | null
  salesOrderLine: { id: string; orderId: string; productId: string | null } | null
  refund: { orderId: string; totalsBasis: string | null }
}

/**
 * THE PRODUCTS THIS VIEW IS ABOUT — `null` when no product filter is set, so everything is in scope
 * (o3d-rv4a r2, Codex round 2 HIGH 1).
 *
 * Round 1 tried to keep an operator's own filters out of the off-report credit buckets by narrowing
 * the refund QUERY to the orders behind the window's dispatches, and that conflated two questions.
 * The period is one question, answered identically for every basis-aware report by
 * `refundLinesRaisedInPeriodWhere`. WHICH PRODUCTS the view covers is the other, and the order test
 * could not answer it: a credit for a filtered-out sibling product sits on an INCLUDED order, so it
 * passed and landed in `outsideReport`, stamping a filtered view `≤` for a reason that has nothing to
 * do with the view. A marker that appears on every filtered view is a marker that stops being read.
 *
 * It is the set of product ids the filter ADMITS, resolved from `productWhere` — not the set of
 * products with a row in this window, which is a different and much smaller set. The difference is
 * load-bearing: a credit raised in this period against a product whose only dispatch was LAST period
 * has no row here and must still be loaded, because it is real credit against this view's subject
 * matter that this view's figures do not reflect. That is the other half of Codex's finding.
 */
export type CogsRefundProductScope = ReadonlySet<string> | null

/**
 * KEEP A CREDIT LINE UNLESS ITS PRODUCT IS PROVABLY ONE THE FILTER EXCLUDED — fail closed.
 *
 * The effective product is the SALES LINE's, falling back to the refund line's own, exactly as
 * `resolveCogsRefundCreditKeys` and `resolveCogsRevenueKeys` resolve it: for a kit the two differ, and
 * the sales line's is the one the reversed revenue was booked into.
 *
 * WHEN NO PRODUCT CAN BE RESOLVED THE LINE IS KEPT. A shipping or monetary-only credit line names no
 * product, so it cannot be shown to be about something the filter removed — and on an order holding
 * the filtered product it is partly about it. Only what is PROVABLY another product is dropped; what
 * cannot be proved out stays in and bounds the totals as `unattributed`. The same fail-closed rule the
 * basis buckets apply to a credit whose basis was never stamped, and the reason this is a named
 * function with its own test rather than a condition inside a loop.
 */
export function cogsRefundLineInProductScope(line: CogsRefundLineInput, scope: CogsRefundProductScope): boolean {
  if (scope == null) return true
  const productId = line.salesOrderLine?.productId ?? line.productId
  if (productId == null) return true
  return scope.has(productId)
}

/**
 * PUT EACH REFUND LINE IN THE BUCKET THE REVENUE IT REVERSES IS IN — or say it reached no bucket.
 *
 * `reportKeys` is the set of keys `resolveCogsRevenueKeys` actually produced for rows that carry
 * revenue, so this function never invents a key the report does not hold. It tries the line-level key
 * FIRST and the blended `<orderId>:<productId>` key second, because the two schemes are mutually
 * exclusive per (order, product): when the report is keying that pair by line, the pair key exists
 * nowhere in it, and attributing credit to a key no row holds would silently drop the credit while
 * the report claimed exactness.
 *
 * THE THREE OUTCOMES ARE DISTINCT AND ALL THREE ARE PUBLISHED. `attributed` reduces a row's revenue.
 * `outsideReport` named something real that this window has no revenue row for — a dispatch in
 * another period, or one whose revenue could not be matched — so it bounds the totals without
 * touching a row. `unattributed` named nothing keyable at all (a shipping or monetary-only credit
 * line), and bounds the totals for a different reason worth keeping separate: no product row could
 * EVER own it, so it will not appear on a widened date range either.
 */
export function resolveCogsRefundCreditKeys(
  lines: CogsRefundLineInput[],
  reportKeys: ReadonlySet<string>,
  productScope: CogsRefundProductScope,
): CogsCreditInput {
  const result = emptyCogsCreditInput()
  for (const line of lines) {
    // The report's own product filter, applied BEFORE attribution. A required parameter rather than an
    // optional one: round 1's whole failure was a scope decision nobody had to state.
    if (!cogsRefundLineInProductScope(line, productScope)) continue
    const lineKey = line.salesOrderLine ? `L:${line.salesOrderLine.id}` : null
    const productId = line.salesOrderLine?.productId ?? line.productId
    const orderId = line.salesOrderLine?.orderId ?? line.refund.orderId
    const pairKey = productId && orderId ? revenueKey({ orderId, productId }) : null
    const key = lineKey && reportKeys.has(lineKey)
      ? lineKey
      : pairKey && reportKeys.has(pairKey) ? pairKey : null
    if (key) {
      const buckets = result.byRevenueKey.get(key) ?? emptyCredits()
      addCredit(buckets, line.refund.totalsBasis, line.totalBase)
      result.byRevenueKey.set(key, buckets)
      continue
    }
    addCredit(lineKey || pairKey ? result.outsideReport : result.unattributed, line.refund.totalsBasis, line.totalBase)
  }
  return result
}

type CogsRefundLineRow = {
  totalBase: Prisma.Decimal
  productId: string | null
  salesOrderLine: { id: string; orderId: string; productId: string | null } | null
  refund: { orderId: string; totalsBasis: string | null }
}

/**
 * The period's credit, on the SAME window boundary the report's COGS entries use.
 *
 * ANCHORED TO `refundedAt`, NOT TO THE DISPATCH DATE, and the same PERIOD rule Gross Margin applies
 * (o3d-kyey) — literally the same expression, `refundLinesRaisedInPeriodWhere`, because round 1 of
 * o3d-rv4a claimed that agreement in a docstring and then broke it on the line below.
 *
 * EVERY REFUND RAISED IN THE PERIOD IS LOADED, and nothing else narrows this query. Round 1 added
 * `orderId: { in: sourceOrderIds }` — the orders behind this window's dispatches — reasoning that a
 * credit against any other order could never reach a row. It could not, and that is not the point: it
 * is still credit raised in this period that this period's published revenue does not reflect, so what
 * the report owes it is a BOUND, not silence. With that clause the report answered `exact` over a
 * period holding a credit note it had never loaded, while Gross Margin deducted the same credit from
 * the same product. The clause also failed at the job it was added for, since a credit for a
 * filtered-out sibling product rides on an INCLUDED order; the product filter is applied separately,
 * by `cogsRefundLineInProductScope`, where it can actually see the product.
 */
async function loadCogsRefundLines(from: Date, toExclusive: Date): Promise<CogsRefundLineRow[]> {
  const rows = await db.salesOrderRefundLine.findMany({
    where: refundLinesRaisedInPeriodWhere(from, toExclusive),
    select: {
      totalBase: true,
      productId: true,
      salesOrderLine: { select: { id: true, orderId: true, productId: true } },
      // The parent refund's basis marker governs what `totalBase` MEANS (o3d-w00/o3d-n8p). It is read
      // off the persisted column and never inferred from a note or a date.
      refund: { select: { orderId: true, totalsBasis: true } },
    },
    take: COGS_REFUND_SOURCE_ROW_LIMIT + 1,
  })
  // Refuse rather than silently truncate: a dropped credit line is a revenue figure that is too high
  // and a bound marker that says it is exact.
  assertSourceLimit(rows.length, COGS_REFUND_SOURCE_ROW_LIMIT, 'COGS report refund source rows')
  return rows
}

/**
 * WHICH PRODUCTS THE REPORT'S OWN FILTER ADMITS, for scoping the period's credit to the view.
 *
 * Resolved from `productWhere(filters)` — the SAME predicate the COGS-entry query applies to its
 * movements — so the credit and the cost are scoped by one expression and cannot disagree about what
 * the operator asked for. `null` when no product filter is set, which is the common case and costs no
 * query at all.
 *
 * IT IS NOT THE SET OF PRODUCTS WITH A ROW IN THIS WINDOW. A credit raised this period against a
 * product last dispatched in an earlier one has no row here and must still be loaded; scoping to the
 * rows would reinstate exactly the blindness Codex round 2 found. The `warehouseId` filter has no
 * counterpart here because a credit line records no warehouse: a warehouse-filtered view can
 * therefore carry off-report credit for a dispatch from another warehouse, which makes its bound
 * WIDER than necessary. That is the safe direction — a loose bound is still a bound — and it is stated
 * rather than silently narrowed, which is the mistake round 1 made.
 */
async function cogsRefundProductScope(filters: InventoryCostingFilters): Promise<CogsRefundProductScope> {
  const where = productWhere(filters)
  if (Object.keys(where).length === 0) return null
  const rows = await db.product.findMany({
    where,
    select: { id: true },
    take: COGS_REFUND_PRODUCT_SCOPE_LIMIT + 1,
  })
  // Refuse rather than truncate, for the reason the refund-line load does: a product silently missing
  // from this set drops its credit, which is a revenue figure that is too high under an `exact`.
  assertSourceLimit(rows.length, COGS_REFUND_PRODUCT_SCOPE_LIMIT, 'COGS report refund product scope rows')
  return new Set(rows.map((row) => row.id))
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
      // COGS/margin must be SALES cost only. cogs_entries are also written for
      // PRODUCTION_OUT (capitalised into the output layer, not expensed),
      // negative ADJUSTMENT write-offs, supplier returns (ADJUSTMENT) and
      // PURCHASE_REVERSAL — none of which are customer COGS and none of which
      // carry sales revenue. Restricting to SALE_DISPATCH (consistent with the
      // turnover and margin-analytics reports) avoids understating gross margin
      // by netting revenue-less consumption cost against sales.
      type: StockMovementType.SALE_DISPATCH,
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
            // Line-granularity revenue link (4pz6.1): when present, attribute each
            // sales line's actual revenue instead of the blended order:product
            // figure (scjz.67).
            shipmentLine: { select: { lineId: true, line: { select: { id: true, productId: true, totalBase: true } } } },
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
  const resolvedRevenue = resolveCogsRevenueKeys(
    rows.map((row) => ({
      orderId: row.movement.referenceType === 'SalesOrder' ? row.movement.referenceId : null,
      productId: row.movement.product.id,
      shipmentLine: row.movement.shipmentLine
        ? {
            lineId: row.movement.shipmentLine.lineId,
            lineProductId: row.movement.shipmentLine.line.productId,
            lineTotalBase: row.movement.shipmentLine.line.totalBase,
          }
        : null,
    })),
    revenueByOrderProduct,
  )
  const inputs: CogsAggregationInput[] = rows.map((row, index) => {
    const product = row.movement.product
    const warehouse = row.movement.fromWarehouse ?? row.movement.toWarehouse
    const orderId = row.movement.referenceType === 'SalesOrder' ? row.movement.referenceId : null
    const meta = orderId ? orderMetaById.get(orderId) : undefined
    const { revenueKey: key, revenueBase } = resolvedRevenue[index]!
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
  // o3d-rv4a: the period's credit, keyed through the SAME revenue keys the rows are built from, so a
  // credit lands in the bucket of the revenue it reverses. The PERIOD decides what is loaded and the
  // report's own product filter decides what is in scope — two questions, two mechanisms (Codex r2).
  const [refundLines, productScope] = await Promise.all([
    loadCogsRefundLines(from, toExclusive),
    cogsRefundProductScope(filters),
  ])
  // ONLY the keys that actually carry revenue. A key whose revenue could not be resolved holds no
  // figure for a credit to reduce, so credit naming it belongs in the off-report buckets, not on a
  // row that would then publish a bounded number it never computed.
  const reportRevenueKeys = new Set<string>(
    resolvedRevenue
      .filter((resolved) => resolved.revenueKey != null && resolved.revenueBase != null)
      .map((resolved) => resolved.revenueKey!),
  )
  const credits = resolveCogsRefundCreditKeys(refundLines, reportRevenueKeys, productScope)
  // THE TOTALS COME UP UNROUNDED (Codex round 2 HIGH 2). They used to be rebuilt here by parsing the
  // rows' own six-decimal strings back into Decimals, so the amount was a sum of 300 roundings while
  // the `≤` beside it was derived from the unrounded credit interval — and the advertised ceiling came
  // out below the truth. o3d-la3n's rule, applied: sum unrounded, derive the verdict last, round once.
  const { rows: allRows, credits: creditSummary, totals } = aggregateCogsReport(inputs, groupBy, credits)
  // The verdict is derived HERE, once, from the interval the rows carried up unrounded — not folded
  // from the rows' own verdicts and not rebuilt from their published (signed, rounded) credit
  // columns. That is o3d-la3n's whole finding: endpoints add, magnitudes matter, classify last.
  const totalsBound = netLinearFigureBoundDecimal({
    basisComplete: creditSummary.basisComplete,
    unplacedCredit: unplacedCreditBound(creditSummary.unaccountedInterval),
  })
  const reportCredits = emptyCredits()
  mergeCredits(reportCredits, creditSummary.attributed)
  mergeCredits(reportCredits, creditSummary.unattributed)
  mergeCredits(reportCredits, creditSummary.outsideReport)
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
      // Rounded ONCE, here, toward the relation the verdict beside it claims.
      revenueBase: boundedMoneyString(totals.revenueBase, totalsBound),
      revenueBaseBound: totalsBound,
      grossMarginBase: boundedMoneyString(totals.grossMarginBase, totalsBound),
      grossMarginBaseBound: totalsBound,
      refundsNetBasis: moneyString(reportCredits.net),
      refundsGrossBasis: moneyString(reportCredits.gross),
      refundsUnknownBasis: moneyString(reportCredits.unknown),
      refundsUnattributedNetBasis: moneyString(creditSummary.unattributed.net),
      refundsUnattributedGrossBasis: moneyString(creditSummary.unattributed.gross),
      refundsUnattributedUnknownBasis: moneyString(creditSummary.unattributed.unknown),
      refundsOutsideReportNetBasis: moneyString(creditSummary.outsideReport.net),
      refundsOutsideReportGrossBasis: moneyString(creditSummary.outsideReport.gross),
      refundsOutsideReportUnknownBasis: moneyString(creditSummary.outsideReport.unknown),
      revenueCapturedRows: totals.revenueCapturedRows,
      glBalanceBase: gl.glBalanceBase ? moneyString(gl.glBalanceBase) : null,
      glVarianceBase: gl.glVarianceBase ? moneyString(gl.glVarianceBase) : null,
    },
    notices: [
      ...gl.notices,
      allRows.some((row) => !row.revenueCaptured)
        ? 'Revenue and margin are shown only where COGS movement references can be matched to a sales order line for the same product. Credit against an unmatched row has no revenue to come off and is reported in the off-report totals instead.'
        : '',
      // o3d-rv4a: this report is no longer refund-blind. Revenue is the dispatch's ex-VAT sales-line
      // revenue LESS the net-basis credit raised in the period; the gross-basis and unproven-basis
      // credit is published beside it and bounds the figures rather than being converted or guessed.
      REFUND_BASIS_NOTICE_COGS_MARGIN,
      // o3d-rv4a r3, Codex round 3 MEDIUM: and the screen now explains the discrepancy it deliberately
      // creates. Rows are ceiled one by one and the total is ceiled once from the unrounded sum, so the
      // column does not tally with the footer — by up to a penny per row, which across 500 rows looks
      // like a defect. UNCONDITIONAL, because independent rounding does not distribute over addition
      // for the nearest mode either: a report whose every figure is `exact` can miss by the same penny.
      BOUNDED_FIGURE_ROUNDING_NOTICE_COGS,
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
  // Total average inventory value must use a window-wide daily total / distinct
  // snapshot days, not the sum of per-group averages (those divide by different
  // per-group day counts) (cogs-audit scjz.46).
  const totalAverage = aggregateInventoryTurnoverTotalAverage(snapshotInputs, groupBy)
  const totals = {
    cogsBase: allRows.reduce((sum, row) => sum.add(toDecimal(row.cogsBase)), decimalZero()),
    averageInventoryValueBase: totalAverage.averageInventoryValueBase,
  }
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
      snapshotDayCount: totalAverage.snapshotDayCount,
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
