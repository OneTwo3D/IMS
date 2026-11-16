import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { UTC_DAY_MS, dateOnly, parseOptionalDateOnly, startOfUtcDay, subtractUtcDays } from '@/lib/domain/math/date-window'

/**
 * Pure, DB-free stock-position projection behind the Reorder Planning "Latest PO date" and
 * "Required receipt" columns.
 *
 * DEFINITION: `requiredReceiptDate` is the first day projected available stock falls to SAFETY
 * STOCK (not to zero). The reorder engine already computes
 * `reorderPoint = averageDailyDemand x leadTimeDays + safetyStockQty`; rearranged, when available
 * equals the reorder point the days until safety stock is exactly `leadTimeDays`, so
 * `latestPoDate` is today. The date columns are therefore a date-domain restatement of the
 * reorder-point column and cannot contradict it. With a safety stock of 0 the definition
 * degrades to the zero crossing.
 *
 * Model: day 0 is `asOf` (UTC day) holding `openingQty`. Each later day consumes
 * `averageDailyDemand`. An inbound arrival dated D is added to the stock of day D (it is on the
 * shelf for that day's check), including arrivals dated today (day 0): the day-0 stock is opening
 * plus day-0 arrivals, and the "already below safety stock" test uses that same figure.
 * Arrivals dated BEFORE `asOf` are LATE: still unreceived, so no date is known for them. They are
 * excluded from the projection (assured stock only) and reported as `lateInboundQty` /
 * `lateInboundEarliestDate` so the caller can show them separately. Arrivals beyond the horizon
 * are ignored. Callers must pass only DATED arrivals: an unknown
 * arrival date cannot rescue a shortage date.
 */

export const DEFAULT_PROJECTION_HORIZON_DAYS = 365

export type InboundArrival = {
  /** Expected delivery day, YYYY-MM-DD. */
  date: string
  /** Open quantity arriving that day. */
  qty: DecimalInput
}

export type StockProjectionInput = {
  asOf: Date
  /** Available quantity at asOf (warehouse-scoped when the report is). Inbound is NOT included. */
  openingQty: DecimalInput
  averageDailyDemand: DecimalInput
  safetyStockQty: DecimalInput
  leadTimeDays: number
  inbound: InboundArrival[]
  /** Last projected day offset (inclusive). Default 365. */
  horizonDays?: number
  /**
   * Build the full per-day curve (for the demand chart). The row loop leaves this off: the dates
   * are derived analytically, so a report of thousands of rows does not iterate 365 days each.
   */
  includeDailyQty?: boolean
}

export type StockProjectionBasis = 'projected' | 'no_demand' | 'already_below' | 'beyond_horizon'

export type StockProjectionDay = {
  date: string
  qty: Prisma.Decimal
  inboundQty: Prisma.Decimal
}

export type StockProjection = {
  /** Empty unless `includeDailyQty` was set. */
  dailyQty: StockProjectionDay[]
  requiredReceiptDate: string | null
  latestPoDate: string | null
  /** First day projected available is at or below zero. */
  firstShortageDate: string | null
  /** latestPoDate is before asOf: the PO should already have been placed. */
  latestPoOverdue: boolean
  /** Unreceived quantity whose expected delivery is before asOf. NOT in the projection above. */
  lateInboundQty: Prisma.Decimal
  /** Earliest of those past due dates (YYYY-MM-DD), or null when nothing is late. */
  lateInboundEarliestDate: string | null
  basis: StockProjectionBasis
}

const ZERO = new Prisma.Decimal(0)

type Arrivals = { offsets: Map<number, Prisma.Decimal>; lateQty: Prisma.Decimal; lateEarliest: string | null }

function arrivalOffsets(input: StockProjectionInput, asOfDay: Date, horizon: number): Arrivals {
  const offsets = new Map<number, Prisma.Decimal>()
  let lateQty = ZERO
  let lateEarliest: string | null = null
  for (const arrival of input.inbound) {
    const qty = toDecimal(arrival.qty)
    if (qty.lte(0)) continue
    const parsed = parseOptionalDateOnly(arrival.date)
    if (!parsed) throw new RangeError(`Invalid inbound arrival date: ${arrival.date}`)
    const offset = Math.round((parsed.getTime() - asOfDay.getTime()) / UTC_DAY_MS)
    if (offset < 0) {
      lateQty = lateQty.add(qty)
      if (lateEarliest == null || arrival.date < lateEarliest) lateEarliest = arrival.date
      continue
    }
    if (offset > horizon) continue
    offsets.set(offset, (offsets.get(offset) ?? ZERO).add(qty))
  }
  return { offsets, lateQty, lateEarliest }
}

