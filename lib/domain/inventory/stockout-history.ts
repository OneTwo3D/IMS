import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { UTC_DAY_MS } from '@/lib/domain/math/date-window'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { assertSourceLimit } from '@/lib/security/source-scan-error'

/**
 * Stockout history from the daily InventorySnapshot / InventorySnapshotRun tables. No replay of
 * StockMovement and no new table.
 *
 * THREE STATES per day, never two:
 *   - a snapshot RUN exists for the day and the on-hand quantity is <= 0 (or has no row: the run's
 *     documented contract is that an absent row is a genuine zero)  ->  stockout
 *   - a run exists and the on-hand quantity is > 0                   ->  in stock
 *   - NO run exists for the day                                      ->  UNKNOWN (uncovered)
 * An unknown day is not "in stock" and is not a stockout: it is a day nobody counted. Every consumer
 * keeps it as its own value (`covered: false`) so a tenant whose snapshots started three weeks ago does
 * not report "no stockouts" over a twelve-week window.
 *
 * Snapshot day D is the end-of-day position of D (the cron runs after midnight and snapshots the
 * previous UTC day), so a product sold out at 10:00 and restocked at 16:00 shows as in stock. The whole
 * demand model is daily and this is accepted.
 *
 * Stockout means ON-HAND quantity <= 0 (physically nothing to ship), not available-after-reservations.
 * Across warehouses (no warehouse filter) the on-hand quantities are summed: a product is stocked out
 * only when it is zero (or below) everywhere.
 */

export const STOCKOUT_SOURCE_ROW_LIMIT = 50000
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export type StockoutDay = {
  /** YYYY-MM-DD (UTC). */
  date: string
  /** A snapshot run exists for this day. False means UNKNOWN. */
  covered: boolean
  /** Covered and on-hand <= 0. Always false when not covered. */
  stockout: boolean
  /** On-hand quantity (summed over the scoped warehouses). Null when not covered. */
  qty: number | null
}

export type StockoutHistory = {
  days: StockoutDay[]
  /** Earliest covered day inside the requested range, or null when none is covered. */
  firstCoveredDate: string | null
  coveredDayCount: number
  uncoveredDayCount: number
  stockoutDayCount: number
}

export type StockoutDayCount = { stockoutDays: number; coveredDays: number }

export type SnapshotCoverage = {
  /** Earliest snapshot run on record (not limited to the window), or null when the cron has never run. */
  firstCoveredDate: string | null
  /** Days in the window that have a run. */
  coveredDays: number
  windowDays: number
}

export type SnapshotRowInput = { date: string; warehouseId?: string; qty: DecimalInput }

