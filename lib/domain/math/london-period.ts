import { businessDateYmd } from '@/lib/business-date'
import { businessDayWindow } from '@/lib/domain/inventory/inventory-snapshot'
import { parseOptionalDateOnly, subtractUtcDays } from '@/lib/domain/math/date-window'

/**
 * A report period measured in LONDON business days (the days Xero documents, VAT tax points and the stock ledger use).
 *
 * `dateFrom` / `dateToExclusive` are the half-open instant window [gte, lt) to put in a `createdAt` filter; `dateTo` is the last instant inside it.
 * `fromLabel` / `toLabel` are the inclusive UTC-midnight DAY LABELS the operator typed (or the London-today default); use them for display, never for a filter.
 */
export type LondonPeriod = {
  dateFrom: Date
  dateTo: Date
  dateToExclusive: Date
  fromLabel: Date
  toLabel: Date
}

/**
 * Resolve `dateFrom` / `dateTo` (YYYY-MM-DD, inclusive London days; unreadable or missing values fall back to the default) into a London-day window via the shared
 * `businessDayWindow`. The default is the last `defaultDays` London days ending on London today. A from after the to collapses to the to day.
 */
export function londonPeriod(filters: { dateFrom?: string; dateTo?: string }, now: Date, defaultDays: number): LondonPeriod {
  const today = parseOptionalDateOnly(businessDateYmd(now)) as Date
  const toLabel = parseOptionalDateOnly(filters.dateTo) ?? today
  const requestedFrom = parseOptionalDateOnly(filters.dateFrom) ?? subtractUtcDays(today, Math.max(1, defaultDays) - 1)
  const fromLabel = requestedFrom.getTime() <= toLabel.getTime() ? requestedFrom : toLabel
  const { gte, lt } = businessDayWindow(fromLabel, toLabel)
  return { dateFrom: gte, dateTo: new Date(lt.getTime() - 1), dateToExclusive: lt, fromLabel, toLabel }
}
