import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectStockPosition, type StockProjectionInput } from '@/lib/domain/inventory/reorder-timing'

const ASOF = new Date('2026-06-10T15:30:00.000Z')

function project(over: Partial<StockProjectionInput> = {}) {
  return projectStockPosition({
    asOf: ASOF,
    openingQty: 100,
    averageDailyDemand: 10,
    safetyStockQty: 20,
    leadTimeDays: 5,
    inbound: [],
    ...over,
  })
}

test('no demand: dates are null with basis no_demand, never a date', () => {
  const result = project({ averageDailyDemand: 0 })
  assert.equal(result.basis, 'no_demand')
  assert.equal(result.requiredReceiptDate, null)
  assert.equal(result.latestPoDate, null)
  assert.equal(result.firstShortageDate, null)
  assert.equal(result.latestPoOverdue, false)
})

test('no demand even when stock is below safety stock', () => {
  assert.equal(project({ averageDailyDemand: 0, openingQty: 0 }).basis, 'no_demand')
})

test('required receipt is the day stock falls to SAFETY STOCK, not zero', () => {
  // 100 - 10k <= 20 first at k = 8; zero would be day 10.
  const result = project()
  assert.equal(result.basis, 'projected')
  assert.equal(result.requiredReceiptDate, '2026-06-18')
  assert.equal(result.latestPoDate, '2026-06-13')
  assert.equal(result.firstShortageDate, '2026-06-20')
  assert.equal(result.latestPoOverdue, false)
})

test('safety stock 0 degrades to the zero crossing', () => {
  const result = project({ safetyStockQty: 0 })
  assert.equal(result.requiredReceiptDate, '2026-06-20')
  assert.equal(result.requiredReceiptDate, result.firstShortageDate)
  assert.equal(result.latestPoDate, '2026-06-15')
})

test('fractional days round up to the first day at or below safety stock', () => {
  // (100-20)/30 = 2.67 -> day 3
  assert.equal(project({ averageDailyDemand: 30 }).requiredReceiptDate, '2026-06-13')
})

test('PO landing before the shortage pushes the date out', () => {
  // 150 arriving on day 4 (before day 8): 100 - 10k + 150 <= 20 first at k = 23.
  const result = project({ inbound: [{ date: '2026-06-14', qty: 150 }] })
  assert.equal(result.requiredReceiptDate, '2026-07-03')
  assert.equal(result.latestPoDate, '2026-06-28')
  assert.equal(result.basis, 'projected')
})

test('PO landing after the shortage does not move the date', () => {
  // Required receipt day 8; PO lands day 12.
  const result = project({ inbound: [{ date: '2026-06-22', qty: 500 }] })
  assert.equal(result.requiredReceiptDate, '2026-06-18')
  assert.equal(result.latestPoDate, '2026-06-13')
})

test('PO landing on the shortage day itself counts (on the shelf for that day)', () => {
  // Day 8 stock would be 20; +10 arriving day 8 keeps it above 20, so the crossing moves to day 9.
  assert.equal(project({ inbound: [{ date: '2026-06-18', qty: 10 }] }).requiredReceiptDate, '2026-06-19')
})

test('same-day arrivals sum and arrival order does not matter', () => {
  const split = project({ inbound: [{ date: '2026-06-14', qty: 100 }, { date: '2026-06-14', qty: 50 }] })
  const merged = project({ inbound: [{ date: '2026-06-14', qty: 150 }] })
  assert.equal(split.requiredReceiptDate, merged.requiredReceiptDate)
  const reversed = project({ inbound: [{ date: '2026-06-20', qty: 5 }, { date: '2026-06-12', qty: 5 }] })
  const ordered = project({ inbound: [{ date: '2026-06-12', qty: 5 }, { date: '2026-06-20', qty: 5 }] })
  assert.equal(reversed.requiredReceiptDate, ordered.requiredReceiptDate)
})

test('an inbound that is too small to rescue only delays the crossing by its size', () => {
  // +25 on day 2 -> 100 - 10k + 25 <= 20 first at k = 11 (105 - 100 -> 10.5 -> 11).
  assert.equal(project({ inbound: [{ date: '2026-06-12', qty: 25 }] }).requiredReceiptDate, '2026-06-21')
})

test('zero, negative and fully-received arrivals are ignored', () => {
  const base = project()
  const result = project({ inbound: [{ date: '2026-06-12', qty: 0 }, { date: '2026-06-12', qty: -5 }] })
  assert.equal(result.requiredReceiptDate, base.requiredReceiptDate)
})

