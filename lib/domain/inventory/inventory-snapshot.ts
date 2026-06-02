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
  dryRun: boolean
  valueReplayReliable: boolean
}

export type InventorySnapshotClient = Pick<
  PrismaClient,
  | 'stockLevel'
  | 'costLayer'
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
  stockLevel: {
    findMany(args: unknown): Promise<Array<InventorySnapshotStockLevelRow | InventoryReservationSnapshotStockLevelRow>>
    findUnique(args: unknown): Promise<{ reservedQty: DecimalInput } | null>
  }
  costLayer: {
    findMany(args: unknown): Promise<InventorySnapshotCostLayerRow[]>
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
  orderAllocation: ReservationBreakdownClient['orderAllocation']
  shipmentLine: ReservationBreakdownClient['shipmentLine']
  productionOrder: ReservationBreakdownClient['productionOrder']
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

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days))
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
  return roundQuantity(value, 4)
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

async function loadCurrentReservationSnapshotRows(
  client: SnapshotClient,
  snapshotDate: Date,
): Promise<{ rows: InventoryReservationSnapshotRowInput[]; stockLevelCount: number }> {
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
    },
    update: {
      stockLevelCount: row.stockLevelCount,
      reservationSnapshotCount: row.reservationSnapshotCount,
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

  async function nextMovement(): Promise<InventorySnapshotMovementRow | null> {
    if (pendingMovement) {
      const movement = pendingMovement
      pendingMovement = null
      return movement
    }

    if (movementPageIndex >= movementPage.length) {
      movementPage = await client.stockMovement.findMany({
        where: { createdAt: { gt: endOfUtcDay(addUtcDays(fromDate, -1)) } },
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

  async function reverseMovementsAfter(cutoff: Date): Promise<void> {
    while (true) {
      const movement = await nextMovement()
      if (!movement) return
      if (movement.createdAt <= cutoff) {
        pendingMovement = movement
        return
      }
      if (!reverseMovementIntoState(state, movement)) {
        missingValueMovementCount += 1
      }
    }
  }

  await reverseMovementsAfter(endOfUtcDay(toDate))

  for (let day = toDate; day >= fromDate; day = addUtcDays(day, -1)) {
    const rows = rowsFromState(day, state)
    snapshotsWritten += options.dryRun ? rows.length : await writeSnapshotRows(client, rows)
    daysWritten += 1
    await reverseMovementsAfter(endOfUtcDay(addUtcDays(day, -1)))
  }

  return {
    fromDate: formatSnapshotDate(fromDate),
    toDate: formatSnapshotDate(toDate),
    daysWritten,
    snapshotsWritten,
    missingValueMovementCount,
    dryRun: options.dryRun === true,
    valueReplayReliable: missingValueMovementCount === 0,
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
  return roundValue(total.div(calendarDayCount(fromDate, toDate))).toFixed(6)
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
