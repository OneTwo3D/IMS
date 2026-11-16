import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { UTC_DAY_MS, dateOnly, startOfUtcDay } from '@/lib/domain/math/date-window'
import {
  DEFAULT_DEMAND_WINDOW_DAYS,
  DEFAULT_TARGET_COVER_WEEKS,
  MAX_TARGET_COVER_WEEKS,
  getReorderReport,
  loadReorderChartSources,
  type ReplenishmentReportClient,
  type ReplenishmentReportDeps,
} from '@/lib/domain/inventory/replenishment-reports'
import { DEFAULT_PROJECTION_HORIZON_DAYS, projectStockPosition } from '@/lib/domain/inventory/reorder-timing'
import { calculateDailyVelocity } from '@/lib/domain/inventory/velocity'
import type { StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'

/**
 * Per-product demand chart behind the Reorder Planning drill-down (o3d-s8n.4). ASSEMBLY, NOT NEW MATH:
 * the planning figures come from the same `getReorderReport` row the user clicked (so the chart cannot
 * contradict it), the history from the same SALE_DISPATCH loader, the curve from `projectStockPosition`
 * and the arrivals from the same dated open-PO lines.
 *
 * Not in this version (blocked on the stockout-aware demand work, o3d-s8n.3): the historical stock-position
 * line and the stockout / uncovered week shading. The chart says so rather than drawing a guess.
 */

const MAX_FORECAST_WEEKS = 52
const MAX_HISTORY_WEEKS = 104
const MIN_FORECAST_WEEKS = 12

export type ReorderDemandChartWeek = {
  /** Monday of the week, YYYY-MM-DD (UTC). */
  weekStart: string
  /** `history` weeks (including the current one) carry actual sales; `forecast` weeks carry the projection. */
  kind: 'history' | 'forecast'
  /** The week containing today. Its sales so far are real; its stock figure is the projection to Sunday. */
  isCurrentWeek: boolean
  /** Units dispatched (SALE_DISPATCH). Null on forecast weeks. */
  actualDemandQty: number | null
  /** Flat-average demand x 7. Null on history weeks. */
  projectedDemandQty: number | null
  /** Projected available stock at the end of the week (Sunday). Null on past weeks and beyond the horizon. */
  stockPositionQty: number | null
  /** Dated open PO quantity expected that week. */
  inboundQty: number
  /** The suggested reorder quantity, plotted once at the required-receipt week. A series distinct from inboundQty. */
  requiredReceiptQty: number | null
  isFirstShortageWeek: boolean
}

export type ReorderDemandChart = {
  productId: string
  sku: string
  productName: string
  stockUnit: string
  warehouseId: string | null
  warehouseName: string | null
  generatedAt: string
  today: string
  weeks: ReorderDemandChartWeek[]
  historyWeeks: number
  forecastWeeks: number
  /** Window the history bars cover, YYYY-MM-DD. */
  historyFrom: string
  historyTo: string
  requiredReceiptDate: string | null
  latestPoDate: string | null
  latestPoOverdue: boolean
  firstShortageDate: string | null
  firstShortageWeekStart: string | null
  /** Week (Monday) containing the latest PO date, when that week is on the chart; else null. */
  latestPoWeekStart: string | null
  safetyStockQty: number
  reorderPoint: number
  suggestedReorderQty: number
  averageDailyDemand: number
  leadTimeDays: number
  openingQty: number
  /** False when there are no SALE_DISPATCH rows in the history window. */
  hasHistory: boolean
  notices: string[]
}

export type ReorderDemandChartFilters = Pick<
  StockPositionFilters,
  'warehouseId' | 'categoryId' | 'supplierId' | 'productType' | 'thresholdDays' | 'targetCoverWeeks'
>

type ChartClient = ReplenishmentReportClient & {
  warehouse?: { findUnique(args: unknown): Promise<{ name: string; code: string } | null> }
}

export type ReorderDemandChartDeps = {
  client?: ChartClient
  now?: () => Date
}

export type GetReorderDemandChartInput = {
  productId: string
  filters?: ReorderDemandChartFilters
  /** Overrides the default of ceil(thresholdDays / 7). */
  historyWeeks?: number
  /** Overrides the default of max(12, ceil((leadTimeDays + targetCoverWeeks x 7) / 7)). */
  forecastWeeks?: number
  deps?: ReorderDemandChartDeps
}

/** Monday (UTC) of the week containing `date`. */
export function isoWeekStart(date: Date): Date {
  const day = startOfUtcDay(date)
  const sinceMonday = (day.getUTCDay() + 6) % 7
  return new Date(day.getTime() - sinceMonday * UTC_DAY_MS)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * UTC_DAY_MS)
}

function positiveInt(value: number | undefined): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