test('already overdue: stock at or below safety stock requires receipt today and the PO date is in the past', () => {
  const result = project({ openingQty: 15 })
  assert.equal(result.basis, 'already_below')
  assert.equal(result.requiredReceiptDate, '2026-06-10')
  assert.equal(result.latestPoDate, '2026-06-05')
  assert.equal(result.latestPoOverdue, true)
  assert.equal(result.firstShortageDate, '2026-06-12')
})

test('opening exactly at safety stock is already below', () => {
  const result = project({ openingQty: 20 })
  assert.equal(result.basis, 'already_below')
  assert.equal(result.latestPoOverdue, true)
})

test('already below with zero lead time is not overdue', () => {
  const result = project({ openingQty: 0, leadTimeDays: 0 })
  assert.equal(result.basis, 'already_below')
  assert.equal(result.latestPoDate, '2026-06-10')
  assert.equal(result.latestPoOverdue, false)
  assert.equal(result.firstShortageDate, '2026-06-10')
})

test('negative opening stock keeps the row visible as already below', () => {
  const result = project({ openingQty: -5 })
  assert.equal(result.basis, 'already_below')
  assert.equal(result.firstShortageDate, '2026-06-10')
})

test('an inbound due today does not turn an already-below row into a projection (opening stock decides)', () => {
  const result = project({ openingQty: 15, inbound: [{ date: '2026-06-10', qty: 500 }] })
  assert.equal(result.basis, 'already_below')
})

test('a late (past-dated) PO is clamped to today for the shortage date', () => {
  const late = project({ inbound: [{ date: '2026-05-01', qty: 150 }] })
  const today = project({ inbound: [{ date: '2026-06-10', qty: 150 }] })
  assert.equal(late.requiredReceiptDate, today.requiredReceiptDate)
  assert.equal(late.requiredReceiptDate, '2026-07-03')
})

test('lead time 0: latestPoDate equals requiredReceiptDate and is not overdue', () => {
  const result = project({ leadTimeDays: 0 })
  assert.equal(result.latestPoDate, result.requiredReceiptDate)
  assert.equal(result.latestPoOverdue, false)
})

test('latest PO date equal to today is not overdue; the day before is', () => {
  // required day 8, lead 8 -> latest PO today
  assert.equal(project({ leadTimeDays: 8 }).latestPoOverdue, false)
  assert.equal(project({ leadTimeDays: 8 }).latestPoDate, '2026-06-10')
  assert.equal(project({ leadTimeDays: 9 }).latestPoOverdue, true)
})

test('CONSISTENCY INVARIANT: available == demand x leadTime + safetyStock gives latestPoDate == today', () => {
  for (const [demand, lead, safety] of [[10, 5, 20], ['0.3333', 14, 7], [3, 30, 0], ['2.5', 7, 12]] as const) {
    const reorderPoint = Number(demand) * lead + safety
    const result = project({ openingQty: reorderPoint, averageDailyDemand: demand, leadTimeDays: lead, safetyStockQty: safety })
    assert.equal(result.latestPoDate, '2026-06-10', `demand ${demand} lead ${lead} safety ${safety}`)
    assert.equal(result.latestPoOverdue, false)
  }
})

test('CONSISTENCY INVARIANT holds with a non-terminating daily demand', () => {
  // demand 10/30 = 0.3333... x lead 15 = 5 exactly in rationals; the rounded quotient must not tip to day 16.
  const demand = '0.33333333333333333333'
  const result = project({ openingQty: '5', averageDailyDemand: demand, leadTimeDays: 15, safetyStockQty: 0 })
  assert.equal(result.requiredReceiptDate, '2026-06-25')
})

test('whole-day rounding around the reorder point (RP = 70): a day of demand below it is overdue', () => {
  assert.equal(project({ openingQty: 71 }).latestPoDate, '2026-06-11') // above RP: PO can wait a day
  assert.equal(project({ openingQty: 69 }).latestPoDate, '2026-06-10') // under by less than a day of demand: today
  assert.equal(project({ openingQty: 69 }).latestPoOverdue, false)
  assert.equal(project({ openingQty: 60 }).latestPoOverdue, true) // a full day of demand under: overdue by a day
  assert.equal(project({ openingQty: 61 }).latestPoOverdue, false)
  assert.equal(project({ openingQty: 59 }).latestPoDate, '2026-06-09')
  assert.equal(project({ openingQty: 59 }).latestPoOverdue, true)
})