function assertDateOnly(value: string, label: string): void {
  if (!DATE_ONLY_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be a YYYY-MM-DD date; got ${value}`)
  }
}

/** Every YYYY-MM-DD from `dateFrom` to `dateTo` inclusive. */
export function enumerateDates(dateFrom: string, dateTo: string): string[] {
  assertDateOnly(dateFrom, 'dateFrom')
  assertDateOnly(dateTo, 'dateTo')
  const start = Date.parse(`${dateFrom}T00:00:00.000Z`)
  const end = Date.parse(`${dateTo}T00:00:00.000Z`)
  if (end < start) throw new Error('dateTo must be on or after dateFrom')
  const dates: string[] = []
  for (let time = start; time <= end; time += UTC_DAY_MS) dates.push(new Date(time).toISOString().slice(0, 10))
  return dates
}

/**
 * PURE. Walks the day range against the run calendar and the snapshot rows.
 * `rows` must already be scoped to the product (and warehouse, when one is chosen); several rows for one
 * date (one per warehouse) are summed.
 */
export function buildStockoutDays(input: {
  dateFrom: string
  dateTo: string
  /** Dates (YYYY-MM-DD) that have an InventorySnapshotRun. */
  runDates: Iterable<string>
  rows: Iterable<SnapshotRowInput>
}): StockoutHistory {
  const runs = new Set(input.runDates)
  const qtyByDate = new Map<string, Prisma.Decimal>()
  for (const row of input.rows) {
    qtyByDate.set(row.date, (qtyByDate.get(row.date) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }

  const days: StockoutDay[] = []
  let firstCoveredDate: string | null = null
  let coveredDayCount = 0
  let stockoutDayCount = 0
  for (const date of enumerateDates(input.dateFrom, input.dateTo)) {
    if (!runs.has(date)) {
      days.push({ date, covered: false, stockout: false, qty: null })
      continue
    }
    // Covered: an absent row is a genuine zero (the run's contract).
    const qty = qtyByDate.get(date) ?? new Prisma.Decimal(0)
    const stockout = qty.lte(0)
    firstCoveredDate ??= date
    coveredDayCount += 1
    if (stockout) stockoutDayCount += 1
    days.push({ date, covered: true, stockout, qty: Number(roundQuantity(qty, 4).toString()) })
  }
  return {
    days,
    firstCoveredDate,
    coveredDayCount,
    uncoveredDayCount: days.length - coveredDayCount,
    stockoutDayCount,
  }
}

type DateRow = { snapshotDate: Date }
type SnapshotRow = { snapshotDate: Date; warehouseId: string; qty: DecimalInput }

export type StockoutHistoryClient = {
  inventorySnapshotRun: {
    findMany(args: unknown): Promise<DateRow[]>
    aggregate(args: unknown): Promise<{ _min: { snapshotDate: Date | null } }>
  }
  inventorySnapshot: { findMany(args: unknown): Promise<SnapshotRow[]> }
}

export type StockoutCountsClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10)
const dbDate = (value: string) => new Date(`${value}T00:00:00.000Z`)

/**
 * Single-product drill-down for the demand chart: two indexed queries (the runs in the range, then this
 * product's snapshot rows), a few dozen rows at most.
 */
export async function getStockoutHistory(input: {
  productId: string
  warehouseId?: string
  dateFrom: string
  dateTo: string
  client?: StockoutHistoryClient
}): Promise<StockoutHistory> {
  assertDateOnly(input.dateFrom, 'dateFrom')
  assertDateOnly(input.dateTo, 'dateTo')
  const client = input.client ?? (db as unknown as StockoutHistoryClient)
  const range = { gte: dbDate(input.dateFrom), lte: dbDate(input.dateTo) }
  const [runs, rows] = await Promise.all([
    client.inventorySnapshotRun.findMany({ where: { snapshotDate: range }, select: { snapshotDate: true } }),
    client.inventorySnapshot.findMany({
      where: {
        productId: input.productId,
        snapshotDate: range,
        ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      },
      select: { snapshotDate: true, warehouseId: true, qty: true },
      take: STOCKOUT_SOURCE_ROW_LIMIT + 1,
    }),
  ])
  assertSourceLimit(rows.length, STOCKOUT_SOURCE_ROW_LIMIT, 'Stockout history snapshot rows')
  return buildStockoutDays({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    runDates: runs.map((run) => isoDate(run.snapshotDate)),
    rows: rows.map((row) => ({ date: isoDate(row.snapshotDate), warehouseId: row.warehouseId, qty: row.qty })),
  })
}

type CountRow = { productId: string; stockoutDays: number | bigint; coveredDays: number | bigint }

/**
 * Batch form for the report: ONE raw SQL aggregate, one row per product (never products x days back to
 * the app). Covered days are the runs in the range; each product's day quantity is the sum of its
 * snapshot rows (all warehouses, or the chosen one) with an absent row counting as zero.
 * A product with no covered day in the range is returned with coveredDays 0 (and stockoutDays 0).
 */
export async function getStockoutDayCounts(input: {
  productIds: string[]
  warehouseId?: string
  dateFrom: string
  dateTo: string
  client?: StockoutCountsClient
}): Promise<Map<string, StockoutDayCount>> {
  assertDateOnly(input.dateFrom, 'dateFrom')
  assertDateOnly(input.dateTo, 'dateTo')
  const productIds = [...new Set(input.productIds)]
  assertSourceLimit(productIds.length, STOCKOUT_SOURCE_ROW_LIMIT, 'Stockout day-count product ids')
  const counts = new Map<string, StockoutDayCount>(productIds.map((id) => [id, { stockoutDays: 0, coveredDays: 0 }]))
  if (productIds.length === 0) return counts

  const client = input.client ?? (db as unknown as StockoutCountsClient)
  const warehouseClause = input.warehouseId ? Prisma.sql`AND s."warehouseId" = ${input.warehouseId}` : Prisma.empty
  const rows = await client.$queryRaw<CountRow[]>(Prisma.sql`
    WITH covered AS (
      SELECT r."snapshotDate" AS day
      FROM inventory_snapshot_runs r
      WHERE r."snapshotDate" BETWEEN ${input.dateFrom}::date AND ${input.dateTo}::date
    ),
    daily AS (
      SELECT p.id AS "productId", c.day, COALESCE(SUM(s.qty), 0) AS qty
      FROM unnest(${productIds}::text[]) AS p(id)
      CROSS JOIN covered c
      LEFT JOIN inventory_snapshots s
        ON s."productId" = p.id
        AND s."snapshotDate" = c.day
        ${warehouseClause}
      GROUP BY p.id, c.day
    )
    SELECT
      "productId",
      (COUNT(*) FILTER (WHERE qty <= 0))::int AS "stockoutDays",
      COUNT(*)::int AS "coveredDays"
    FROM daily
    GROUP BY "productId"
  `)
  for (const row of rows) {
    counts.set(row.productId, { stockoutDays: Number(row.stockoutDays), coveredDays: Number(row.coveredDays) })
  }
  return counts
}

/** How much of the window the snapshot cron actually covers, and since when. Two tiny queries. */
export async function getSnapshotCoverage(input: {
  dateFrom: string
  dateTo: string
  client?: Pick<StockoutHistoryClient, 'inventorySnapshotRun'>
}): Promise<SnapshotCoverage> {
  assertDateOnly(input.dateFrom, 'dateFrom')
  assertDateOnly(input.dateTo, 'dateTo')
  const client = input.client ?? (db as unknown as Pick<StockoutHistoryClient, 'inventorySnapshotRun'>)
  const [runs, earliest] = await Promise.all([
    client.inventorySnapshotRun.findMany({
      where: { snapshotDate: { gte: dbDate(input.dateFrom), lte: dbDate(input.dateTo) } },
      select: { snapshotDate: true },
    }),
    client.inventorySnapshotRun.aggregate({ _min: { snapshotDate: true } }),
  ])
  return {
    firstCoveredDate: earliest._min.snapshotDate ? isoDate(earliest._min.snapshotDate) : null,
    coveredDays: new Set(runs.map((run) => isoDate(run.snapshotDate))).size,
    windowDays: enumerateDates(input.dateFrom, input.dateTo).length,
  }
}