function num(value: Prisma.Decimal | string): number {
  return Number(roundQuantity(toDecimal(value), 4).toString())
}

export async function getReorderDemandChart(input: GetReorderDemandChartInput): Promise<ReorderDemandChart | null> {
  const filters = input.filters ?? {}
  const now = input.deps?.now?.() ?? new Date()
  const reportDeps: ReplenishmentReportDeps = { client: input.deps?.client, now: () => now }

  const demandDays = positiveInt(filters.thresholdDays) ?? DEFAULT_DEMAND_WINDOW_DAYS
  const targetCoverWeeks = Math.min(MAX_TARGET_COVER_WEEKS, positiveInt(filters.targetCoverWeeks) ?? DEFAULT_TARGET_COVER_WEEKS)
  // Only the structural filters: abc / urgency / search would hide the very row the user clicked, and
  // includeZero keeps a zero-suggestion row reachable.
  const planFilters: StockPositionFilters = {
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    thresholdDays: demandDays,
    targetCoverWeeks,
    includeZero: true,
  }
  const report = await getReorderReport(planFilters, { paginate: false, deps: reportDeps })
  const row = report.rows.find((candidate) => candidate.productId === input.productId)
  if (!row) return null

  const historyWeeksOverride = positiveInt(input.historyWeeks)
  const historyDays = historyWeeksOverride ? Math.min(MAX_HISTORY_WEEKS, historyWeeksOverride) * 7 : demandDays
  const forecastWeeks = Math.min(
    MAX_FORECAST_WEEKS,
    positiveInt(input.forecastWeeks) ?? Math.max(MIN_FORECAST_WEEKS, Math.ceil((row.leadTimeDays + targetCoverWeeks * 7) / 7)),
  )

  const sources = await loadReorderChartSources(planFilters, input.productId, Math.max(historyDays, demandDays), { deps: reportDeps })
  const today = startOfUtcDay(now)
  const todayStr = dateOnly(today)
  const historyFrom = addDays(today, -(historyDays - 1))

  // Demand rate: the exact figure getReorderReport used (same window, same rows), not its 4dp string.
  const velocity = calculateDailyVelocity(sources.sales, {
    dateFrom: addDays(today, -(demandDays - 1)),
    dateTo: sources.window.dateTo,
  }).find((entry) => entry.productId === input.productId)
  const averageDailyDemand = toDecimal(velocity?.dailyQtyVelocity ?? 0)

  // History buckets: the Mondays covering the history window up to and including this week.
  const currentWeek = isoWeekStart(today)
  const firstHistoryWeek = isoWeekStart(historyFrom)
  const salesByWeek = new Map<string, Prisma.Decimal>()
  let historyRows = 0
  for (const sale of sources.sales) {
    const occurredAt = new Date(sale.occurredAt)
    if (occurredAt.getTime() < historyFrom.getTime() || occurredAt.getTime() >= sources.window.dateToExclusive.getTime()) continue
    historyRows += 1
    const key = dateOnly(isoWeekStart(occurredAt))
    salesByWeek.set(key, (salesByWeek.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(sale.qty)))
  }

  const lastForecastWeek = addDays(currentWeek, 7 * forecastWeeks)
  const lastDay = addDays(lastForecastWeek, 6)
  const horizonDays = Math.max(DEFAULT_PROJECTION_HORIZON_DAYS, Math.round((lastDay.getTime() - today.getTime()) / UTC_DAY_MS))
  const projection = projectStockPosition({
    asOf: now,
    openingQty: sources.availableQty,
    averageDailyDemand,
    safetyStockQty: row.safetyStockQty,
    leadTimeDays: row.leadTimeDays,
    inbound: sources.arrivals,
    horizonDays,
    includeDailyQty: true,
  })
  const qtyByDate = new Map(projection.dailyQty.map((day) => [day.date, day.qty]))

  const inboundByWeek = new Map<string, Prisma.Decimal>()
  let inboundBeyondChart = new Prisma.Decimal(0)
  for (const arrival of sources.arrivals) {
    if (arrival.date < todayStr) continue // late: not in the projection, reported in the notices
    const arrivalDate = new Date(`${arrival.date}T00:00:00.000Z`)
    if (arrivalDate.getTime() > lastDay.getTime()) {
      inboundBeyondChart = inboundBeyondChart.add(toDecimal(arrival.qty))
      continue
    }
    const key = dateOnly(isoWeekStart(arrivalDate))
    inboundByWeek.set(key, (inboundByWeek.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(arrival.qty)))
  }

  const requiredReceiptWeek = projection.requiredReceiptDate ? dateOnly(isoWeekStart(new Date(`${projection.requiredReceiptDate}T00:00:00.000Z`))) : null
  const firstShortageWeek = projection.firstShortageDate ? dateOnly(isoWeekStart(new Date(`${projection.firstShortageDate}T00:00:00.000Z`))) : null

  const latestPoWeek = projection.latestPoDate ? dateOnly(isoWeekStart(new Date(`${projection.latestPoDate}T00:00:00.000Z`))) : null
  const weeks: ReorderDemandChartWeek[] = []
  const projectedWeeklyDemand = num(averageDailyDemand.mul(7))
  for (let weekStart = firstHistoryWeek; weekStart.getTime() <= lastForecastWeek.getTime(); weekStart = addDays(weekStart, 7)) {
    const key = dateOnly(weekStart)
    const isCurrentWeek = weekStart.getTime() === currentWeek.getTime()
    const isHistory = weekStart.getTime() <= currentWeek.getTime()
    const endQty = weekStart.getTime() >= currentWeek.getTime() ? qtyByDate.get(dateOnly(addDays(weekStart, 6))) : undefined
    const inbound = inboundByWeek.get(key)
    weeks.push({
      weekStart: key,
      kind: isHistory ? 'history' : 'forecast',
      isCurrentWeek,
      actualDemandQty: isHistory ? num(salesByWeek.get(key) ?? new Prisma.Decimal(0)) : null,
      projectedDemandQty: isHistory ? null : projectedWeeklyDemand,
      stockPositionQty: endQty ? num(endQty) : null,
      inboundQty: inbound ? num(inbound) : 0,
      requiredReceiptQty: requiredReceiptWeek === key ? num(row.suggestedReorderQty) : null,
      isFirstShortageWeek: firstShortageWeek === key,
    })
  }

  const notices: string[] = [
    `History is SALE_DISPATCH units per week (Monday to Sunday, UTC) from ${dateOnly(historyFrom)} to ${todayStr}; the first and current weeks are partial. Returns are not netted.`,
    'Projected demand is a flat average (units sold in the demand window / window days), the same figure Reorder Planning uses. It has no trend or seasonality.',
    'Projected stock starts from current available quantity, subtracts the flat daily demand and adds each dated open PO on its expected delivery date. It matches the Required receipt and Latest PO date columns.',
    'The historical stock-position line and stockout / uncovered shading are not shown yet: they need the stockout-aware demand history.',
  ]
  if (projection.lateInboundQty.gt(0)) {
    notices.push(`${roundQuantity(projection.lateInboundQty, 0).toString()} units on open POs are past their expected delivery date (earliest ${projection.lateInboundEarliestDate}). They are not in the projection until received or re-dated.`)
  }
  if (sources.undatedInboundQty.gt(0)) {
    notices.push(`${roundQuantity(sources.undatedInboundQty, 0).toString()} units on open POs have no expected delivery date and are left out of the projection.`)
  }
  if (inboundBeyondChart.gt(0)) {
    notices.push(`${roundQuantity(inboundBeyondChart, 0).toString()} units arrive after the last forecast week shown.`)
  }
  if (projection.requiredReceiptDate == null) {
    notices.push(projection.basis === 'no_demand'
      ? 'No sales demand in the window, so there is no required receipt date or shortage.'
      : 'Projected stock does not fall to safety stock within the projection horizon.')
  }

  let warehouseName: string | null = null
  const warehouseId = filters.warehouseId ?? null
  const warehouseClient = input.deps?.client ?? (db as unknown as ChartClient)
  if (warehouseId && warehouseClient.warehouse) {
    const warehouse = await warehouseClient.warehouse.findUnique({ where: { id: warehouseId }, select: { name: true, code: true } })
    warehouseName = warehouse?.name?.trim() || warehouse?.code?.trim() || null
  }

  return {
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    stockUnit: row.stockUnit,
    warehouseId,
    warehouseName,
    generatedAt: now.toISOString(),
    today: todayStr,
    weeks,
    historyWeeks: weeks.filter((week) => week.kind === 'history').length,
    forecastWeeks,
    historyFrom: dateOnly(historyFrom),
    historyTo: todayStr,
    requiredReceiptDate: projection.requiredReceiptDate,
    latestPoDate: projection.latestPoDate,
    latestPoOverdue: projection.latestPoOverdue,
    firstShortageDate: projection.firstShortageDate,
    firstShortageWeekStart: firstShortageWeek,
    latestPoWeekStart: latestPoWeek && weeks.some((week) => week.weekStart === latestPoWeek) ? latestPoWeek : null,
    safetyStockQty: num(row.safetyStockQty),
    reorderPoint: num(row.reorderPoint),
    suggestedReorderQty: num(row.suggestedReorderQty),
    averageDailyDemand: num(averageDailyDemand),
    leadTimeDays: row.leadTimeDays,
    openingQty: num(sources.availableQty),
    hasHistory: historyRows > 0,
    notices,
  }
}
