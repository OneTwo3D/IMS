import { Prisma, type PrismaClient, type StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY } from '@/lib/db/advisory-locks'
import { businessDateYmd } from '@/lib/business-date'
import { loadInTransitTransferValues, type InTransitTransferValue } from '@/lib/domain/inventory/transfer-in-transit-value'
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
  valueReplayReliable: boolean
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

export type InventorySnapshotRunInput = {
  snapshotDate: Date
  stockLevelCount: number
  snapshotCount: number
  source: 'cron' | 'backfill'
  checkMethod: string
  cutoffAt: Date | null
  /** True when the run valued the stock in transit (inventory_transit_snapshots) for its date. */
  inTransitCovered?: boolean
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
  /** Transfers valued in transit for this date (the "in transit" line); null when the client could not measure it. */
  inTransitTransfersWritten?: number | null
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
  | 'inventorySnapshotRun'
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
    findMany(args: unknown): Promise<Array<{ effectiveAt: Date; costLayer: { productId: string; warehouseId: string } | null }>>
  }
  stockMovement: {
    findMany(args: unknown): Promise<InventorySnapshotMovementRow[]>
  }
  inventorySnapshot: {
    findMany(args: unknown): Promise<Array<{ snapshotDate: Date; valueBase: DecimalInput }>>
    upsert(args: unknown): Promise<unknown>
  }
  inventorySnapshotRun: {
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

const INVENTORY_SNAPSHOT_BACKFILL_CHECK_METHOD = 'aggregated_movement_replay_v1'
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

/**
 * The snapshot label for a cron run at `from`: the BUSINESS (Europe/London) day that has just ended. The cron fires at 00:00 host
 * time (London), which in BST is 23:00 UTC of the day before, so the UTC-based previousUtcDate labelled that run a day too early.
 *
 * ACCEPTED LIMIT (o3d-cr517): snapshot rows written BEFORE the label moved to the London day keep the label they were written under (in BST a run at
 * 00:00 London was labelled the day before its London day). They are NOT relabelled: a snapshot's label is part of its key, the rows are point-in-time
 * captures of current state taken at that run (their content cannot be re-derived for a different day), and rewriting a key could collide with the row
 * the new rule wrote for the same label. The affected rows are the BST ones from before the change; GMT days are unaffected (London day = UTC day).
 */
export function previousBusinessDate(from: Date = new Date()): Date {
  return addUtcDays(parseSnapshotDate(businessDateYmd(from)), -1)
}

/** The instant the business day labelled `snapshotDate` ends (London midnight of the next day: 23:00 UTC in BST, 00:00 UTC in GMT). */
export function startOfNextBusinessDay(snapshotDate: Date): Date {
  const nextYmd = formatSnapshotDate(addUtcDays(snapshotDate, 1))
  const utcMidnight = startOfNextUtcDay(snapshotDate)
  for (const offsetHours of [1, 0]) {
    const candidate = new Date(utcMidnight.getTime() - offsetHours * 3_600_000)
    if (businessDateYmd(candidate) === nextYmd && businessDateYmd(new Date(candidate.getTime() - 1)) !== nextYmd) return candidate
  }
  return utcMidnight
}

/**
 * The half-open instant window [gte, lt) covering the London business days labelled `fromLabel` through `toLabel` inclusive (both UTC-midnight label
 * dates). It is the movement window that reconciles with as-of valuation: opening valuation as-of D0 ends at startOfNextBusinessDay(D0), so the movements and
 * COGS of (D0, D1] are those in [startOfNextBusinessDay(D0), startOfNextBusinessDay(D1)); a report filtered from day F starts at startOfNextBusinessDay(F - 1).
 */
export function businessDayWindow(fromLabel: Date, toLabel: Date): { gte: Date; lt: Date } {
  return { gte: startOfNextBusinessDay(addUtcDays(fromLabel, -1)), lt: startOfNextBusinessDay(toLabel) }
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

function rowFromStateEntry(snapshotDate: Date, entry: SnapshotStateEntry, valueReplayReliable: boolean): InventorySnapshotRowInput {
  const qty = roundQty(entry.qty)
  const valueBase = roundValue(entry.valueBase)
  return {
    snapshotDate,
    productId: entry.productId,
    warehouseId: entry.warehouseId,
    qty,
    valueBase,
    unitCostBase: qty.gt(0) ? roundValue(valueBase.div(qty)) : null,
    valueReplayReliable,
  }
}

function rowsFromState(
  snapshotDate: Date,
  state: SnapshotState,
  isValueReplayReliable: (productId: string, warehouseId: string) => boolean,
): InventorySnapshotRowInput[] {
  return [...state.values()]
    .map((entry) => rowFromStateEntry(snapshotDate, entry, isValueReplayReliable(entry.productId, entry.warehouseId)))
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
    // Built from current state at capture time → point-in-time reliable.
    rows: rowsFromState(snapshotDate, state, () => true),
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
          order: { status: { not: 'CANCELLED' }, refundStatus: { not: 'FULL' } },
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
  fence?: SnapshotFence,
): Promise<number> {
  for (let index = 0; index < rows.length; index += SNAPSHOT_WRITE_BATCH_SIZE) {
    await fence?.('snapshot-batch')
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
          valueReplayReliable: row.valueReplayReliable,
        },
        update: {
          qty: row.qty,
          valueBase: row.valueBase,
          unitCostBase: row.unitCostBase,
          valueReplayReliable: row.valueReplayReliable,
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

/**
 * Persist the "in transit" line for `snapshotDate`: one row per transfer in transit at the capture instant. A re-run of the date
 * replaces the day's rows (a transfer that has since stopped being in transit as of that instant drops out). Returns the number
 * of rows, or null when the client cannot write them (an injected test double), so the run is not marked as covering transit.
 */
async function writeInTransitSnapshotRows(
  client: SnapshotClient,
  snapshotDate: Date,
  values: readonly InTransitTransferValue[] | null,
): Promise<number | null> {
  if (values === null) return null
  const transit = (client as unknown as {
    inventoryTransitSnapshot?: {
      deleteMany(args: unknown): Promise<unknown>
      createMany(args: unknown): Promise<unknown>
    }
  }).inventoryTransitSnapshot
  if (!transit) return null
  await transit.deleteMany({ where: { snapshotDate } })
  if (values.length > 0) {
    await transit.createMany({
      data: values.map((row) => ({
        snapshotDate,
        transferId: row.transferId,
        valueBase: row.valueBase.toFixed(6),
        valueReplayReliable: row.reliable,
      })),
    })
  }
  return values.length
}

async function writeInventorySnapshotRun(
  client: SnapshotClient,
  row: InventorySnapshotRunInput,
): Promise<void> {
  const updatedAt = new Date()
  await client.inventorySnapshotRun.upsert({
    where: { snapshotDate: row.snapshotDate },
    create: {
      snapshotDate: row.snapshotDate,
      stockLevelCount: row.stockLevelCount,
      snapshotCount: row.snapshotCount,
      source: row.source,
      checkMethod: row.checkMethod,
      cutoffAt: row.cutoffAt,
      ...(row.inTransitCovered ? { inTransitCovered: true } : {}),
    },
    update: {
      stockLevelCount: row.stockLevelCount,
      snapshotCount: row.snapshotCount,
      source: row.source,
      checkMethod: row.checkMethod,
      cutoffAt: row.cutoffAt,
      ...(row.inTransitCovered ? { inTransitCovered: true } : {}),
      updatedAt,
    },
  } as never)
}

/**
 * The lock is held by a transaction that does NOTHING but hold it, for at most this long (the lock then falls away and the writes are unaffected). The
 * snapshot's own writes go through the normal path with no transaction around them and no cap, so a long run never rolls back.
 */
const SNAPSHOT_LOCK_HOLD_MAX_MS = 4 * 60 * 60_000
/** The holder transaction pings its pinned connection this often, so a killed backend (a DBA cancel, a pooler, an idle-in-transaction timeout) is noticed within about this long. */
const SNAPSHOT_LOCK_HEARTBEAT_MS = 30_000
/** A writing backfill's default cap (it pauses warehouse-dated despatches while it runs; the CLI can change it). */
const BACKFILL_LOCK_HOLD_MAX_MS = 24 * 60 * 60_000

/**
 * The exclusive floor lock was lost (or the run outlasted its cap) while the run was under it: a despatch may have committed unfenced, so the day's rows
 * cannot be trusted to include it. Thrown by the fence checks and after the run, so the cron reads RED (never a green run that claims a lock it no longer held).
 */
export class InventorySnapshotLockLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventorySnapshotLockLostError'
  }
}

type SnapshotLockOptions = {
  /** Test seam: the cap, in ms. */
  lockHoldMaxMs?: number
  /** Test seam: the holder's heartbeat, in ms. */
  lockHeartbeatMs?: number
  /** Test seam: called at every fence point with its name, before the lock is checked. */
  onStage?: (stage: string) => Promise<void> | void
  /** Test seam: replaces the strict "is the despatch-date switch effective" read (a throw means the read failed). */
  effectiveReader?: () => Promise<boolean>
}

type SnapshotFence = (stage: string) => Promise<void>

/** Is the despatch-date switch effective? A failed read answers TRUE (fail closed): the callers then lock or refuse, never run unprotected on a guess. */
async function effectiveFailClosed(reader?: () => Promise<boolean>): Promise<boolean> {
  try {
    return await (reader ?? (await import('@/lib/domain/wms/despatch-flags')).isWmsDespatchDateEffectiveStrict)()
  } catch {
    return true
  }
}

async function recordLockActivity(level: 'INFO' | 'WARNING' | 'ERROR', action: string, description: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    const { logActivity } = await import('@/lib/activity-log')
    await logActivity({ entityType: 'SYSTEM', action, tag: 'sync', level, description, metadata, resolveUser: false })
  } catch (error) {
    console.warn(`[inventory-snapshot] could not record ${action}`, error)
  }
}

/**
 * Run `body` while a dedicated transaction holds the inventory snapshot floor lock EXCLUSIVELY. Callers use it only when the lock protects something (the
 * despatch-date switch is effective, or that could not be read: see writeDailyInventorySnapshot); with the switches off the daily snapshot does not come here.
 *
 * The holder can fail AFTER it took the lock (the cap firing, a killed backend, a dropped socket). That is detected (a flag set by the holder's own rejection,
 * a heartbeat on its connection, and the elapsed time against the cap), and then:
 *   - the `fence` handed to the body throws at every stage and between write batches, so the snapshot STOPS writing (the run row is written last, so a stopped run
 *     leaves no coverage marker: the day is simply not covered, never wrongly covered);
 *   - an ERROR activity row says the run was unfenced, and the run throws, so the cron outcome is RED;
 *   - a run past half of the cap writes a WARNING row while it is still going.
 */
async function runUnderSnapshotFloorLock<T>(label: string, options: SnapshotLockOptions & { announce?: boolean }, body: (fence: SnapshotFence) => Promise<T>): Promise<T> {
  const holdMaxMs = options.lockHoldMaxMs ?? SNAPSHOT_LOCK_HOLD_MAX_MS
  const heartbeatMs = options.lockHeartbeatMs ?? SNAPSHOT_LOCK_HEARTBEAT_MS
  const state: { released: boolean; lockHeld: boolean; lost: { error: unknown } | null } = { released: false, lockHeld: false, lost: null }
  let release!: () => void
  const mayRelease = new Promise<void>((resolve) => { release = () => { state.released = true; resolve() } })
  let acquired!: () => void
  let failedToAcquire!: (error: unknown) => void
  const lockTaken = new Promise<void>((resolve, reject) => { acquired = () => { state.lockHeld = true; resolve() }; failedToAcquire = reject })
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY})`
    acquired()
    while (!state.released) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const tick = new Promise<void>((resolve) => { timer = setTimeout(resolve, heartbeatMs) })
      await Promise.race([mayRelease, tick])
      clearTimeout(timer)
      // A killed backend or a dropped socket fails here, long before the run would otherwise find out at release.
      if (!state.released) await tx.$queryRaw`SELECT 1`
    }
  }, { timeout: holdMaxMs, maxWait: 60_000 }).catch((error) => {
    if (!state.lockHeld) failedToAcquire(error)
    else state.lost = { error }
  })
  await lockTaken
  const startedAt = Date.now()
  if (options.announce) {
    // A long writing job (the backfill) keeps every warehouse-dated despatch waiting while the switch is effective: say so, so a stall can be explained.
    if (await effectiveFailClosed(options.effectiveReader)) {
      await recordLockActivity('WARNING', 'inventory_snapshot_lock_long_job',
        `${label} holds the despatch floor lock until it finishes (at most ${Math.round(holdMaxMs / 3_600_000)} h). While it runs every warehouse-dated despatch is refused and retried on the next sweep pass, and the warehouse delta watermark does not advance.`,
        { capMs: holdMaxMs })
    }
  }
  const warnTimer = setTimeout(() => {
    console.warn(`[inventory-snapshot] ${label} has held the despatch floor lock for over half of its ${Math.round(holdMaxMs / 60_000)} min cap`)
    void recordLockActivity('WARNING', 'inventory_snapshot_slow',
      `${label} has been running under the despatch floor lock for over half of its ${Math.round(holdMaxMs / 60_000)} minute cap. Despatches wait for it; past the cap the lock is dropped and the run is marked unreliable.`,
      { elapsedMs: Date.now() - startedAt, capMs: holdMaxMs })
  }, Math.max(1, Math.floor(holdMaxMs / 2)))
  const lostMessage = (): string => `${label} no longer held the despatch floor lock (${state.lost ? 'the lock holder failed' : 'the run outlasted its cap'}), so a despatch may have committed unfenced and the rows it wrote may be missing it.`
  const fence: SnapshotFence = async (stage) => {
    await options.onStage?.(stage)
    if (state.lost || Date.now() - startedAt >= holdMaxMs) throw new InventorySnapshotLockLostError(`${lostMessage()} Stopped at ${stage}.`)
  }
  let result: T | undefined
  let failure: { error: unknown } | null = null
  try {
    result = await body(fence)
  } catch (error) {
    failure = { error }
  }
  clearTimeout(warnTimer)
  release()
  await holder
  const durationMs = Date.now() - startedAt
  const holderError = state.lost ? (state.lost.error instanceof Error ? state.lost.error.message : String(state.lost.error)) : null
  const unfenced = state.lost !== null || durationMs >= holdMaxMs
  if (unfenced) {
    console.error(`[inventory-snapshot] ${lostMessage()}`)
    await recordLockActivity('ERROR', 'inventory_snapshot_unfenced',
      `${lostMessage()} Replays anchored on this snapshot may be wrong; re-run the snapshot for the day.`,
      { durationMs, capMs: holdMaxMs, holderFailed: state.lost !== null, holderError })
  } else {
    console.info(`[inventory-snapshot] run took ${durationMs} ms (under the despatch floor lock)`)
    await recordLockActivity('INFO', 'inventory_snapshot_duration',
      `${label} took ${Math.round(durationMs / 1000)} s while holding the despatch floor lock (despatches wait for it).`, { durationMs })
  }
  if (failure) throw failure.error
  if (unfenced) throw new InventorySnapshotLockLostError(lostMessage())
  return result as T
}

/**
 * THE DAILY SNAPSHOT AND A BACKDATED WAREHOUSE DESPATCH EXCLUDE EACH OTHER.
 *
 * A warehouse despatch backdated into a business day is floored by the latest `inventory_snapshot_runs` row (lib/domain/sales/despatch-instant.ts) and holds the
 * inventory snapshot floor lock SHARED while it reads that floor and commits its movement. The snapshot holds the same lock EXCLUSIVE from before its state
 * read to after its run row is written, so a despatch is wholly before the snapshot's read (the snapshot waits for it) or reads the new floor. Without this a
 * 23:50 despatch committed between the state read and the run row was missing from the snapshot and dated inside its day.
 *
 * The lock is taken on EVERY real run, whatever the despatch switches say at that moment (see runUnderSnapshotFloorLock: a switch flipped mid-run, or one failed
 * settings read, would otherwise leave a run unfenced). With the switches off no despatch takes the shared side, so nothing waits.
 *
 * The lock is held by a dedicated transaction that only holds the lock; the snapshot itself runs on the normal client (same writes, same batching, no time cap).
 * A holder that fails after taking the lock stops the writes, writes an ERROR activity row and fails the cron (see runUnderSnapshotFloorLock). With an injected
 * client (tests) the caller owns everything, as before.
 */
export async function writeDailyInventorySnapshot(options: {
  client?: SnapshotClient
  snapshotDate?: SnapshotDateInput
  tolerance?: Decimal
} & SnapshotLockOptions = {}): Promise<InventorySnapshotWriteResult> {
  if (options.client) return writeDailyInventorySnapshotOn(options.client, options)
  // Decided at the start and FAILING CLOSED: a settings read that fails is "lock" (the other readers turn a failed read into "off").
  const lockNeeded = await effectiveFailClosed(options.effectiveReader)
  if (lockNeeded) return runUnderSnapshotFloorLock('Daily inventory snapshot', options, (fence) => writeDailyInventorySnapshotOn(db as SnapshotClient, options, fence))
  // The switch is off: IDENTICAL to the unlocked snapshot (no lock, no extra transaction, no heartbeat, no cap). The one addition is a read just before the run
  // row: if the switch became effective while this run was unlocked, a despatch may have been dated into the day after the state was read, so the run row is NOT
  // written (the day is uncovered, never wrongly covered), the cron goes red, and the next run takes the lock.
  const unlockedFence: SnapshotFence = async (stage) => {
    await options.onStage?.(stage)
    if (stage !== 'before-run-row') return
    if (!(await effectiveFailClosed(options.effectiveReader))) return
    const message = 'The despatch-date switch became effective while the daily inventory snapshot was running without the floor lock, so a despatch may have been dated into the day after its state was read. The run row was NOT written; the run is failed and the next run takes the lock.'
    await recordLockActivity('ERROR', 'inventory_snapshot_switch_flipped', message, { snapshotDate: String(options.snapshotDate ?? '') })
    throw new InventorySnapshotLockLostError(message)
  }
  return writeDailyInventorySnapshotOn(db as SnapshotClient, options, unlockedFence)
}

async function readStateAndInTransit(client: SnapshotClient): Promise<{
  state: SnapshotState
  costLayerQtyByKey: Map<string, Decimal>
  inTransit: InTransitTransferValue[] | null
}> {
  const readOn = async (reader: SnapshotClient) => {
    const current = await loadAggregatedCurrentSnapshotState(reader)
    return { ...current, inTransit: await loadInTransitTransferValues(reader, new Date()) }
  }
  const transactional = client as unknown as {
    $queryRaw?: unknown
    $transaction?: (fn: (tx: SnapshotClient) => Promise<unknown>, options?: unknown) => Promise<unknown>
  }
  if (typeof transactional.$queryRaw === 'function' && typeof transactional.$transaction === 'function') {
    return await transactional.$transaction((tx) => readOn(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 10 * 60_000,
    }) as Awaited<ReturnType<typeof readOn>>
  }
  return readOn(client)
}

async function writeDailyInventorySnapshotOn(client: SnapshotClient, options: {
  snapshotDate?: SnapshotDateInput
  tolerance?: Decimal
}, fence?: SnapshotFence): Promise<InventorySnapshotWriteResult> {
  const snapshotDate = parseSnapshotDate(options.snapshotDate)
  // The stock state is CURRENT state, so stock in transit is measured at the same instant (not at the day's end): a transfer received
  // between the day's end and this run is already in the destination's state and must not also be counted in transit. Both reads
  // run in ONE REPEATABLE READ transaction, so a receipt or dispatch committing between them is in both or in neither.
  await fence?.('before-state-read')
  const { state, costLayerQtyByKey, inTransit } = await readStateAndInTransit(client)
  const reservationSnapshot = await loadCurrentReservationSnapshotRows(client, snapshotDate)
  const drift = findDrift(state, costLayerQtyByKey, options.tolerance)
  // Captured from current state today → point-in-time reliable.
  const rows = rowsFromState(snapshotDate, state, () => true)

  await fence?.('before-snapshot-rows')
  const snapshotsWritten = await writeSnapshotRows(client, rows, fence)
  // In-transit rows are written before the run row (which carries inTransitCovered), behind the same fence: a stopped run leaves no marker.
  await fence?.('before-in-transit-rows')
  const inTransitTransfersWritten = await writeInTransitSnapshotRows(client, snapshotDate, inTransit)
  // Coverage marker so a future empty inventory_snapshots result for this date is
  // read as a genuine zero on-hand position rather than an uncovered date (scjz.60.5).
  await fence?.('before-run-row')
  await writeInventorySnapshotRun(client, {
    snapshotDate,
    stockLevelCount: reservationSnapshot.stockLevelCount,
    snapshotCount: snapshotsWritten,
    source: 'cron',
    checkMethod: 'daily_current_state_v1',
    cutoffAt: startOfNextBusinessDay(snapshotDate),
    inTransitCovered: inTransitTransfersWritten !== null,
  })
  await fence?.('before-reservation-rows')
  const reservationSnapshotsWritten = await writeReservationSnapshotRows(client, reservationSnapshot.rows)
  await writeReservationSnapshotRun(client, {
    snapshotDate,
    stockLevelCount: reservationSnapshot.stockLevelCount,
    reservationSnapshotCount: reservationSnapshotsWritten,
    source: 'cron',
    checkMethod: 'daily_current_state_v1',
    cutoffAt: startOfNextBusinessDay(snapshotDate),
    reservationSourceCount: reservationSnapshot.reservationSourceCount,
  })

  return {
    snapshotDate: formatSnapshotDate(snapshotDate),
    snapshotsWritten,
    ...(inTransitTransfersWritten !== null ? { inTransitTransfersWritten } : {}),
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

type BackfillOptions = {
  client?: SnapshotClient
  fromDate: SnapshotDateInput
  toDate?: SnapshotDateInput
  dryRun?: boolean
  includeReservationSnapshots?: boolean
}

/**
 * A backfill that WRITES (real client, not a dry run) reads the current state and walks the movements back from it, so a despatch committing mid-run would
 * leave every backfilled day inconsistent with it. It takes the same exclusive floor lock as the daily snapshot (a lost lock stops it and fails it, see
 * runUnderSnapshotFloorLock). A dry run, or an injected client (tests), takes nothing.
 */
export async function backfillInventorySnapshots(options: BackfillOptions & SnapshotLockOptions): Promise<InventorySnapshotBackfillResult> {
  if (options.client || options.dryRun) return backfillInventorySnapshotsOn(options)
  // A long range legitimately runs for hours: its cap is its own (24 h by default, `--lock-cap-hours` on the CLI), not the daily run's 4 h.
  return runUnderSnapshotFloorLock('Inventory snapshot backfill', { ...options, lockHoldMaxMs: options.lockHoldMaxMs ?? BACKFILL_LOCK_HOLD_MAX_MS, announce: true }, (fence) => backfillInventorySnapshotsOn(options, fence))
}

async function backfillInventorySnapshotsOn(options: BackfillOptions, fence?: SnapshotFence): Promise<InventorySnapshotBackfillResult> {
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
  // (product, warehouse) keys whose value had a null-totalValueBase movement
  // reversed into it during the walk — unreliable from that day backward (scjz.43/.48).
  const nullValueAffectedPairs = new Set<string>()
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
        where: { createdAt: { gte: startOfNextBusinessDay(addUtcDays(fromDate, -1)) } },
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
        // The (product, warehouse) value just had a null-totalValueBase movement
        // baked in; flag only those pairs so unrelated SKUs stay reliable (scjz.43/.48).
        for (const warehouseId of [movement.fromWarehouseId, movement.toWarehouseId]) {
          if (warehouseId) nullValueAffectedPairs.add(stockKey(movement.productId, warehouseId))
        }
      }
    }
  }

  await reverseMovementsOnOrAfter(startOfNextBusinessDay(toDate))

  // scjz.43/.48: backfilled values seed from CURRENT cost layers. A snapshot for
  // pair (p,w) on day D is point-in-time accurate only if no cost layer for that
  // pair was revalued after D. Build the latest revaluation per pair so each row
  // is flagged precisely (an unrelated SKU's row stays reliable).
  const latestRevalByPair = new Map<string, Date>()
  // Only revaluations on/after next-day-midnight(fromDate) can make any row in
  // [fromDate, toDate] stale (an earlier one is already reflected for every day
  // in range), so bound the scan instead of loading the whole log.
  const revaluationRows = await client.costLayerRevaluation.findMany({
    where: { effectiveAt: { gte: startOfNextBusinessDay(fromDate) } },
    select: { effectiveAt: true, costLayer: { select: { productId: true, warehouseId: true } } },
  }) as Array<{ effectiveAt: Date; costLayer: { productId: string; warehouseId: string } | null }>
  for (const row of revaluationRows) {
    if (!row.costLayer) continue
    const key = stockKey(row.costLayer.productId, row.costLayer.warehouseId)
    const prev = latestRevalByPair.get(key)
    if (!prev || row.effectiveAt > prev) latestRevalByPair.set(key, row.effectiveAt)
  }
  const pairValueReplayReliable = (day: Date) => (productId: string, warehouseId: string): boolean => {
    const key = stockKey(productId, warehouseId)
    // A reversed null-value movement is baked into this and every earlier day.
    if (nullValueAffectedPairs.has(key)) return false
    const latest = latestRevalByPair.get(key)
    return latest == null || startOfNextBusinessDay(day) > latest
  }

  for (let day = toDate; day >= fromDate; day = addUtcDays(day, -1)) {
    await fence?.('backfill-day')
    const rows = rowsFromState(day, state, pairValueReplayReliable(day))
    snapshotsWritten += options.dryRun ? rows.length : await writeSnapshotRows(client, rows, fence)
    daysWritten += 1
    // Stock in transit at the end of THIS business day, from the movement ledger (exact for any past instant, no replay needed).
    await fence?.('backfill-in-transit')
    const inTransitAtDayEnd = options.dryRun ? null : await loadInTransitTransferValues(client, startOfNextBusinessDay(day))
    const inTransitWritten = options.dryRun ? null : await writeInTransitSnapshotRows(client, day, inTransitAtDayEnd)

    // Coverage marker per backfilled day so empty inventory_snapshots for a genuinely
    // zero-stock historical date reconciles instead of reading as uncovered (scjz.60.5).
    if (!options.dryRun) {
      await writeInventorySnapshotRun(client, {
        snapshotDate: day,
        stockLevelCount: rows.length,
        snapshotCount: rows.length,
        source: 'backfill',
        checkMethod: INVENTORY_SNAPSHOT_BACKFILL_CHECK_METHOD,
        cutoffAt: startOfNextBusinessDay(day),
        inTransitCovered: inTransitWritten !== null,
      })
    }

    if (options.includeReservationSnapshots) {
      const cutoff = startOfNextBusinessDay(day)
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

    // Walk the state back to the end of the previous day for the NEXT row. After the last (earliest) row nothing reads the state again, and the
    // pass would only count null-value movements of fromDate's own day that no written row depends on, marking the whole result unreliable.
    if (day > fromDate) await reverseMovementsOnOrAfter(startOfNextBusinessDay(addUtcDays(day, -1)))
  }

  // scjz.48: backfilled values seed from CURRENT cost layers, so any revaluation
  // after a backfilled day no longer reflects the basis valid then. Backfilled
  // snapshots are end-of-day, so a revaluation DURING fromDate is already captured
  // in fromDate's snapshot — only revaluations from next-day midnight onward make
  // a backfilled date unreliable. Surface the count and downgrade reliability
  // rather than silently writing post-revaluation values onto historical dates.
  const postBackfillRevaluationCount = await client.costLayerRevaluation.count({
    where: { effectiveAt: { gte: startOfNextBusinessDay(fromDate) } },
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
