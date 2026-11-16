import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  coverageValuesFromQty,
  coverageValuesFromWeeks,
  coverageWeeksForQty,
  hasCoverageDemand,
  qtyForCoverageWeeks,
  systemCoverageValues,
} from '@/lib/analytics/reorder-coverage'

test('weeks from quantity: qty / (7 x daily demand), one decimal, half up', () => {
  assert.equal(coverageWeeksForQty('70', '1'), '10.0')
  assert.equal(coverageWeeksForQty('100', '2'), '7.1') // 7.142857
  assert.equal(coverageWeeksForQty('0', '2'), '0.0')
  assert.equal(coverageWeeksForQty('1', '1'), '0.1') // 0.142857
  assert.equal(coverageWeeksForQty('21', '0.4286'), '7.0') // 6.9996
  // exact half rounds up: 0.35 weeks of 1/day is 2.45 units -> use qty 245 demand 100
  assert.equal(coverageWeeksForQty('245', '100'), '0.4') // 0.35 -> 0.4
})

test('quantity from weeks: ceil(weeks x 7 x daily demand), whole units', () => {
  assert.equal(qtyForCoverageWeeks('8', '1.5'), '84')
  assert.equal(qtyForCoverageWeeks('1', '0.1'), '1') // 0.7 -> 1
  assert.equal(qtyForCoverageWeeks('2.5', '3'), '53') // 52.5 -> 53
  assert.equal(qtyForCoverageWeeks('0', '3'), '0')
  assert.equal(qtyForCoverageWeeks('0.5', '2'), '7') // exact 7, no float drift up to 8
  assert.equal(qtyForCoverageWeeks('.5', '2'), '7')
})

test('exactness: no float drift on awkward decimals', () => {
  // 0.1 x 7 x 3 in floats is 2.1000000000000005 and would ceil to 3.
  assert.equal(qtyForCoverageWeeks('0.1', '3'), '3') // 2.1 -> 3 (true ceil)
  assert.equal(qtyForCoverageWeeks('0.3', '10'), '21') // exact 21; float 0.3*7*10 = 21.000000000000004
})

test('round trip: weeks -> qty -> weeks lands within rounding of the typed weeks', () => {
  for (const demand of ['0.25', '1', '3.3333', '17.5', '120']) {
    for (const weeks of ['1', '2.5', '4', '8', '12.3', '26']) {
      const qty = qtyForCoverageWeeks(weeks, demand)
      assert.ok(qty != null)
      const back = Number(coverageWeeksForQty(qty, demand))
      // ceil only ever rounds the quantity up, by < 1 unit = 1/(7 d) weeks, plus 0.05 display rounding.
      const tolerance = 1 / (7 * Number(demand)) + 0.05 + 1e-9
      assert.ok(back >= Number(weeks) - 0.05 - 1e-9 && back - Number(weeks) <= tolerance, `${demand}/${weeks}: ${back}`)
    }
  }
})

test('round trip: qty -> weeks -> qty is the identity when weeks are exact', () => {
  assert.equal(qtyForCoverageWeeks(coverageWeeksForQty('70', '1')!, '1'), '70')
  assert.equal(qtyForCoverageWeeks(coverageWeeksForQty('140', '4')!, '4'), '140')
})

test('demand 0 (or invalid): weeks null, weeks edit rejected', () => {
  assert.equal(coverageWeeksForQty('10', '0'), null)
  assert.equal(coverageWeeksForQty('10', '0.0000'), null)
  assert.equal(coverageWeeksForQty('10', ''), null)
  assert.equal(qtyForCoverageWeeks('4', '0'), null)
  assert.equal(coverageValuesFromWeeks('4', '0'), null)
  assert.equal(hasCoverageDemand('0'), false)
  assert.equal(hasCoverageDemand('0.0001'), true)
  assert.deepEqual(systemCoverageValues('12', '0'), { qty: '12', weeks: null })
  assert.deepEqual(coverageValuesFromQty('30', '0'), { qty: '30', weeks: null })
})

test('invalid text is rejected, never coerced', () => {
  for (const bad of ['', ' ', '-1', '1e3', 'abc', '1.2.3', '.', '1,5', 'Infinity', '9'.repeat(40)]) {
    assert.equal(qtyForCoverageWeeks(bad, '1'), null, bad)
    assert.equal(coverageWeeksForQty(bad, '1'), null, bad)
  }
  assert.equal(coverageValuesFromWeeks('', '1'), null)
  assert.equal(coverageValuesFromWeeks('2.', '1')?.qty, '14')
})

test('reset values are the system suggestion in both fields', () => {
  assert.deepEqual(systemCoverageValues('84', '1.5'), { qty: '84', weeks: '8.0' })
  assert.deepEqual(coverageValuesFromWeeks('8', '1.5'), { qty: '84', weeks: '8' })
  assert.deepEqual(coverageValuesFromQty('90', '1.5'), { qty: '90', weeks: '8.6' })
})
