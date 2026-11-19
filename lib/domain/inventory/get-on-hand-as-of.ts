import { Prisma, type PrismaClient, type ProductType, type StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { businessDateYmd } from '@/lib/business-date'
import { startOfNextBusinessDay } from '@/lib/domain/inventory/inventory-snapshot'
import {
  addMoney,
  roundQuantity,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

type AsOfInput = Date | string | number | null | undefined

export type OnHandAsOfFilters = {
  productId?: string
  warehouseId?: string
  categoryId?: string
  productType?: ProductType
  supplierId?: string
  productSearch?: string
  excludeZero?: boolean
}

export type OnHandAsOfRow = {
  productId: string
  warehouseId: string
  qty: string
  valueBase: string
  unitCostBase: string | null
}

export type OnHandAsOfSource =
  | 'current'
  | 'snapshot_forward_replay'
  | 'future_snapshot_reverse_replay'
  | 'current_reverse_replay'

export type OnHandAsOfResult = {
  asOf: string
  generatedAt: string
  anchorDate: string | null
  source: OnHandAsOfSource
  rows: OnHandAsOfRow[]
  missingValueMovementCount: number
  orphanWarehouseMovementCount: number
  missingValueMovementSample: OnHandAsOfMissingValueMovement[]
  valueReplayReliable: boolean
  // Live valuation (source: 'current') only: number of (product, warehouse) pairs
  // whose open cost-layer quantity diverges from the stock_levels quantity —
  // including orphan layers (value with no stock row). >0 means the layer-derived
  // value can't be trusted against the stock quantities (scjz.44). 0 on replay paths.
  currentValueDriftCount: number
  // Historical (as-of-in-the-past) valuation only: number of in-scope cost-layer
  // revaluations that took effect AFTER asOf (and were not applied by the replay).
  // >0 means the value reflects later landed-cost / manufacturing revaluations
  // rather than the basis valid at asOf (scjz.43). 0 on the live path.
  postAsOfRevaluationCount: number
  // Snapshot-backed valuation only: number of loaded snapshot rows persisted as
  // not point-in-time reliable at write (backfilled from a later basis or with a
  // missing-value movement baked in) (scjz.43/.48). Distinct reason from a live
  // post-asOf revaluation so reports can explain it correctly.
  staleSnapshotCount: number
}

export type OnHandAsOfClient = Pick<
  PrismaClient,
  'inventorySnapshot' | 'inventorySnapshotRun' | 'stockMovement' | 'stockLevel' | 'costLayer' | 'costLayerRevaluation'
> & {
  $queryRaw?: PrismaClient['$queryRaw']
  $transaction?: PrismaClient['$transaction']
}

export class InventoryAsOfFutureError extends Error {
  readonly code = 'inventory_as_of_future'

  constructor() {
    super('Inventory as-of date cannot be after the current UTC day')
    this.name = 'InventoryAsOfFutureError'
  }
}

type SnapshotRow = {
  productId: string
  warehouseId: string
  qty: DecimalInput
  valueBase: DecimalInput
}

type StockLevelRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
}

type CostLayerRow = {
  productId: string
  warehouseId: string
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
}

type AggregatedCurrentStateRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
  valueBase: DecimalInput
  layerQty: DecimalInput
}

// A (product, warehouse) pair counts as drifted when its open cost-layer quantity
// diverges from the stock_levels quantity beyond engine-scale rounding noise. This
// captures orphan layers (stock row missing → quantity 0, layerQty > 0), stock
// with too few layers, and plain qty mismatches (scjz.44).
const CURRENT_VALUE_DRIFT_TOLERANCE = toDecimal('0.0001')

function isCurrentValueDrifted(stockQty: DecimalInput, layerQty: DecimalInput): boolean {
  return toDecimal(stockQty).sub(toDecimal(layerQty)).abs().gt(CURRENT_VALUE_DRIFT_TOLERANCE)
}

type MovementRow = {
  id: string
  createdAt: Date
  type: StockMovementType
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  qty: DecimalInput
  totalValueBase: DecimalInput | null
}

type StateEntry = {
  productId: string
  warehouseId: string
  qty: Decimal
  valueBase: Decimal
}

type OnHandState = Map<string, StateEntry>

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const MOVEMENT_REPLAY_PAGE_SIZE = 10000
const MISSING_VALUE_SAMPLE_LIMIT = 25

type ProductScopedWhere = {
  productId?: string
  product?: Prisma.ProductWhereInput
}

type WarehouseMovementWhere = {
  OR?: Array<{ fromWarehouseId: string } | { toWarehouseId: string }>
}

type ApplyMovementResult =
  | { applied: false; valueReliable: true; orphanWarehouse: false; movement?: undefined }
  | { applied: false; valueReliable: false; orphanWarehouse: true; movement: MovementRow }
  | { applied: true; valueReliable: boolean; orphanWarehouse: false; movement: MovementRow }

export type OnHandAsOfMissingValueMovement = {
  id: string
  createdAt: string
  type: StockMovementType
  productId: string
}

