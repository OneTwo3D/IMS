import { Prisma, type PrismaClient, type StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import {
  loadReservationSourceRows,
  type ReservationBreakdownClient,
  type ReservationBreakdownRow,
} from '@/lib/domain/inventory/reservation-breakdown'
import {
  roundQuantity,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

export const INVENTORY_SNAPSHOT_QTY_TOLERANCE = new Prisma.Decimal('0.0001')
export const MAX_INVENTORY_SNAPSHOT_DRIFT_DETAILS = 25
const BACKFILL_MOVEMENT_PAGE_SIZE = 1000
const SNAPSHOT_WRITE_BATCH_SIZE = 1000
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const QTY_MATERIAL_THRESHOLD = new Prisma.Decimal('0.00005')
const VALUE_MATERIAL_THRESHOLD = new Prisma.Decimal('0.0000005')

type SnapshotDateInput = Date | string | number | null | undefined

export type InventorySnapshotStockLevelRow = {
  productId: string
  warehouseId: string
  quantity: DecimalInput
}

export type InventoryReservationSnapshotStockLevelRow = InventorySnapshotStockLevelRow & {
  reservedQty: DecimalInput
}

export type InventorySnapshotCostLayerRow = {
  productId: string
  warehouseId: string
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
}

export type InventorySnapshotMovementRow = {
  id: string
  type: StockMovementType
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  qty: DecimalInput
  totalValueBase: DecimalInput
  createdAt: Date
}

export type InventorySnapshotRowInput = {
  snapshotDate: Date
  productId: string
  warehouseId: string
  qty: Decimal
  valueBase: Decimal
  unitCostBase: Decimal | null
}

export type InventoryReservationSnapshotRowInput = {
  snapshotDate: Date
  productId: string
  warehouseId: string
  reservedQty: Decimal
  availableQty: Decimal
  reservationSourceCount: number
}

export type InventoryReservationSnapshotRunInput = {
  snapshotDate: Date
  stockLevelCount: number
  reservationSnapshotCount: number
  source: 'cron' | 'backfill'
  checkMethod: string
  cutoffAt: Date | null
  reservationSourceCount: number | null
}

export type InventorySnapshotDrift = {
  productId: string
  warehouseId: string
  stockQty: string
  costLayerQty: string
  delta: string
}

export type InventorySnapshotBuildResult = {
  snapshotDate: Date
  rows: InventorySnapshotRowInput[]
  drift: InventorySnapshotDrift[]
}

export type InventorySnapshotWriteResult = {
  snapshotDate: string
  snapshotsWritten: number
  reservationSnapshotsWritten: number
  reservationSnapshotStockLevelCount: number
  driftCount: number
  driftTruncated: boolean
  drift: InventorySnapshotDrift[]
}

export type InventorySnapshotBackfillResult = {
  fromDate: string
  toDate: string
  daysWritten: number
  snapshotsWritten: number
  missingValueMovementCount: number
  // Cost-layer revaluations that took effect after fromDate. Backfilled snapshots
  // seed value from CURRENT cost layers, which already reflect later landed-cost /
  // manufacturing revaluations, so any such revaluation means at least some
  // backfilled date's value is not the basis valid then (scjz.48). >0 ⇒ unreliable.
  postBackfillRevaluationCount: number
  dryRun: boolean
  valueReplayReliable: boolean
  reservationBackfill: InventoryReservationSnapshotBackfillResult
}

export type InventoryReservationSnapshotBackfillWarningCode =
  | 'reservation_source_changed_after_cutoff'
  | 'timestampless_shipment_line_history_unavailable'
  | 'assembly_component_history_unavailable'
  | 'negative_available_qty'

export type InventoryReservationSnapshotBackfillWarning = {
  snapshotDate: string
  code: InventoryReservationSnapshotBackfillWarningCode
  message: string
}

export type InventoryReservationSnapshotBackfillResult = {
  enabled: boolean
  reliability: 'not_attempted' | 'reliable' | 'warnings'
  totalDaysInRange: number
  supportedDaysWritten: number
  snapshotsWritten: number
  runMarkersWritten: number
  unsupportedDaysSkipped: number
  warnings: InventoryReservationSnapshotBackfillWarning[]
  knownLimitations: string[]
}

export type InventorySnapshotClient = Pick<
  PrismaClient,
  | 'salesOrder'
  | 'stockLevel'
  | 'costLayer'
  | 'costLayerRevaluation'
  | 'stockMovement'
  | 'inventorySnapshot'
  | 'inventoryReservationSnapshot'
  | 'inventoryReservationSnapshotRun'
  | 'orderAllocation'
  | 'shipmentLine'
  | 'productionOrder'
  | '$queryRaw'
  | '$transaction'
>

export type InventorySnapshotTestClient = {
  salesOrder: {
    aggregate(args: unknown): Promise<{ _max: { updatedAt: Date | null } }>
  }
  stockLevel: {
    findMany(args: unknown): Promise<Array<InventorySnapshotStockLevelRow | InventoryReservationSnapshotStockLevelRow>>
    findUnique(args: unknown): Promise<{ reservedQty: DecimalInput } | null>
  }
  costLayer: {
    findMany(args: unknown): Promise<InventorySnapshotCostLayerRow[]>
  }
  costLayerRevaluation: {
    count(args: unknown): Promise<number>
  }
  stockMovement: {
    findMany(args: unknown): Promise<InventorySnapshotMovementRow[]>
  }
  inventorySnapshot: {
    findMany(args: unknown): Promise<Array<{ snapshotDate: Date; valueBase: DecimalInput }>>
    upsert(args: unknown): Promise<unknown>
  }
  inventoryReservationSnapshot: {
    upsert(args: unknown): Promise<unknown>
  }
  inventoryReservationSnapshotRun: {
    upsert(args: unknown): Promise<unknown>
  }
  orderAllocation: ReservationBreakdownClient['orderAllocation'] & {
    aggregate(args: unknown): Promise<{ _max: { updatedAt: Date | null } }>
  }
  shipmentLine: ReservationBreakdownClient['shipmentLine'] & {
    findFirst(args: unknown): Promise<unknown | null>
  }
  productionOrder: ReservationBreakdownClient['productionOrder'] & {
    aggregate(args: unknown): Promise<{ _max: { updatedAt: Date | null } }>
    findFirst(args: unknown): Promise<unknown | null>
  }
  $queryRaw?: InventorySnapshotClient['$queryRaw']
  $transaction?<T>(operations: Promise<T>[]): Promise<T[]>
}

type SnapshotClient = InventorySnapshotClient | InventorySnapshotTestClient

type AggregatedSnapshotRow = {
  productId: string
  warehouseId: string
  stockQty: DecimalInput
  costLayerQty: DecimalInput
  valueBase: DecimalInput
}

type SnapshotBatchTransactionClient = {
  $transaction(operations: Promise<unknown>[]): Promise<unknown[]>
}

type SnapshotStateEntry = {
  productId: string
  warehouseId: string
  qty: Decimal
  valueBase: Decimal
}

type SnapshotState = Map<string, SnapshotStateEntry>

type ReservationBackfillSupportSnapshot = {
  latestMutableSourceUpdatedAt: Date | null
  hasTimestamplessShipmentLine: boolean
  hasAssemblyProductionOrder: boolean
}

const EMPTY_RESERVATION_BACKFILL_RESULT: InventoryReservationSnapshotBackfillResult = {
  enabled: false,
  reliability: 'not_attempted',
  totalDaysInRange: 0,
  supportedDaysWritten: 0,
  snapshotsWritten: 0,
  runMarkersWritten: 0,
  unsupportedDaysSkipped: 0,
  warnings: [],
  knownLimitations: [],
}

const RESERVATION_BACKFILL_CHECK_METHOD = 'current_sources_updated_at_gate_v2'
const RESERVATION_BACKFILL_LIMITATIONS = [
  'The mutation check assumes reservation-source writes use Prisma paths that maintain updatedAt values.',
  'Hard-deleted reservation source rows cannot be detected without a historical source audit table.',
  'Raw SQL updates that bypass updatedAt can make a supported day look safer than it is.',
]

function stockKey(productId: string, warehouseId: string): string {
  return JSON.stringify([productId, warehouseId])
}

function parseStockKey(key: string): [string, string] | null {
  try {
    const value = JSON.parse(key) as unknown
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      return [value[0], value[1]]
    }
  } catch {
    return null
  }

  return null
}

function parseSnapshotDate(input: SnapshotDateInput): Date {
  if (typeof input === 'string') {
    if (!DATE_ONLY_RE.test(input)) {
      throw new Error(`Inventory snapshot dates must use YYYY-MM-DD, got: ${input}`)
    }
    const [year, month, day] = input.split('-').map(Number)
    const value = new Date(Date.UTC(year!, month! - 1, day!))
    if (
      value.getUTCFullYear() !== year ||
      value.getUTCMonth() !== month! - 1 ||
      value.getUTCDate() !== day
    ) {
      throw new Error(`Invalid inventory snapshot date: ${input}`)
    }
    return value
  }

  const value = input == null ? new Date() : new Date(input)
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid inventory snapshot date: ${String(input)}`)
  }
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days))
}

function startOfNextUtcDay(date: Date): Date {
  return addUtcDays(date, 1)
}

function formatSnapshotDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function previousUtcDate(from: Date = new Date()): Date {
  return addUtcDays(parseSnapshotDate(from), -1)
}

function calendarDayCount(fromDate: Date, toDate: Date): number {
  return Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1
}

function roundQty(value: DecimalInput): Decimal {
  // Persist snapshot quantities at 6dp to match the live stock_levels / cost_layers
  // precision (cogs-audit scjz.1); rounding to 4dp here would make daily snapshots
  // and as-of reports disagree with the 6dp live quantities.
  return roundQuantity(value, 6)
}

function roundValue(value: DecimalInput): Decimal {
  return roundQuantity(value, 6)
}

function decimalString(value: DecimalInput, precision: number): string {
  return roundQuantity(value, precision).toFixed(precision)
}

function isMaterialQty(value: DecimalInput): boolean {
  return toDecimal(value).abs().gte(QTY_MATERIAL_THRESHOLD)
}

function isMaterialValue(value: DecimalInput): boolean {
  return toDecimal(value).abs().gte(VALUE_MATERIAL_THRESHOLD)
}

function stateFromCurrentRows(
  stockLevels: readonly InventorySnapshotStockLevelRow[],
  costLayers: readonly InventorySnapshotCostLayerRow[],
): { state: SnapshotState; costLayerQtyByKey: Map<string, Decimal> } {
  const state: SnapshotState = new Map()
  const costLayerQtyByKey = new Map<string, Decimal>()

  for (const stockLevel of stockLevels) {
    const key = stockKey(stockLevel.productId, stockLevel.warehouseId)
    state.set(key, {
      productId: stockLevel.productId,
      warehouseId: stockLevel.warehouseId,
      qty: roundQty(stockLevel.quantity),
      valueBase: toDecimal(0),
    })
  }

  for (const layer of costLayers) {
    const key = stockKey(layer.productId, layer.warehouseId)
    const remainingQty = toDecimal(layer.remainingQty)
    const valueBase = remainingQty.mul(toDecimal(layer.unitCostBase))
    const existing = state.get(key) ?? {
      productId: layer.productId,
      warehouseId: layer.warehouseId,
      qty: toDecimal(0),
      valueBase: toDecimal(0),
    }
    existing.valueBase = existing.valueBase.add(valueBase)
    state.set(key, existing)
    costLayerQtyByKey.set(key, (costLayerQtyByKey.get(key) ?? toDecimal(0)).add(remainingQty))
  }

  return { state, costLayerQtyByKey }
}

function rowFromStateEntry(snapshotDate: Date, entry: SnapshotStateEntry): InventorySnapshotRowInput {
  const qty = roundQty(entry.qty)
  const valueBase = roundValue(entry.valueBase)
  return {
    snapshotDate,
    productId: entry.productId,
    warehouseId: entry.warehouseId,
    qty,
    valueBase,
    unitCostBase: qty.gt(0) ? roundValue(valueBase.div(qty)) : null,
  }
}

function rowsFromState(snapshotDate: Date, state: SnapshotState): InventorySnapshotRowInput[] {
  return [...state.values()]
    .map((entry) => rowFromStateEntry(snapshotDate, entry))
    .sort((a, b) => (
      a.productId.localeCompare(b.productId) ||
      a.warehouseId.localeCompare(b.warehouseId)
    ))
}

function findDrift(
  state: SnapshotState,
  costLayerQtyByKey: Map<string, Decimal>,
  tolerance: Decimal = INVENTORY_SNAPSHOT_QTY_TOLERANCE,
): InventorySnapshotDrift[] {
  const keys = new Set([...state.keys(), ...costLayerQtyByKey.keys()])
  const drift: InventorySnapshotDrift[] = []

  for (const key of [...keys].sort()) {
    const entry = state.get(key)
    const parsedKey = parseStockKey(key)
    if (!parsedKey) continue
    const [productId, warehouseId] = parsedKey
    const stockQty = entry?.qty ?? toDecimal(0)
    const costLayerQty = costLayerQtyByKey.get(key) ?? toDecimal(0)
    const delta = stockQty.sub(costLayerQty)
    if (delta.abs().lte(tolerance)) continue
    drift.push({
      productId,
      warehouseId,
      stockQty: decimalString(stockQty, 4),
      costLayerQty: decimalString(costLayerQty, 4),
      delta: decimalString(delta, 4),
    })
  }

  return drift
}

export function buildInventorySnapshotRows(input: {
  snapshotDate?: SnapshotDateInput
  stockLevels: readonly InventorySnapshotStockLevelRow[]
  costLayers: readonly InventorySnapshotCostLayerRow[]
  tolerance?: Decimal
}): InventorySnapshotBuildResult {
  const snapshotDate = parseSnapshotDate(input.snapshotDate)
  const { state, costLayerQtyByKey } = stateFromCurrentRows(input.stockLevels, input.costLayers)

  return {
    snapshotDate,
    rows: rowsFromState(snapshotDate, state),
    drift: findDrift(state, costLayerQtyByKey, input.tolerance),
  }
}

function sourceCountKey(row: Pick<ReservationBreakdownRow, 'productId' | 'warehouseId'>): string {
  return stockKey(row.productId, row.warehouseId)
}

export function buildInventoryReservationSnapshotRows(input: {
  snapshotDate?: SnapshotDateInput
  stockLevels: readonly InventoryReservationSnapshotStockLevelRow[]
  reservationSources: readonly ReservationBreakdownRow[]
}): InventoryReservationSnapshotRowInput[] {
  const snapshotDate = parseSnapshotDate(input.snapshotDate)
  const sourceCounts = new Map<string, number>()
  for (const source of input.reservationSources) {
    const key = sourceCountKey(source)
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1)
  }

  return input.stockLevels
    .map((level) => {
      const reservedQty = roundQty(level.reservedQty)
      return {
        snapshotDate,
        productId: level.productId,
        warehouseId: level.warehouseId,
        reservedQty,
        availableQty: roundQty(toDecimal(level.quantity).sub(reservedQty)),
        reservationSourceCount: sourceCounts.get(stockKey(level.productId, level.warehouseId)) ?? 0,
      }
    })
    .filter((row) => !row.reservedQty.isZero() || row.reservationSourceCount > 0)
    .sort((a, b) => (
      a.productId.localeCompare(b.productId) ||
      a.warehouseId.localeCompare(b.warehouseId)
    ))
}

function reservationSourceStatsByKey(reservationSources: readonly ReservationBreakdownRow[]): Map<string, {
  reservedQty: Decimal
  reservationSourceCount: number
}> {
  const stats = new Map<string, { reservedQty: Decimal; reservationSourceCount: number }>()
  for (const source of reservationSources) {
    const key = sourceCountKey(source)
    const existing = stats.get(key) ?? {
      reservedQty: toDecimal(0),
      reservationSourceCount: 0,
    }
    existing.reservedQty = existing.reservedQty.add(toDecimal(source.qty))
    existing.reservationSourceCount += 1
    stats.set(key, existing)
  }
  return stats
}

function buildBackfilledReservationSnapshotRows(input: {
  snapshotDate: Date
  inventoryRows: readonly InventorySnapshotRowInput[]
  reservationSources: readonly ReservationBreakdownRow[]
}): {
  rows: InventoryReservationSnapshotRowInput[]
  inventorySnapshotRowCount: number
  negativeAvailableRowCount: number
} {
  const sourceStats = reservationSourceStatsByKey(input.reservationSources)
  const inventoryRowsByKey = new Map(input.inventoryRows.map((row) => [
    stockKey(row.productId, row.warehouseId),
    row,
  ]))
  const keys = new Set([...inventoryRowsByKey.keys(), ...sourceStats.keys()])
  const rows: InventoryReservationSnapshotRowInput[] = []
  let negativeAvailableRowCount = 0

  for (const key of [...keys].sort()) {
    const parsedKey = parseStockKey(key)
    if (!parsedKey) continue
    const [productId, warehouseId] = parsedKey
    const inventoryRow = inventoryRowsByKey.get(key)
    const source = sourceStats.get(key)
    const reservedQty = roundQty(source?.reservedQty ?? 0)
    const reservationSourceCount = source?.reservationSourceCount ?? 0
    if (reservedQty.isZero() && reservationSourceCount === 0) continue
    const quantity = inventoryRow?.qty ?? toDecimal(0)
    const availableQty = roundQty(quantity.sub(reservedQty))
    if (availableQty.lt(0)) negativeAvailableRowCount += 1
    rows.push({
      snapshotDate: input.snapshotDate,
      productId,
      warehouseId,
      reservedQty,
      availableQty,
      reservationSourceCount,
    })
  }

  rows.sort((a, b) => (
    a.productId.localeCompare(b.productId) ||
    a.warehouseId.localeCompare(b.warehouseId)
  ))

  return {
    rows,
    inventorySnapshotRowCount: input.inventoryRows.length,
    negativeAvailableRowCount,
  }
}

async function loadCurrentSnapshotRows(client: SnapshotClient): Promise<{
  stockLevels: InventorySnapshotStockLevelRow[]
  costLayers: InventorySnapshotCostLayerRow[]
}> {
  const [stockLevels, costLayers] = await Promise.all([
    client.stockLevel.findMany({
      select: { productId: true, warehouseId: true, quantity: true },
    }),
    client.costLayer.findMany({
      where: { remainingQty: { gt: 0 } },
      select: { productId: true, warehouseId: true, remainingQty: true, unitCostBase: true },
    }),
  ])

  return { stockLevels, costLayers }
}

function assertReservationStockLevelRow(
  row: InventorySnapshotStockLevelRow | InventoryReservationSnapshotStockLevelRow,
): asserts row is InventoryReservationSnapshotStockLevelRow {
  if (!('reservedQty' in row)) {
    throw new Error('Reservation snapshot stock-level query must select reservedQty')
  }
}

function latestDate(...values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest
    if (!latest || value > latest) return value
    return latest
  }, null)
}

async function loadReservationBackfillSupportSnapshot(
  client: SnapshotClient,
): Promise<ReservationBackfillSupportSnapshot> {
  const [
    allocationMax,
    orderMax,
    productionMax,
    timestamplessShipmentLine,
    assemblyProductionOrder,
  ] = await Promise.all([
    client.orderAllocation.aggregate({
      _max: { updatedAt: true },
    } as never) as Promise<{ _max: { updatedAt: Date | null } }>,
    client.salesOrder.aggregate({
      _max: { updatedAt: true },
    } as never) as Promise<{ _max: { updatedAt: Date | null } }>,
    client.productionOrder.aggregate({
      _max: { updatedAt: true },
    } as never) as Promise<{ _max: { updatedAt: Date | null } }>,
    client.shipmentLine.findFirst({
      where: {
        shipment: {
          status: { not: 'PENDING' },
          order: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        },
      },
      select: { id: true },
    } as never),
    client.productionOrder.findFirst({
      where: {
        status: 'IN_PROGRESS',
        orderType: 'ASSEMBLY',
      },
      select: { id: true },
    } as never),
  ])

  return {
    latestMutableSourceUpdatedAt: latestDate(
      allocationMax._max.updatedAt,
      orderMax._max.updatedAt,
      productionMax._max.updatedAt,
    ),
    hasTimestamplessShipmentLine: timestamplessShipmentLine != null,
    hasAssemblyProductionOrder: assemblyProductionOrder != null,
  }
}

function reservationBackfillUnsupportedWarnings(
  snapshotDate: Date,
  exclusiveCutoff: Date,
  support: ReservationBackfillSupportSnapshot,
): InventoryReservationSnapshotBackfillWarning[] {
  const warnings: InventoryReservationSnapshotBackfillWarning[] = []
  const formattedDate = formatSnapshotDate(snapshotDate)

  if (support.latestMutableSourceUpdatedAt && support.latestMutableSourceUpdatedAt >= exclusiveCutoff) {
    warnings.push({
      snapshotDate: formattedDate,
      code: 'reservation_source_changed_after_cutoff',
      message: [
        `Reservation sources changed on or after ${exclusiveCutoff.toISOString()};`,
        'historical reserved quantities cannot be reconstructed from current allocation/shipment/production state for this day.',
      ].join(' '),
    })
  }

  if (support.hasTimestamplessShipmentLine) {
    warnings.push({
      snapshotDate: formattedDate,
      code: 'timestampless_shipment_line_history_unavailable',
      message: [
        'Committed shipment lines exist but shipment_lines has no updatedAt column;',
        'historical reservation reconstruction cannot prove shipment-line membership for this day.',
      ].join(' '),
    })
  }

  if (support.hasAssemblyProductionOrder) {
    warnings.push({
      snapshotDate: formattedDate,
      code: 'assembly_component_history_unavailable',
      message: [
        'In-progress assembly production orders depend on current BOM component membership;',
        'historical reservation reconstruction cannot prove component reservations for this day.',
      ].join(' '),
    })
  }

  return warnings
}

async function loadCurrentReservationSnapshotRows(
  client: SnapshotClient,
  snapshotDate: Date,
): Promise<{ rows: InventoryReservationSnapshotRowInput[]; stockLevelCount: number; reservationSourceCount: number }> {
  const [stockLevels, reservationSources] = await Promise.all([
    client.stockLevel.findMany({
      select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
    }),
    // TODO: replace detail-row loading with a grouped source-count query when
    // open allocation/manufacturing volumes make daily snapshots too slow.
    // Keep InventorySnapshotClient delegates aligned with ReservationBreakdownClient.
    loadReservationSourceRows(client as unknown as ReservationBreakdownClient),
  ])
  const reservationStockLevels: InventoryReservationSnapshotStockLevelRow[] = []
  for (const stockLevel of stockLevels) {
    assertReservationStockLevelRow(stockLevel)
    reservationStockLevels.push(stockLevel)
  }

  return {
    rows: buildInventoryReservationSnapshotRows({
      snapshotDate,
      stockLevels: reservationStockLevels,
      reservationSources,
    }),
    stockLevelCount: stockLevels.length,
    reservationSourceCount: reservationSources.length,
  }
}

function stateFromAggregatedRows(rows: readonly AggregatedSnapshotRow[]): {
  state: SnapshotState
  costLayerQtyByKey: Map<string, Decimal>
} {
  const state: SnapshotState = new Map()
  const costLayerQtyByKey = new Map<string, Decimal>()

  for (const row of rows) {
    const key = stockKey(row.productId, row.warehouseId)
    const qty = roundQty(row.stockQty)
    const valueBase = roundValue(row.valueBase)
    if (!isMaterialQty(qty) && !isMaterialValue(valueBase)) {
      state.set(key, {
        productId: row.productId,
        warehouseId: row.warehouseId,
        qty: toDecimal(0),
        valueBase: toDecimal(0),
      })
    } else {
      state.set(key, {
        productId: row.productId,
        warehouseId: row.warehouseId,
        qty,
        valueBase,
      })
    }
    costLayerQtyByKey.set(key, toDecimal(row.costLayerQty))
  }

  return { state, costLayerQtyByKey }
}

async function loadAggregatedCurrentSnapshotState(client: SnapshotClient): Promise<{
  state: SnapshotState
  costLayerQtyByKey: Map<string, Decimal>
}> {
  if ('$queryRaw' in client && typeof client.$queryRaw === 'function') {
    const rows = await client.$queryRaw<AggregatedSnapshotRow[]>(Prisma.sql`
      WITH stock_values AS (
        SELECT
          sl."productId",
          sl."warehouseId",
          sl.quantity AS "stockQty",
          COALESCE(SUM(cl."remainingQty"), 0) AS "costLayerQty",
          COALESCE(SUM(cl."remainingQty" * cl."unitCostBase"), 0) AS "valueBase"
        FROM stock_levels sl
        LEFT JOIN cost_layers cl
          ON cl."productId" = sl."productId"
          AND cl."warehouseId" = sl."warehouseId"
          AND cl."remainingQty" > 0
        GROUP BY sl."productId", sl."warehouseId", sl.quantity
      ),
      orphan_layer_values AS (
        SELECT
          cl."productId",
          cl."warehouseId",
          0::numeric AS "stockQty",
          SUM(cl."remainingQty") AS "costLayerQty",
          SUM(cl."remainingQty" * cl."unitCostBase") AS "valueBase"
        FROM cost_layers cl
        LEFT JOIN stock_levels sl
          ON sl."productId" = cl."productId"
          AND sl."warehouseId" = cl."warehouseId"
        WHERE cl."remainingQty" > 0
          AND sl.id IS NULL
        GROUP BY cl."productId", cl."warehouseId"
      )
      SELECT * FROM stock_values
      UNION ALL
      SELECT * FROM orphan_layer_values
      ORDER BY "productId", "warehouseId"
    `)

    return stateFromAggregatedRows(rows)
  }

  const { stockLevels, costLayers } = await loadCurrentSnapshotRows(client as InventorySnapshotClient)
  return stateFromCurrentRows(stockLevels, costLayers)
}

async function writeSnapshotRows(
  client: SnapshotClient,
  rows: readonly InventorySnapshotRowInput[],
): Promise<number> {
  for (let index = 0; index < rows.length; index += SNAPSHOT_WRITE_BATCH_SIZE) {
    const batch = rows.slice(index, index + SNAPSHOT_WRITE_BATCH_SIZE)
    const operations = batch.map((row) => (
      client.inventorySnapshot.upsert({
        where: {
          snapshotDate_productId_warehouseId: {
            snapshotDate: row.snapshotDate,
            productId: row.productId,
            warehouseId: row.warehouseId,
          },
        },
        create: {
          snapshotDate: row.snapshotDate,
          productId: row.productId,
          warehouseId: row.warehouseId,
          qty: row.qty,
          valueBase: row.valueBase,
          unitCostBase: row.unitCostBase,
        },
        update: {
          qty: row.qty,
          valueBase: row.valueBase,
          unitCostBase: row.unitCostBase,
        },
      } as never) as Promise<unknown>
    ))

    if ('$transaction' in client && typeof client.$transaction === 'function') {
      await (client as SnapshotBatchTransactionClient).$transaction(operations)
    } else {
      await Promise.all(operations)
    }
  }

  return rows.length
}

async function writeReservationSnapshotRows(
  client: SnapshotClient,
  rows: readonly InventoryReservationSnapshotRowInput[],
): Promise<number> {
  for (let index = 0; index < rows.length; index += SNAPSHOT_WRITE_BATCH_SIZE) {
    const batch = rows.slice(index, index + SNAPSHOT_WRITE_BATCH_SIZE)
    const updatedAt = new Date()
    const operations = batch.map((row) => (
      client.inventoryReservationSnapshot.upsert({
        where: {
          snapshotDate_productId_warehouseId: {
            snapshotDate: row.snapshotDate,
            productId: row.productId,
            warehouseId: row.warehouseId,
          },
        },
        create: {
          snapshotDate: row.snapshotDate,
          productId: row.productId,
          warehouseId: row.warehouseId,
          reservedQty: row.reservedQty,
          availableQty: row.availableQty,
          reservationSourceCount: row.reservationSourceCount,
        },
        update: {
          reservedQty: row.reservedQty,
          availableQty: row.availableQty,
          reservationSourceCount: row.reservationSourceCount,
          updatedAt,
        },
      } as never) as Promise<unknown>
    ))

    if ('$transaction' in client && typeof client.$transaction === 'function') {
      await (client as SnapshotBatchTransactionClient).$transaction(operations)
    } else {
      // TODO: tighten this fallback once snapshot test doubles require $transaction.
      // Promise.all can partially commit if a delegate rejects mid-batch.
      await Promise.all(operations)
    }
  }

  return rows.length
}

async function writeReservationSnapshotRun(
  client: SnapshotClient,
  row: InventoryReservationSnapshotRunInput,
): Promise<void> {
  const updatedAt = new Date()
  await client.inventoryReservationSnapshotRun.upsert({
    where: { snapshotDate: row.snapshotDate },
    create: {
      snapshotDate: row.snapshotDate,
      stockLevelCount: row.stockLevelCount,
      reservationSnapshotCount: row.reservationSnapshotCount,
      source: row.source,
      checkMethod: row.checkMethod,
      cutoffAt: row.cutoffAt,
      reservationSourceCount: row.reservationSourceCount,
    },
    update: {
      stockLevelCount: row.stockLevelCount,
      reservationSnapshotCount: row.reservationSnapshotCount,
      source: row.source,
      checkMethod: row.checkMethod,
      cutoffAt: row.cutoffAt,
      reservationSourceCount: row.reservationSourceCount,
      updatedAt,
    },
  } as never)
}

export async function writeDailyInventorySnapshot(options: {
  client?: SnapshotClient
  snapshotDate?: SnapshotDateInput
  tolerance?: Decimal
} = {}): Promise<InventorySnapshotWriteResult> {
  const client: SnapshotClient = options.client ?? db as SnapshotClient
  const snapshotDate = parseSnapshotDate(options.snapshotDate)
  const { state, costLayerQtyByKey } = await loadAggregatedCurrentSnapshotState(client)
  const reservationSnapshot = await loadCurrentReservationSnapshotRows(client, snapshotDate)
  const drift = findDrift(state, costLayerQtyByKey, options.tolerance)
  const rows = rowsFromState(snapshotDate, state)

  const snapshotsWritten = await writeSnapshotRows(client, rows)
  const reservationSnapshotsWritten = await writeReservationSnapshotRows(client, reservationSnapshot.rows)
  await writeReservationSnapshotRun(client, {
    snapshotDate,
    stockLevelCount: reservationSnapshot.stockLevelCount,
    reservationSnapshotCount: reservationSnapshotsWritten,
    source: 'cron',
    checkMethod: 'daily_current_state_v1',
    cutoffAt: startOfNextUtcDay(snapshotDate),
    reservationSourceCount: reservationSnapshot.reservationSourceCount,
  })

  return {
    snapshotDate: formatSnapshotDate(snapshotDate),
    snapshotsWritten,
    reservationSnapshotsWritten,
    reservationSnapshotStockLevelCount: reservationSnapshot.stockLevelCount,
    driftCount: drift.length,
    driftTruncated: drift.length > MAX_INVENTORY_SNAPSHOT_DRIFT_DETAILS,
    drift: drift.slice(0, MAX_INVENTORY_SNAPSHOT_DRIFT_DETAILS),
  }
}

function adjustState(
  state: SnapshotState,
  productId: string,
  warehouseId: string,
  qtyDelta: Decimal,
  valueDelta: Decimal,
): void {
  const key = stockKey(productId, warehouseId)
  const existing = state.get(key) ?? {
    productId,
    warehouseId,
    qty: toDecimal(0),
    valueBase: toDecimal(0),
  }
  existing.qty = roundQty(existing.qty.add(qtyDelta))
  existing.valueBase = roundValue(existing.valueBase.add(valueDelta))
  state.set(key, existing)
}

function reverseMovementIntoState(state: SnapshotState, movement: InventorySnapshotMovementRow): boolean {
  const qty = toDecimal(movement.qty).abs()
  const value = movement.totalValueBase == null ? null : toDecimal(movement.totalValueBase).abs()
  const hasValue = value !== null

  if (!movement.toWarehouseId && !movement.fromWarehouseId) {
    return qty.isZero()
  }

  if (movement.toWarehouseId) {
    adjustState(
      state,
      movement.productId,
      movement.toWarehouseId,
      qty.neg(),
      value?.neg() ?? toDecimal(0),
    )
  }

  if (movement.fromWarehouseId) {
    adjustState(
      state,
      movement.productId,
      movement.fromWarehouseId,
      qty,
      value ?? toDecimal(0),
    )
  }

  return hasValue
}

export async function backfillInventorySnapshots(options: {
  client?: SnapshotClient
  fromDate: SnapshotDateInput
  toDate?: SnapshotDateInput
  dryRun?: boolean
  includeReservationSnapshots?: boolean
}): Promise<InventorySnapshotBackfillResult> {
  const client: SnapshotClient = options.client ?? db as SnapshotClient
  const fromDate = parseSnapshotDate(options.fromDate)
  const toDate = parseSnapshotDate(options.toDate)
  if (fromDate > toDate) {
    throw new Error('Inventory snapshot backfill fromDate must be before or equal to toDate')
  }
  if (toDate > parseSnapshotDate(new Date())) {
    throw new Error('Inventory snapshot backfill toDate cannot be in the future')
  }

  const { state } = await loadAggregatedCurrentSnapshotState(client)

  let missingValueMovementCount = 0
  let snapshotsWritten = 0
  let daysWritten = 0
  let movementCursor: { id: string } | undefined
  let movementPage: InventorySnapshotMovementRow[] = []
  let movementPageIndex = 0
  let pendingMovement: InventorySnapshotMovementRow | null = null
  const reservationBackfill: InventoryReservationSnapshotBackfillResult = {
    ...EMPTY_RESERVATION_BACKFILL_RESULT,
    enabled: options.includeReservationSnapshots === true,
    reliability: options.includeReservationSnapshots === true ? 'reliable' : 'not_attempted',
    totalDaysInRange: options.includeReservationSnapshots === true
      ? calendarDayCount(fromDate, toDate)
      : 0,
    warnings: [],
    knownLimitations: options.includeReservationSnapshots === true
      ? [...RESERVATION_BACKFILL_LIMITATIONS]
      : [],
  }
  const reservationSupport = options.includeReservationSnapshots
    ? await loadReservationBackfillSupportSnapshot(client)
    : null
  let currentReservationSources: ReservationBreakdownRow[] | null = null

  async function getCurrentReservationSources(): Promise<ReservationBreakdownRow[]> {
    currentReservationSources ??= await loadReservationSourceRows(client as ReservationBreakdownClient)
    return currentReservationSources
  }

  async function nextMovement(): Promise<InventorySnapshotMovementRow | null> {
    if (pendingMovement) {
      const movement = pendingMovement
      pendingMovement = null
      return movement
    }

    if (movementPageIndex >= movementPage.length) {
      movementPage = await client.stockMovement.findMany({
        where: { createdAt: { gte: fromDate } },
        select: {
          id: true,
          type: true,
          productId: true,
          fromWarehouseId: true,
          toWarehouseId: true,
          qty: true,
          totalValueBase: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BACKFILL_MOVEMENT_PAGE_SIZE,
        ...(movementCursor ? { skip: 1, cursor: movementCursor } : {}),
      } as never) as InventorySnapshotMovementRow[]
      movementPageIndex = 0
      if (movementPage.length === 0) return null
      movementCursor = { id: movementPage[movementPage.length - 1]!.id }
    }

    return movementPage[movementPageIndex++] ?? null
  }

  async function reverseMovementsOnOrAfter(boundary: Date): Promise<void> {
    while (true) {
      const movement = await nextMovement()
      if (!movement) return
      if (movement.createdAt < boundary) {
        pendingMovement = movement
        return
      }
      if (!reverseMovementIntoState(state, movement)) {
        missingValueMovementCount += 1
      }
    }
  }

  await reverseMovementsOnOrAfter(startOfNextUtcDay(toDate))

  for (let day = toDate; day >= fromDate; day = addUtcDays(day, -1)) {
    const rows = rowsFromState(day, state)
    snapshotsWritten += options.dryRun ? rows.length : await writeSnapshotRows(client, rows)
    daysWritten += 1

    if (options.includeReservationSnapshots) {
      const cutoff = startOfNextUtcDay(day)
      const unsupportedWarnings = reservationSupport
        ? reservationBackfillUnsupportedWarnings(day, cutoff, reservationSupport)
        : []
      if (unsupportedWarnings.length > 0) {
        reservationBackfill.unsupportedDaysSkipped += 1
        reservationBackfill.reliability = 'warnings'
        reservationBackfill.warnings.push(...unsupportedWarnings)
      } else {
        const reservationSources = await getCurrentReservationSources()
        const reservationSnapshot = buildBackfilledReservationSnapshotRows({
          snapshotDate: day,
          inventoryRows: rows,
          reservationSources,
        })
        if (reservationSnapshot.negativeAvailableRowCount > 0) {
          reservationBackfill.reliability = 'warnings'
          reservationBackfill.warnings.push({
            snapshotDate: formatSnapshotDate(day),
            code: 'negative_available_qty',
            message: [
              `${reservationSnapshot.negativeAvailableRowCount} reservation snapshot row(s) have negative availableQty;`,
              'the value is stored as evidence because reservation quantity exceeds historical on-hand quantity.',
            ].join(' '),
          })
        }
        reservationBackfill.snapshotsWritten += options.dryRun
          ? reservationSnapshot.rows.length
          : await writeReservationSnapshotRows(client, reservationSnapshot.rows)
        if (!options.dryRun) {
          await writeReservationSnapshotRun(client, {
            snapshotDate: day,
            stockLevelCount: reservationSnapshot.inventorySnapshotRowCount,
            reservationSnapshotCount: reservationSnapshot.rows.length,
            source: 'backfill',
            checkMethod: RESERVATION_BACKFILL_CHECK_METHOD,
            cutoffAt: cutoff,
            reservationSourceCount: reservationSources.length,
          })
        }
        reservationBackfill.supportedDaysWritten += 1
        reservationBackfill.runMarkersWritten += options.dryRun ? 0 : 1
      }
    }

    await reverseMovementsOnOrAfter(day)
  }

  // scjz.48: backfilled values seed from CURRENT cost layers, so any revaluation
  // after a backfilled day no longer reflects the basis valid then. Backfilled
  // snapshots are end-of-day, so a revaluation DURING fromDate is already captured
  // in fromDate's snapshot — only revaluations from next-day midnight onward make
  // a backfilled date unreliable. Surface the count and downgrade reliability
  // rather than silently writing post-revaluation values onto historical dates.
  const postBackfillRevaluationCount = await client.costLayerRevaluation.count({
    where: { effectiveAt: { gte: startOfNextUtcDay(fromDate) } },
  })

  return {
    fromDate: formatSnapshotDate(fromDate),
    toDate: formatSnapshotDate(toDate),
    daysWritten,
    snapshotsWritten,
    missingValueMovementCount,
    postBackfillRevaluationCount,
    dryRun: options.dryRun === true,
    valueReplayReliable: missingValueMovementCount === 0 && postBackfillRevaluationCount === 0,
    reservationBackfill,
  }
}

export async function getAverageInventoryValueBase(options: {
  client?: Pick<SnapshotClient, 'inventorySnapshot'>
  fromDate: SnapshotDateInput
  toDate: SnapshotDateInput
}): Promise<string> {
  const client = options.client ?? db
  const fromDate = parseSnapshotDate(options.fromDate)
  const toDate = parseSnapshotDate(options.toDate)
  if (fromDate > toDate) {
    throw new Error('Average inventory fromDate must be before or equal to toDate')
  }

  const rows = await client.inventorySnapshot.findMany({
    where: {
      snapshotDate: {
        gte: fromDate,
        lte: toDate,
      },
    },
    select: {
      snapshotDate: true,
      valueBase: true,
    },
    orderBy: { snapshotDate: 'asc' },
  })

  const totalByDate = new Map<string, Decimal>()
  for (const row of rows) {
    const key = formatSnapshotDate(row.snapshotDate)
    totalByDate.set(key, (totalByDate.get(key) ?? toDecimal(0)).add(toDecimal(row.valueBase)))
  }

  if (totalByDate.size === 0) return '0.000000'

  const total = [...totalByDate.values()].reduce((sum, value) => sum.add(value), toDecimal(0))
  // Divide by the number of days that actually have snapshots, not every calendar
  // day in the range (cogs-audit scjz.47). Calendar-day division understated the
  // average when snapshots are missing for some days (cron gap / partial backfill)
  // — the numerator only covers observed days — which then inflated any turnover
  // ratio built on this denominator. Consistent with the turnover report, which
  // also divides by observed snapshot days.
  return roundValue(total.div(totalByDate.size)).toFixed(6)
}

export function inventorySnapshotCounts(result: InventorySnapshotWriteResult): Record<string, number> {
  return {
    snapshotsWritten: result.snapshotsWritten,
    reservationSnapshotsWritten: result.reservationSnapshotsWritten,
    reservationSnapshotStockLevelCount: result.reservationSnapshotStockLevelCount,
    driftCount: result.driftCount,
  }
}

export function inventorySnapshotStatusReason(result: InventorySnapshotWriteResult): string | null {
  if (result.driftCount === 0) return null
  return `inventory_snapshot_value_drift:${result.driftCount}`
}