/**
 * First day offset in [0, horizon] where `opening - demand*k + arrivals(<=k)` is at or below
 * `threshold`, or null. Exact piecewise-linear solve between arrival days.
 */
function firstDayAtOrBelow(
  threshold: Prisma.Decimal,
  opening: Prisma.Decimal,
  demand: Prisma.Decimal,
  arrivals: Map<number, Prisma.Decimal>,
  horizon: number,
): number | null {
  const starts = [...new Set([0, ...arrivals.keys()])].sort((a, b) => a - b)
  let cumulative = ZERO
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    cumulative = cumulative.add(arrivals.get(start) ?? ZERO)
    const endInclusive = i + 1 < starts.length ? starts[i + 1] - 1 : horizon
    // Round the quotient before ceil so a representable-but-inexact division (e.g. 14 x 1/3 / (1/3))
    // cannot tip an exact whole day over to the next one.
    const needed = opening.add(cumulative).sub(threshold).div(demand).toDecimalPlaces(9).ceil().toNumber()
    const day = Math.max(start, needed)
    if (day <= endInclusive) return day
  }
  return null
}

export function projectStockPosition(input: StockProjectionInput): StockProjection {
  const horizon = input.horizonDays ?? DEFAULT_PROJECTION_HORIZON_DAYS
  if (!Number.isInteger(horizon) || horizon < 0) throw new RangeError(`horizonDays must be a non-negative integer: ${horizon}`)
  if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0) {
    throw new RangeError(`leadTimeDays must be a non-negative integer: ${input.leadTimeDays}`)
  }
  const asOfDay = startOfUtcDay(input.asOf)
  const opening = toDecimal(input.openingQty)
  const demand = toDecimal(input.averageDailyDemand)
  const safety = toDecimal(input.safetyStockQty)
  const { offsets: arrivals, lateQty, lateEarliest } = arrivalOffsets(input, asOfDay, horizon)
  const late = { lateInboundQty: lateQty, lateInboundEarliestDate: lateEarliest }
  const dayDate = (offset: number): string => dateOnly(new Date(asOfDay.getTime() + offset * UTC_DAY_MS))

  const dailyQty: StockProjectionDay[] = []
  if (input.includeDailyQty) {
    let cumulative = ZERO
    for (let k = 0; k <= horizon; k += 1) {
      const inboundQty = arrivals.get(k) ?? ZERO
      cumulative = cumulative.add(inboundQty)
      dailyQty.push({ date: dayDate(k), qty: opening.sub(demand.mul(k)).add(cumulative), inboundQty })
    }
  }

  if (demand.lte(0)) {
    return { dailyQty, requiredReceiptDate: null, latestPoDate: null, firstShortageDate: null, latestPoOverdue: false, basis: 'no_demand', ...late }
  }

  const shortageOffset = firstDayAtOrBelow(ZERO, opening, demand, arrivals, horizon)
  const firstShortageDate = shortageOffset == null ? null : dayDate(shortageOffset)
  // Day-0 stock is opening plus arrivals dated today: the same curve the date solver uses.
  const alreadyBelow = opening.add(arrivals.get(0) ?? ZERO).lte(safety)
  const requiredOffset = alreadyBelow ? 0 : firstDayAtOrBelow(safety, opening, demand, arrivals, horizon)

  if (requiredOffset == null) {
    return { dailyQty, requiredReceiptDate: null, latestPoDate: null, firstShortageDate, latestPoOverdue: false, basis: 'beyond_horizon', ...late }
  }
  const requiredDate = new Date(asOfDay.getTime() + requiredOffset * UTC_DAY_MS)
  const latestPo = subtractUtcDays(requiredDate, input.leadTimeDays)
  return {
    dailyQty,
    requiredReceiptDate: dateOnly(requiredDate),
    latestPoDate: dateOnly(latestPo),
    firstShortageDate,
    latestPoOverdue: latestPo.getTime() < asOfDay.getTime(),
    basis: alreadyBelow ? 'already_below' : 'projected',
    ...late,
  }
}