type ReplayMovementsResult = {
  missingValueMovementCount: number
  orphanWarehouseMovementCount: number
  missingValueMovementSample: OnHandAsOfMissingValueMovement[]
}

function emptyReplayResult(): ReplayMovementsResult {
  return {
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
  }
}

function recordMissingValueMovement(result: ReplayMovementsResult, movement: MovementRow): void {
  result.missingValueMovementCount += 1
  if (result.missingValueMovementSample.length >= MISSING_VALUE_SAMPLE_LIMIT) return
  result.missingValueMovementSample.push({
    id: movement.id,
    createdAt: formatDateTime(movement.createdAt),
    type: movement.type,
    productId: movement.productId,
  })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new Error('Inventory as-of movement replay was aborted')
}

type ReplayDateRange = { gt?: Date; gte?: Date; lt?: Date; lte?: Date }

function validateReplayRange(range: ReplayDateRange): void {
  const lower = range.gt ?? range.gte
  const upper = range.lte ?? range.lt
  if (lower && upper && lower > upper) {
    throw new Error('Inventory as-of movement replay range is inverted')
  }
}

function isEmptyReplayRange(range: ReplayDateRange): boolean {
  const lower = range.gt ?? range.gte
  const upper = range.lte ?? range.lt
  if (!lower || !upper) return false
  if (lower.getTime() > upper.getTime()) return true
  if (lower.getTime() === upper.getTime()) {
    // Equal endpoints form a single instant; it is only non-empty when BOTH
    // bounds are inclusive (gte..lte). Any exclusive end (gt or lt) makes it
    // empty. Without this, a date-only as-of whose half-open next-day boundary
    // (gte) coincides with an inclusive upper bound — e.g. current reverse replay
    // at exactly next-day midnight, { gte: nextDay, lte: now } — would skip a
    // movement sitting exactly on that instant (scjz.49).
    const lowerInclusive = range.gte !== undefined && range.gt === undefined
    const upperInclusive = range.lte !== undefined && range.lt === undefined
    return !(lowerInclusive && upperInclusive)
  }
  return false
}

function buildResult(input: {
  asOf: Date
  generatedAt: Date
  anchorDate: Date | null
  source: OnHandAsOfSource
  state: OnHandState
  replay?: ReplayMovementsResult
  excludeZero?: boolean
  currentValueFromCostLayers?: boolean
  currentValueDriftCount?: number
  postAsOfRevaluationCount?: number
  staleSnapshotCount?: number
}): OnHandAsOfResult {
  const replay = input.replay ?? emptyReplayResult()
  const currentValueDriftCount = input.currentValueDriftCount ?? 0
  const postAsOfRevaluationCount = input.postAsOfRevaluationCount ?? 0
  const staleSnapshotCount = input.staleSnapshotCount ?? 0
  return {
    asOf: formatDateTime(input.asOf),
    generatedAt: formatDateTime(input.generatedAt),
    anchorDate: input.anchorDate ? formatDate(input.anchorDate) : null,
    source: input.source,
    rows: rowsFromState(input.state, { excludeZero: input.excludeZero }),
    missingValueMovementCount: replay.missingValueMovementCount,
    orphanWarehouseMovementCount: replay.orphanWarehouseMovementCount,
    missingValueMovementSample: replay.missingValueMovementSample,
    // Live valuation is "reliable" only when its layer-derived value reconciles to
    // the stock quantities (scjz.44). Historical valuation is reliable only when no
    // replayed movement lacked value, no orphan-warehouse movement was seen, AND no
    // in-scope layer was revalued after asOf — otherwise the value reflects later
    // revaluations, not the point-in-time basis (scjz.43).
    valueReplayReliable: input.currentValueFromCostLayers
      ? currentValueDriftCount === 0
      : replay.missingValueMovementCount === 0
        && replay.orphanWarehouseMovementCount === 0
        && postAsOfRevaluationCount === 0
        && staleSnapshotCount === 0,
    currentValueDriftCount,
    postAsOfRevaluationCount,
    staleSnapshotCount,
  }
}

function stateKey(productId: string, warehouseId: string): string {
  return JSON.stringify([productId, warehouseId])
}

/**
 * `isDateOnly` distinguishes a `YYYY-MM-DD` input (an end-of-day proxy whose
 * `...T23:59:59.999Z` value cannot represent the `.999000`–`.999999` microsecond
 * band PostgreSQL stores) from a precise Date/number instant. Date-only inputs
 * must therefore filter with a half-open next-day boundary rather than an
 * inclusive `lte`/`gt` on the `.999Z` proxy (scjz.49).
 */
