import { Prisma, type PrismaClient, type ProductType, type StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import {
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
}

export type OnHandAsOfClient = Pick<
  PrismaClient,
  'inventorySnapshot' | 'stockMovement' | 'stockLevel' | 'costLayer'
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
  return Boolean(lower && upper && lower.getTime() >= upper.getTime())
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
}): OnHandAsOfResult {
  const replay = input.replay ?? emptyReplayResult()
  return {
    asOf: formatDateTime(input.asOf),
    generatedAt: formatDateTime(input.generatedAt),
    anchorDate: input.anchorDate ? formatDate(input.anchorDate) : null,
    source: input.source,
    rows: rowsFromState(input.state, { excludeZero: input.excludeZero }),
    missingValueMovementCount: replay.missingValueMovementCount,
    orphanWarehouseMovementCount: replay.orphanWarehouseMovementCount,
    missingValueMovementSample: replay.missingValueMovementSample,
    valueReplayReliable: input.currentValueFromCostLayers
      ? true
      : replay.missingValueMovementCount === 0 && replay.orphanWarehouseMovementCount === 0,
  }
}

function stateKey(productId: string, warehouseId: string): string {
  return JSON.stringify([productId, warehouseId])
}

function parseAsOf(input: AsOfInput): Date {
  if (input == null) return new Date()

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
    return value
  }

  const value = new Date(input)
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid inventory as-of date: ${String(input)}`)
  }
  return value
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function startOfNextUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
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

  for (const layer of costLayers) {
    upsertState(
      state,
      layer.productId,
      layer.warehouseId,
      0,
      toDecimal(layer.remainingQty).mul(toDecimal(layer.unitCostBase)),
    )
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

async function findPriorSnapshotDate(client: OnHandAsOfClient, asOfDay: Date): Promise<Date | null> {
  const row = await client.inventorySnapshot.findFirst({
    where: { snapshotDate: { lte: asOfDay } },
    select: { snapshotDate: true },
    orderBy: { snapshotDate: 'desc' },
  })
  return row?.snapshotDate ?? null
}

async function findFutureSnapshotDate(client: OnHandAsOfClient, asOfDay: Date): Promise<Date | null> {
  const row = await client.inventorySnapshot.findFirst({
    where: { snapshotDate: { gt: asOfDay } },
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

async function loadCurrentState(
  client: OnHandAsOfClient,
  filters: OnHandAsOfFilters,
): Promise<OnHandState> {
  if (client.$queryRaw) {
    const rows = await client.$queryRaw<AggregatedCurrentStateRow[]>(Prisma.sql`
      WITH stock_values AS (
        SELECT
          sl."productId",
          sl."warehouseId",
          sl.quantity,
          COALESCE(SUM(cl."remainingQty" * cl."unitCostBase"), 0) AS "valueBase"
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
          SUM(cl."remainingQty" * cl."unitCostBase") AS "valueBase"
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
    return stateFromAggregatedCurrentRows(rows)
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
  return stateFromCurrentRows(stockLevels, costLayers)
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
 * - String inputs must be `YYYY-MM-DD` and are interpreted as end-of-day UTC.
 * - Date/number inputs are accepted for exact instants; ISO datetime strings are intentionally rejected.
 * - `asOf` is inclusive. Snapshot anchors are exclusive because snapshots represent the
 *   just-ended UTC day.
 *
 * @throws InventoryAsOfFutureError when `asOf` is after the current UTC day.
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
  const asOf = parseAsOf(options.asOf)
  if (asOf > endOfUtcDay(now)) {
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

  if (asOf >= now) {
    const state = await loadCurrentState(client, filters)
    return buildResult({
      asOf,
      generatedAt: now,
      anchorDate: null,
      source: 'current',
      state,
      excludeZero: options.excludeZero,
      currentValueFromCostLayers: true,
    })
  }

  const asOfDay = startOfUtcDay(asOf)
  const priorSnapshotDate = await findPriorSnapshotDate(client, asOfDay)
  if (priorSnapshotDate) {
    const state = await loadSnapshotState(client, priorSnapshotDate, filters)
    const replay = await replayMovements(
      client,
      state,
      filters,
      { gte: startOfNextUtcDay(priorSnapshotDate), lte: asOf },
      'forward',
      options.signal,
    )
    return buildResult({
      asOf,
      generatedAt: now,
      anchorDate: priorSnapshotDate,
      source: 'snapshot_forward_replay',
      state,
      replay,
      excludeZero: options.excludeZero,
    })
  }

  const futureSnapshotDate = await findFutureSnapshotDate(client, asOfDay)
  if (futureSnapshotDate) {
    const state = await loadSnapshotState(client, futureSnapshotDate, filters)
    const replay = await replayMovements(
      client,
      state,
      filters,
      { gt: asOf, lt: startOfNextUtcDay(futureSnapshotDate) },
      'reverse',
      options.signal,
    )
    return buildResult({
      asOf,
      generatedAt: now,
      anchorDate: futureSnapshotDate,
      source: 'future_snapshot_reverse_replay',
      state,
      replay,
      excludeZero: options.excludeZero,
    })
  }

  const runCurrentReverseReplay = async (txClient: OnHandAsOfClient): Promise<OnHandAsOfResult> => {
    const state = await loadCurrentState(txClient, filters)
    const replay = await replayMovements(
      txClient,
      state,
      filters,
      { gt: asOf, lte: now },
      'reverse',
      options.signal,
    )
    return buildResult({
      asOf,
      generatedAt: now,
      anchorDate: null,
      source: 'current_reverse_replay',
      state,
      replay,
      excludeZero: options.excludeZero,
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
