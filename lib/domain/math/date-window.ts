import { Prisma } from '@/app/generated/prisma/client'

export const UTC_DAY_MS = 24 * 60 * 60 * 1000

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}

export function exclusiveEndOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
}

export function subtractUtcDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() - days)
  return next
}

function parseValidDateOnly(value: string): Date | null {
  const match = DATE_ONLY_RE.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
    ? parsed
    : null
}

export function parseDateOnly(value: string | undefined, fallback: Date, options: { endOfDay?: boolean } = {}): Date {
  if (!value) return fallback
  const parsed = parseValidDateOnly(value)
  if (!parsed) return fallback
  return options.endOfDay ? endOfUtcDay(parsed) : startOfUtcDay(parsed)
}

export function parseOptionalDateOnly(value: string | undefined, options: { endOfDay?: boolean } = {}): Date | undefined {
  if (!value) return undefined
  const parsed = parseValidDateOnly(value)
  if (!parsed) return undefined
  return options.endOfDay ? endOfUtcDay(parsed) : startOfUtcDay(parsed)
}

export function defaultUtcDateWindow(now: Date, days: number): { dateFrom: Date; dateTo: Date } {
  const dateTo = endOfUtcDay(now)
  const dateFrom = subtractUtcDays(startOfUtcDay(now), Math.max(1, days) - 1)
  return { dateFrom, dateTo }
}

export function utcDayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / UTC_DAY_MS)
}

export function utcCalendarDayDelta(start: Date, end: Date): number {
  return Math.max(0, utcDayNumber(end) - utcDayNumber(start))
}

export function inclusiveUtcDayCount(dateFrom: Date, dateTo: Date): number {
  return Math.max(1, utcDayNumber(dateTo) - utcDayNumber(dateFrom) + 1)
}

export function elapsedDaysDecimal(start: Date, end: Date): Prisma.Decimal {
  return new Prisma.Decimal(end.getTime() - start.getTime()).div(UTC_DAY_MS)
}