function parseAsOf(input: AsOfInput): { asOf: Date; isDateOnly: boolean } {
  if (input == null) return { asOf: new Date(), isDateOnly: false }

  if (typeof input === 'string') {
    if (!DATE_ONLY_RE.test(input)) {
      throw new Error(`Inventory as-of dates must use YYYY-MM-DD, got: ${input}`)
    }
    const [year, month, day] = input.split('-').map(Number)
    const value = endOfUtcDay(new Date(Date.UTC(year!, month! - 1, day!)))
    if (
      value.getUTCFullYear() !== year ||
      value.getUTCMonth() !== month! - 1 ||
      value.getUTCDate() !== day
    ) {
      throw new Error(`Invalid inventory as-of date: ${input}`)
    }
    return { asOf: value, isDateOnly: true }
  }

  const value = new Date(input)
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid inventory as-of date: ${String(input)}`)
  }
  return { asOf: value, isDateOnly: false }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}

/** The BUSINESS (Europe/London) day an instant falls in, as a UTC-midnight label Date (the form `inventory_snapshots.snapshotDate` is keyed on). */
function businessDayLabel(instant: Date): Date {
  const [year, month, day] = businessDateYmd(instant).split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!))
}

/**
 * The instant a snapshot's content stops: movements at or after it are NOT in the snapshot. Snapshots are labelled by London business day, so in BST this
 * is 23:00Z of the label day, not 24:00Z. The run row's stored `cutoffAt` is authoritative (it is what the writer stamped); with none stored, fall back to the
 * end of the London day the label names (identical to the UTC day in GMT).
 *
 * ACCEPTED LIMITS for legacy summer-time (BST) rows, written before the label moved to the London day (the cron fired at London 00:00, which is 23:00Z, and
 * labelled the run D-1 by the UTC day):
 * - a legacy CRON run WITH a stored cutoff stamped `startOfNextUtcDay(label)`, i.e. D 00:00Z, while its content runs to D 23:00Z: the stored cutoff is 23h BEFORE
 *   the content end. This reader trusts the stored value, so forward replay from it re-applies about 23h of movements, and a same-day date-only as-of reverses
 *   only [D-1 23:00Z, D 00:00Z), leaving about 23h in;
 * - a legacy run with NO stored cutoff is read with a cutoff at D-1 23:00Z, so about 24h of movements is double-applied by forward replay.
 * Neither is a regression, and both fall under the accepted relabel limit documented on `previousBusinessDate` (inventory-snapshot.ts). Legacy BACKFILLED rows
 * stored a UTC midnight cutoff AFTER their London day end, which is the opposite direction and is handled by reverse replay (see the anchor range below).
 * Only stage carries such rows; production is to be reinstalled.
 */
async function loadSnapshotCutoff(client: OnHandAsOfClient, snapshotDate: Date): Promise<Date> {
  const run = await client.inventorySnapshotRun.findUnique({
    where: { snapshotDate },
    select: { cutoffAt: true },
  })
  return run?.cutoffAt ?? startOfNextBusinessDay(snapshotDate)
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function formatDateTime(date: Date): string {
  return date.toISOString()
}

function roundQty(value: DecimalInput): Decimal {
  // 6dp to match live stock_levels/cost_layers and the persisted snapshots
  // (cogs-audit scjz.1); 4dp here would make as-of reports disagree with live stock.
  return roundQuantity(value, 6)
}

function roundValue(value: DecimalInput): Decimal {
  return roundQuantity(value, 6)
}

function productRelationFilter(filters: OnHandAsOfFilters): Prisma.ProductWhereInput {
  return {
    ...(filters.productSearch
      ? {
          OR: [
            { sku: { contains: filters.productSearch, mode: 'insensitive' as const } },
            { name: { contains: filters.productSearch, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.productType ? { type: filters.productType } : {}),
    ...(filters.supplierId
      ? {
          supplierProducts: {
            some: { supplierId: filters.supplierId },
          },
        }
      : {}),
  }
}

function productWhere(filters: OnHandAsOfFilters): ProductScopedWhere {
  const product = productRelationFilter(filters)
  return {
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(Object.keys(product).length > 0 ? { product } : {}),
  }
}

function warehouseMovementWhere(filters: OnHandAsOfFilters): WarehouseMovementWhere {
  return filters.warehouseId
    ? { OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] }
    : {}
}

function snapshotWhere(snapshotDate: Date, filters: OnHandAsOfFilters): Prisma.InventorySnapshotWhereInput {
  const product = productRelationFilter(filters)
  return {
    snapshotDate,
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    ...(Object.keys(product).length > 0 ? { product } : {}),
  }
}

function currentStockWhere(filters: OnHandAsOfFilters): Prisma.StockLevelWhereInput {
  const product = productRelationFilter(filters)
  return {
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    ...(Object.keys(product).length > 0 ? { product } : {}),
  }
}

function currentCostLayerWhere(filters: OnHandAsOfFilters): Prisma.CostLayerWhereInput {
  const product = productRelationFilter(filters)
  return {
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    ...(Object.keys(product).length > 0 ? { product } : {}),
  }
}

/**
 * Count in-scope cost-layer revaluations that took effect after `asOf` (scjz.43).
 * A historical valuation that draws cost from layers/snapshots reflecting these
 * later revaluations is not point-in-time accurate, so the count downgrades
 * valueReplayReliable rather than silently reporting a post-revaluation basis.
 */
async function countPostAsOfRevaluations(
  client: OnHandAsOfClient,
  filters: OnHandAsOfFilters,
  effectiveAt: Prisma.DateTimeFilter,
): Promise<number> {
  return client.costLayerRevaluation.count({
    where: {
      effectiveAt,
      costLayer: currentCostLayerWhere(filters),
    },
  })
}

function emptyState(): OnHandState {
  return new Map()
}

function upsertState(
  state: OnHandState,
  productId: string,
  warehouseId: string,
  qtyDelta: DecimalInput,
  valueDelta: DecimalInput,
): void {
  const key = stateKey(productId, warehouseId)
  const existing = state.get(key) ?? {
    productId,
    warehouseId,
    qty: toDecimal(0),
    valueBase: toDecimal(0),
  }
  existing.qty = roundQty(existing.qty.add(toDecimal(qtyDelta)))
  existing.valueBase = roundValue(existing.valueBase.add(toDecimal(valueDelta)))
  state.set(key, existing)
}

function stateFromSnapshots(rows: readonly SnapshotRow[]): OnHandState {
  const state = emptyState()
  for (const row of rows) {
    state.set(stateKey(row.productId, row.warehouseId), {
      productId: row.productId,
      warehouseId: row.warehouseId,
      qty: roundQty(row.qty),
      valueBase: roundValue(row.valueBase),
    })
  }
  return state
}

function stateFromCurrentRows(
  stockLevels: readonly StockLevelRow[],
  costLayers: readonly CostLayerRow[],
): OnHandState {
  const state = emptyState()
  for (const stockLevel of stockLevels) {
    state.set(stateKey(stockLevel.productId, stockLevel.warehouseId), {
      productId: stockLevel.productId,
      warehouseId: stockLevel.warehouseId,
      qty: roundQty(stockLevel.quantity),
      valueBase: toDecimal(0),
    })
  }

  // scjz.65: sum each (product, warehouse)'s layer values at FULL precision and round
  // ONCE — matching the Postgres SUM(remainingQty*unitCostBase) aggregate path
  // (sum-then-round) and inventory-snapshot.ts's stateFromCurrentRows. upsertState
  // rounds the running total per-add, which diverged from the SQL path at the 6th dp,
  // leaving two different "inventory value" numbers in the system for the same as-of date.
  const layerValueByKey = new Map<string, { productId: string; warehouseId: string; value: Decimal }>()
  for (const layer of costLayers) {
    const key = stateKey(layer.productId, layer.warehouseId)
    const entry = layerValueByKey.get(key) ?? { productId: layer.productId, warehouseId: layer.warehouseId, value: toDecimal(0) }
    entry.value = entry.value.add(toDecimal(layer.remainingQty).mul(toDecimal(layer.unitCostBase)))
    layerValueByKey.set(key, entry)
  }
  for (const { productId, warehouseId, value } of layerValueByKey.values()) {
    const key = stateKey(productId, warehouseId)
    const existing = state.get(key) ?? { productId, warehouseId, qty: toDecimal(0), valueBase: toDecimal(0) }
    existing.valueBase = roundValue(value)
    state.set(key, existing)
  }

  return state
}

function stateFromAggregatedCurrentRows(rows: readonly AggregatedCurrentStateRow[]): OnHandState {
  const state = emptyState()
  for (const row of rows) {
    state.set(stateKey(row.productId, row.warehouseId), {
      productId: row.productId,
      warehouseId: row.warehouseId,
      qty: roundQty(row.quantity),
      valueBase: roundValue(row.valueBase),
    })
  }
  return state
}

function currentStateSqlFilters(filters: OnHandAsOfFilters, alias: 'sl' | 'cl'): Prisma.Sql {
  return Prisma.sql`
    ${filters.productId ? Prisma.sql`AND ${Prisma.raw(alias)}."productId" = ${filters.productId}` : Prisma.empty}
    ${filters.warehouseId ? Prisma.sql`AND ${Prisma.raw(alias)}."warehouseId" = ${filters.warehouseId}` : Prisma.empty}
    ${filters.categoryId ? Prisma.sql`AND p."categoryId" = ${filters.categoryId}` : Prisma.empty}
    ${filters.productType ? Prisma.sql`AND p."type" = ${filters.productType}::"ProductType"` : Prisma.empty}
    ${filters.productSearch ? Prisma.sql`AND (p.sku ILIKE ${`%${filters.productSearch}%`} OR p.name ILIKE ${`%${filters.productSearch}%`})` : Prisma.empty}
    ${filters.supplierId ? Prisma.sql`AND EXISTS (
      SELECT 1
      FROM supplier_products sp
      WHERE sp."productId" = p.id
        AND sp."supplierId" = ${filters.supplierId}
    )` : Prisma.empty}
  `
}

function movementValue(movement: MovementRow): Decimal | null {
  return movement.totalValueBase == null ? null : toDecimal(movement.totalValueBase).abs()
}

function applyMovement(
  state: OnHandState,
  movement: MovementRow,
  filters: OnHandAsOfFilters,
  direction: 'forward' | 'reverse',
): ApplyMovementResult {
  const qty = toDecimal(movement.qty).abs()
  const value = movementValue(movement)

  if (!movement.fromWarehouseId && !movement.toWarehouseId) {
    return qty.isZero()
      ? { applied: false, valueReliable: true, orphanWarehouse: false }
      : { applied: false, valueReliable: false, orphanWarehouse: true, movement }
  }

  const multiplier = direction === 'forward' ? 1 : -1
  let applied = false

  if (movement.toWarehouseId && (!filters.warehouseId || filters.warehouseId === movement.toWarehouseId)) {
    upsertState(
      state,
      movement.productId,
      movement.toWarehouseId,
      qty.mul(multiplier),
      (value ?? toDecimal(0)).mul(multiplier),
    )
    applied = true
  }

  if (movement.fromWarehouseId && (!filters.warehouseId || filters.warehouseId === movement.fromWarehouseId)) {
    upsertState(
      state,
      movement.productId,
      movement.fromWarehouseId,
      qty.mul(-multiplier),
      (value ?? toDecimal(0)).mul(-multiplier),
    )
    applied = true
  }

  return applied
    ? { applied: true, valueReliable: value !== null, orphanWarehouse: false, movement }
    : { applied: false, valueReliable: true, orphanWarehouse: false }
}

function rowsFromState(state: OnHandState, options: { excludeZero?: boolean } = {}): OnHandAsOfRow[] {
  return [...state.values()]
    .filter((entry) => !options.excludeZero || !roundQty(entry.qty).isZero() || !roundValue(entry.valueBase).isZero())
    .map((entry) => {
      const qty = roundQty(entry.qty)
      const valueBase = roundValue(entry.valueBase)
      return {
        productId: entry.productId,
        warehouseId: entry.warehouseId,
        qty: qty.toFixed(6),
        valueBase: valueBase.toFixed(6),
        unitCostBase: qty.gt(0) ? roundValue(valueBase.div(qty)).toFixed(6) : null,
      }
    })
    .sort((a, b) => (
      a.productId.localeCompare(b.productId) ||
      a.warehouseId.localeCompare(b.warehouseId)
    ))
}

async function findPriorSnapshotDate(client: OnHandAsOfClient, asOfDay: Date, inclusive: boolean): Promise<Date | null> {
  const row = await client.inventorySnapshot.findFirst({
    where: { snapshotDate: inclusive ? { lte: asOfDay } : { lt: asOfDay } },
    select: { snapshotDate: true },
    orderBy: { snapshotDate: 'desc' },
  })
  return row?.snapshotDate ?? null
}

async function findFutureSnapshotDate(client: OnHandAsOfClient, asOfDay: Date, exclusive: boolean): Promise<Date | null> {
  const row = await client.inventorySnapshot.findFirst({
    where: { snapshotDate: exclusive ? { gt: asOfDay } : { gte: asOfDay } },
    select: { snapshotDate: true },
    orderBy: { snapshotDate: 'asc' },
  })
  return row?.snapshotDate ?? null
}

async function loadSnapshotState(
  client: OnHandAsOfClient,
  snapshotDate: Date,
  filters: OnHandAsOfFilters,
): Promise<OnHandState> {
  const rows = await client.inventorySnapshot.findMany({
    where: snapshotWhere(snapshotDate, filters),
    select: { productId: true, warehouseId: true, qty: true, valueBase: true },
    orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }],
  })
  return stateFromSnapshots(rows)
}

/**
 * Count in-scope snapshot rows for a date whose stored value was flagged not
 * point-in-time accurate at write (e.g. a backfilled row seeded from cost layers
 * revalued after that date). Lets snapshot-backed as-of reads surface a stale
 * basis instead of trusting it (scjz.43/.48).
 */
async function countUnreliableSnapshots(
  client: OnHandAsOfClient,
  snapshotDate: Date,
  filters: OnHandAsOfFilters,
): Promise<number> {
  return client.inventorySnapshot.count({
    where: { ...snapshotWhere(snapshotDate, filters), valueReplayReliable: false },
  })
}

async function loadCurrentState(
  client: OnHandAsOfClient,
  filters: OnHandAsOfFilters,
): Promise<{ state: OnHandState; driftCount: number }> {
  if (client.$queryRaw) {
    const rows = await client.$queryRaw<AggregatedCurrentStateRow[]>(Prisma.sql`
      WITH stock_values AS (
        SELECT
          sl."productId",
          sl."warehouseId",
          sl.quantity,
          COALESCE(SUM(cl."remainingQty" * cl."unitCostBase"), 0) AS "valueBase",
          COALESCE(SUM(cl."remainingQty"), 0) AS "layerQty"
        FROM stock_levels sl
        JOIN products p
          ON p.id = sl."productId"
        LEFT JOIN cost_layers cl
          ON cl."productId" = sl."productId"
          AND cl."warehouseId" = sl."warehouseId"
          AND cl."remainingQty" > 0
        WHERE 1 = 1
          ${currentStateSqlFilters(filters, 'sl')}
        GROUP BY sl."productId", sl."warehouseId", sl.quantity
      ),
      orphan_layer_values AS (
        SELECT
          cl."productId",
          cl."warehouseId",
          0::numeric AS quantity,
          SUM(cl."remainingQty" * cl."unitCostBase") AS "valueBase",
          SUM(cl."remainingQty") AS "layerQty"
        FROM cost_layers cl
        JOIN products p
          ON p.id = cl."productId"
        LEFT JOIN stock_levels sl
          ON sl."productId" = cl."productId"
          AND sl."warehouseId" = cl."warehouseId"
        WHERE cl."remainingQty" > 0
          AND sl.id IS NULL
          ${currentStateSqlFilters(filters, 'cl')}
        GROUP BY cl."productId", cl."warehouseId"
      )
      SELECT * FROM stock_values
      UNION ALL
      SELECT * FROM orphan_layer_values
      ORDER BY "productId", "warehouseId"
    `)
    const driftCount = rows.reduce(
      (count, row) => count + (isCurrentValueDrifted(row.quantity, row.layerQty) ? 1 : 0),
      0,
    )
    return { state: stateFromAggregatedCurrentRows(rows), driftCount }
  }

  const [stockLevels, costLayers] = await Promise.all([
    client.stockLevel.findMany({
      where: currentStockWhere(filters),
      select: { productId: true, warehouseId: true, quantity: true },
      orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }],
    }),
    client.costLayer.findMany({
      where: {
        ...currentCostLayerWhere(filters),
        remainingQty: { gt: 0 },
      },
      select: { productId: true, warehouseId: true, remainingQty: true, unitCostBase: true },
      orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }, { receivedAt: 'asc' }],
    }),
  ])
  return {
    state: stateFromCurrentRows(stockLevels, costLayers),
    driftCount: currentValueDriftCount(stockLevels, costLayers),
  }
}

// Count (product, warehouse) pairs whose open cost-layer quantity diverges from
// the stock_levels quantity — the non-raw mirror of the SQL drift count (scjz.44).
function currentValueDriftCount(
  stockLevels: readonly StockLevelRow[],
  costLayers: readonly CostLayerRow[],
): number {
  const stockQtyByPair = new Map<string, Decimal>()
  for (const stockLevel of stockLevels) {
    stockQtyByPair.set(stateKey(stockLevel.productId, stockLevel.warehouseId), toDecimal(stockLevel.quantity))
  }
  const layerQtyByPair = new Map<string, Decimal>()
  for (const layer of costLayers) {
    const key = stateKey(layer.productId, layer.warehouseId)
    layerQtyByPair.set(key, addMoney(layerQtyByPair.get(key) ?? toDecimal(0), toDecimal(layer.remainingQty)))
  }
  let driftCount = 0
  for (const key of new Set([...stockQtyByPair.keys(), ...layerQtyByPair.keys()])) {
    const stockQty = stockQtyByPair.get(key) ?? toDecimal(0)
    const layerQty = layerQtyByPair.get(key) ?? toDecimal(0)
    if (isCurrentValueDrifted(stockQty, layerQty)) driftCount += 1
  }
  return driftCount
}

async function replayMovements(
  client: OnHandAsOfClient,
  state: OnHandState,
  filters: OnHandAsOfFilters,
  range: ReplayDateRange,
  direction: 'forward' | 'reverse',
  signal?: AbortSignal,
): Promise<ReplayMovementsResult> {
  if (isEmptyReplayRange(range)) return emptyReplayResult()
  validateReplayRange(range)
  const result = emptyReplayResult()
  let cursor: { id: string } | undefined

  while (true) {
    assertNotAborted(signal)
    const movements = await client.stockMovement.findMany({
      where: {
        createdAt: range,
        ...productWhere(filters),
        ...warehouseMovementWhere(filters),
      },
      select: {
        id: true,
        createdAt: true,
        type: true,
        productId: true,
        fromWarehouseId: true,
        toWarehouseId: true,
        qty: true,
        totalValueBase: true,
      },
      orderBy: direction === 'forward'
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MOVEMENT_REPLAY_PAGE_SIZE,
      ...(cursor ? { cursor, skip: 1 } : {}),
    })

    for (const movement of movements) {
      const applyResult = applyMovement(state, movement, filters, direction)
      if (applyResult.orphanWarehouse) {
        result.orphanWarehouseMovementCount += 1
      } else if (applyResult.applied && !applyResult.valueReliable) {
        recordMissingValueMovement(result, applyResult.movement)
      }
    }

    if (movements.length < MOVEMENT_REPLAY_PAGE_SIZE) {
      break
    }

    cursor = { id: movements[movements.length - 1]!.id }
  }

  return result
}

/**
 * Returns inventory on-hand position at a daily reporting boundary.
 *
 * Dispatch:
 * - `asOf >= now`: uses live stock levels and open cost layers (`source: current`).
 * - prior snapshot exists: uses that snapshot plus forward StockMovement replay.
 * - only a future snapshot exists: reverses movements from that later snapshot.
 * - no snapshots exist: reverses from current state inside a serializable transaction when the client supports it.
 *
 * Reliability:
 * - `valueReplayReliable: false` means replay touched movements with null `totalValueBase`
 *   or non-zero movements with neither warehouse set. Quantities remain useful; values/unit
 *   costs are advisory and consumers must surface that state instead of treating them as audited.
 * - Current-source values come from open cost layers, not movement replay, so the replay flag
 *   does not replace the inventory snapshot drift checks.
 *
 * Time semantics:
 * - String inputs must be `YYYY-MM-DD` and name a Europe/London business day: the as-of is the END of that London day (23:00Z in BST), the same day
 *   convention snapshots are labelled by. The returned `asOf` is the last millisecond of that London day (22:59:59.999Z in BST).
 * - Date/number inputs are accepted for exact instants; ISO datetime strings are intentionally rejected.
 * - `asOf` is inclusive. Snapshot anchors are exclusive: replay starts/ends at the snapshot's own `cutoffAt` (the run row's stored value, else the end of
 *   its London label day), never at a UTC midnight.
 *
 * @throws InventoryAsOfFutureError when `asOf` is after the current London business day.
 * @throws Error when the date string is invalid or is not `YYYY-MM-DD`.
 */
export async function getOnHandAsOf(options: {
  asOf?: AsOfInput
  productId?: string
  warehouseId?: string
  categoryId?: string
  productType?: ProductType
  supplierId?: string
  productSearch?: string
  excludeZero?: boolean
  client?: OnHandAsOfClient
  now?: () => Date
  signal?: AbortSignal
} = {}): Promise<OnHandAsOfResult> {
  const client = options.client ?? db
  const now = options.now?.() ?? new Date()
  const { asOf, isDateOnly } = parseAsOf(options.asOf)
  // A date-only as-of NAMES a London business day (the day snapshots are labelled by); `asOf` is the raw parsed value (an end-of-UTC-day proxy for date-only); the returned asOf is `resultAsOf` below. Every boundary below comes from `dayEnd` (start of the next London day), never from the UTC day.
  const asOfDay = isDateOnly ? startOfUtcDay(asOf) : businessDayLabel(asOf)
  const dayEnd = startOfNextBusinessDay(asOfDay)
  // The instant reported back: a date-only as-of ends at the last millisecond of the London day (22:59:59.999Z in BST), a precise instant is echoed as given.
  const resultAsOf = isDateOnly ? new Date(dayEnd.getTime() - 1) : asOf
  if (isDateOnly ? asOfDay > businessDayLabel(now) : asOf > endOfUtcDay(now)) {
    throw new InventoryAsOfFutureError()
  }

  const filters = {
    productId: options.productId,
    warehouseId: options.warehouseId,
    categoryId: options.categoryId,
    productType: options.productType,
    supplierId: options.supplierId,
    productSearch: options.productSearch,
    excludeZero: options.excludeZero,
  }

  if (isDateOnly ? dayEnd > now : asOf >= now) {
    const { state, driftCount } = await loadCurrentState(client, filters)
    return buildResult({
      asOf: resultAsOf,
      generatedAt: now,
      anchorDate: null,
      source: 'current',
      state,
      excludeZero: options.excludeZero,
      currentValueFromCostLayers: true,
      currentValueDriftCount: driftCount,
    })
  }

  // A date-only as-of covers the whole London business day, so bound replay at the next London midnight (half-open) rather than the `.999Z` end-of-day proxy, which would
  // drop movements in the `.999000`–`.999999` microsecond band (forward replay)
  // or wrongly reverse them out (reverse replay). Precise instants keep their
  // inclusive `lte`/exclusive `gt` semantics (scjz.49).
  const asOfUpperBound: { lt: Date } | { lte: Date } = isDateOnly
    ? { lt: dayEnd }
    : { lte: asOf }
  const asOfLowerBound: { gte: Date } | { gt: Date } = isDateOnly
    ? { gte: dayEnd }
    : { gt: asOf }
  // Lower edge of "revalued after asOf" (scjz.43). A date-only as-of covers the
  // whole London day, so "after" starts at the next London midnight (matching the replay
  // upper bound) — a same-day revaluation is already reflected in the day's value.
  const postAsOfRevaluationLowerBound: Prisma.DateTimeFilter = isDateOnly
    ? { gte: dayEnd }
    : { gt: asOf }
  // Replay range that moves a snapshot whose content stops at `cutoff` to the as-of bound, in either direction. cutoff <= bound: apply the movements in
  // [cutoff, bound) forward. cutoff > bound: reverse the movements in [bound, cutoff) out of the snapshot (date-only bound is the exclusive `dayEnd`;
  // a precise instant is inclusive, so only movements after it are reversed).
  const anchorReplayRange = (cutoff: Date): { range: ReplayDateRange; direction: 'forward' | 'reverse' } => {
    const cutoffAfterBound = isDateOnly ? cutoff > dayEnd : cutoff > asOf
    return cutoffAfterBound
      ? { range: { ...asOfLowerBound, lt: cutoff }, direction: 'reverse' }
      : { range: { gte: cutoff, ...asOfUpperBound }, direction: 'forward' }
  }
  // A precise instant inside day D cannot anchor on D's own snapshot (it holds the whole of D), so only strictly earlier labels qualify as prior.
  const priorSnapshotDate = await findPriorSnapshotDate(client, asOfDay, isDateOnly)
  if (priorSnapshotDate) {
    const priorCutoff = await loadSnapshotCutoff(client, priorSnapshotDate)
    const state = await loadSnapshotState(client, priorSnapshotDate, filters)
    // The anchor's cutoff is NOT always at or before the as-of bound: a legacy BACKFILLED summer-time day carries a cutoff past its own London day end (those
    // runs stored UTC midnight), so the snapshot already holds movements beyond the bound. (Legacy CRON rows are the other way round; see loadSnapshotCutoff.) Those are reversed out, never left in (o3d-cr517).
    const anchorRange = anchorReplayRange(priorCutoff)
    const replay = await replayMovements(client, state, filters, anchorRange.range, anchorRange.direction, options.signal)
    // Two distinct snapshot-backed inaccuracies: (a) a revaluation between the anchor and asOf the replay does not apply (movements carry
    // value, not cost-layer revaluations), and (b) the loaded snapshot row itself
    // persisted stale at write (backfilled from a later basis or missing-value).
    // Tracked separately so reports give the right reason (scjz.43/.48).
    const postAsOfRevaluationCount = await countPostAsOfRevaluations(client, filters, anchorRange.range)
    const staleSnapshotCount = await countUnreliableSnapshots(client, priorSnapshotDate, filters)
    return buildResult({
      asOf: resultAsOf,
      generatedAt: now,
      anchorDate: priorSnapshotDate,
      source: 'snapshot_forward_replay',
      state,
      replay,
      excludeZero: options.excludeZero,
      postAsOfRevaluationCount,
      staleSnapshotCount,
    })
  }

  const futureSnapshotDate = await findFutureSnapshotDate(client, asOfDay, isDateOnly)
  if (futureSnapshotDate) {
    const futureCutoff = await loadSnapshotCutoff(client, futureSnapshotDate)
    const state = await loadSnapshotState(client, futureSnapshotDate, filters)
    const anchorRange = anchorReplayRange(futureCutoff)
    const replay = await replayMovements(client, state, filters, anchorRange.range, anchorRange.direction, options.signal)
    // The future snapshot is frozen at a date AFTER asOf, so it already reflects any
    // revaluation effective up to then; reversing movements does not undo a
    // revaluation. Flag revaluations in (asOf, futureSnapshotDate], plus a future
    // snapshot row itself flagged stale at write (backfilled from a later basis) —
    // either makes the reversed-to-asOf basis not point-in-time (scjz.43/.48).
    const postAsOfRevaluationCount = await countPostAsOfRevaluations(client, filters, anchorRange.range)
    const staleSnapshotCount = await countUnreliableSnapshots(client, futureSnapshotDate, filters)
    return buildResult({
      asOf: resultAsOf,
      generatedAt: now,
      anchorDate: futureSnapshotDate,
      source: 'future_snapshot_reverse_replay',
      state,
      replay,
      excludeZero: options.excludeZero,
      postAsOfRevaluationCount,
      staleSnapshotCount,
    })
  }

  const runCurrentReverseReplay = async (txClient: OnHandAsOfClient): Promise<OnHandAsOfResult> => {
    // Reverse-replay (asOf in the past) reliability comes from the replay, not the
    // live drift flag, so the current-state drift count is not surfaced here.
    const { state } = await loadCurrentState(txClient, filters)
    // This path values from CURRENT layers, which reflect every revaluation, so flag
    // any revaluation effective after asOf. Counted INSIDE this transaction so a
    // revaluation committing between the count and loadCurrentState can't be valued
    // in yet reported reliable (scjz.43 TOCTOU).
    const txPostAsOfRevaluationCount = await countPostAsOfRevaluations(txClient, filters, postAsOfRevaluationLowerBound)
    const replay = await replayMovements(
      txClient,
      state,
      filters,
      { ...asOfLowerBound, lte: now },
      'reverse',
      options.signal,
    )
    return buildResult({
      asOf: resultAsOf,
      generatedAt: now,
      anchorDate: null,
      source: 'current_reverse_replay',
      state,
      replay,
      excludeZero: options.excludeZero,
      postAsOfRevaluationCount: txPostAsOfRevaluationCount,
    })
  }

  if (client.$transaction) {
    return client.$transaction(
      async (tx) => runCurrentReverseReplay(tx as OnHandAsOfClient),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  }

  return runCurrentReverseReplay(client)
}
