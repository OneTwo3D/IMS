import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dateOnly,
  defaultUtcDateWindow,
  elapsedDaysDecimal,
  endOfUtcDay,
  inclusiveUtcDayCount,
  parseDateOnly,
  parseOptionalDateOnly,
  startOfUtcDay,
  subtractUtcDays,
  utcCalendarDayDelta,
} from '@/lib/domain/math/date-window'

test('UTC date-window helpers use inclusive calendar-day semantics', () => {
  const from = new Date('2026-01-01T12:00:00.000Z')
  const to = new Date('2026-01-31T12:00:00.000Z')

  assert.equal(inclusiveUtcDayCount(from, to), 31)
  assert.equal(utcCalendarDayDelta(from, to), 30)
  assert.equal(elapsedDaysDecimal(startOfUtcDay(from), endOfUtcDay(from)).toFixed(6), '1.000000')
})

test('date-only parsing normalizes to UTC day boundaries', () => {
  const fallback = new Date('2026-02-03T12:00:00.000Z')

  assert.equal(parseDateOnly('2026-01-02', fallback).toISOString(), '2026-01-02T00:00:00.000Z')
  assert.equal(parseDateOnly('2026-01-02', fallback, { endOfDay: true }).toISOString(), '2026-01-02T23:59:59.999Z')
  assert.equal(parseDateOnly('bad', fallback).toISOString(), fallback.toISOString())
  assert.equal(parseOptionalDateOnly('2026-04-05')?.toISOString(), '2026-04-05T00:00:00.000Z')
  assert.equal(parseOptionalDateOnly('bad'), undefined)
})

test('default window and subtract helpers keep UTC dates stable', () => {
  const now = new Date('2026-06-15T18:30:00.000Z')
  const window = defaultUtcDateWindow(now, 30)

  assert.equal(dateOnly(window.dateFrom), '2026-05-17')
  assert.equal(dateOnly(window.dateTo), '2026-06-15')
  assert.equal(subtractUtcDays(new Date('2026-03-01T00:00:00.000Z'), 1).toISOString(), '2026-02-28T00:00:00.000Z')
})