test('horizon edge: crossing on the last projected day is found, one day later is beyond_horizon', () => {
  // safety 0, demand 1: stock 365 hits 0 on day 365; stock 366 on day 366.
  const onEdge = project({ openingQty: 365, averageDailyDemand: 1, safetyStockQty: 0, leadTimeDays: 0 })
  assert.equal(onEdge.basis, 'projected')
  assert.equal(onEdge.requiredReceiptDate, '2027-06-10')
  const past = project({ openingQty: 366, averageDailyDemand: 1, safetyStockQty: 0, leadTimeDays: 0 })
  assert.equal(past.basis, 'beyond_horizon')
  assert.equal(past.requiredReceiptDate, null)
  assert.equal(past.latestPoDate, null)
  assert.equal(past.firstShortageDate, null)
  assert.equal(past.latestPoOverdue, false)
})

test('horizon is configurable and an arrival beyond it is ignored', () => {
  const result = project({ horizonDays: 5, inbound: [{ date: '2026-06-30', qty: 1000 }] })
  assert.equal(result.basis, 'beyond_horizon')
  const shortHorizon = project({ horizonDays: 8 })
  assert.equal(shortHorizon.requiredReceiptDate, '2026-06-18')
})

test('a PO that rescues past the horizon yields beyond_horizon', () => {
  const result = project({ inbound: [{ date: '2026-06-12', qty: 100000 }] })
  assert.equal(result.basis, 'beyond_horizon')
})

test('safety stock crossing can be reached while shortage is beyond the horizon', () => {
  const result = project({ openingQty: 30, averageDailyDemand: 1, safetyStockQty: 25 })
  assert.equal(result.requiredReceiptDate, '2026-06-15')
  assert.equal(result.firstShortageDate, '2026-07-10')
})

test('dailyQty curve steps inbound in on its day and matches the analytic dates', () => {
  const input: StockProjectionInput = {
    asOf: ASOF, openingQty: 100, averageDailyDemand: 10, safetyStockQty: 20, leadTimeDays: 5,
    inbound: [{ date: '2026-06-14', qty: 150 }, { date: '2026-06-30', qty: 40 }], includeDailyQty: true,
  }
  const result = projectStockPosition(input)
  assert.equal(result.dailyQty.length, 366)
  assert.deepEqual(result.dailyQty.slice(0, 5).map((d) => d.qty.toString()), ['100', '90', '80', '70', '210'])
  assert.equal(result.dailyQty[4].inboundQty.toString(), '150')
  assert.equal(result.dailyQty[0].date, '2026-06-10')
  const firstAtSafety = result.dailyQty.find((d) => d.qty.lte(20))
  assert.equal(firstAtSafety?.date, result.requiredReceiptDate)
  const firstAtZero = result.dailyQty.find((d) => d.qty.lte(0))
  assert.equal(firstAtZero?.date, result.firstShortageDate)
})

test('the analytic crossing equals the day-by-day crossing across a grid', () => {
  for (const demand of ['0.5', '1', '3.7', '12']) {
    for (const opening of [-3, 0, 10, 55, 400]) {
      for (const inbound of [[], [{ date: '2026-06-20', qty: 90 }], [{ date: '2026-06-12', qty: 30 }, { date: '2026-09-01', qty: 200 }]]) {
        const base: StockProjectionInput = { asOf: ASOF, openingQty: opening, averageDailyDemand: demand, safetyStockQty: 20, leadTimeDays: 3, inbound }
        const fast = projectStockPosition(base)
        const slow = projectStockPosition({ ...base, includeDailyQty: true })
        assert.equal(fast.requiredReceiptDate, slow.requiredReceiptDate, JSON.stringify([demand, opening, inbound]))
        assert.equal(fast.firstShortageDate, slow.firstShortageDate, JSON.stringify([demand, opening, inbound]))
        if (opening > 20) {
          const day = slow.dailyQty.find((d) => d.qty.lte(20))
          assert.equal(slow.requiredReceiptDate, day?.date ?? null)
        }
      }
    }
  }
})

test('rejects invalid inputs instead of guessing', () => {
  assert.throws(() => project({ inbound: [{ date: 'soon', qty: 5 }] }), RangeError)
  assert.throws(() => project({ leadTimeDays: -1 }), RangeError)
  assert.throws(() => project({ leadTimeDays: 1.5 }), RangeError)
  assert.throws(() => project({ horizonDays: -1 }), RangeError)
})

test('asOf time of day is ignored (UTC day)', () => {
  assert.equal(project({ asOf: new Date('2026-06-10T23:59:59.000Z') }).requiredReceiptDate, '2026-06-18')
  assert.equal(project({ asOf: new Date('2026-06-10T00:00:00.000Z') }).requiredReceiptDate, '2026-06-18')
})
