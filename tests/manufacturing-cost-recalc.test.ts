import assert from 'node:assert/strict'
import test from 'node:test'
import { recomputeManufacturingUnitCosts } from '../lib/manufacturing-cost.ts'

test('assembly: full overhead spread across single output layer', () => {
  // Assembled 10 units of finished good; component cost was £100 (£10/unit).
  // Add £20 of labour / machine overhead → unit cost should rise to £12.
  const result = recomputeManufacturingUnitCosts(
    [{ id: 'L1', receivedQty: 10, base: 100 }],
    20,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].layerId, 'L1')
  assert.equal(result[0].newUnitCostBase, 12)
})

test('assembly: zero overhead leaves unit cost equal to base', () => {
  const result = recomputeManufacturingUnitCosts(
    [{ id: 'L1', receivedQty: 4, base: 80 }],
    0,
  )
  assert.equal(result[0].newUnitCostBase, 20)
})

test('disassembly: overhead distributes proportionally to component value share', () => {
  // Disassembled stock recovered at total component value £100, split:
  //   Component A: £80 over 4 units (= £20/unit base)
  //   Component B: £20 over 2 units (= £10/unit base)
  // Add £30 manufacturing overhead. A should take 80% (£24), B 20% (£6).
  //   A new unit cost = (80 + 24) / 4 = £26
  //   B new unit cost = (20 + 6) / 2 = £13
  const result = recomputeManufacturingUnitCosts(
    [
      { id: 'A', receivedQty: 4, base: 80 },
      { id: 'B', receivedQty: 2, base: 20 },
    ],
    30,
  )
  const byId = Object.fromEntries(result.map((r) => [r.layerId, r.newUnitCostBase]))
  assert.equal(byId['A'], 26)
  assert.equal(byId['B'], 13)
})

test('zero base across all layers falls back to equal share', () => {
  // Edge case: assembled stock with zero cost layer (legacy / opening
  // stock at 0 cost). Two recovered components with zero base; £40 of
  // overhead should split £20/£20 → £10/unit (each has 2 units).
  const result = recomputeManufacturingUnitCosts(
    [
      { id: 'A', receivedQty: 2, base: 0 },
      { id: 'B', receivedQty: 2, base: 0 },
    ],
    40,
  )
  const byId = Object.fromEntries(result.map((r) => [r.layerId, r.newUnitCostBase]))
  assert.equal(byId['A'], 10)
  assert.equal(byId['B'], 10)
})

test('zero receivedQty on a layer yields zero unit cost (no divide-by-zero)', () => {
  const result = recomputeManufacturingUnitCosts(
    [{ id: 'L1', receivedQty: 0, base: 0 }],
    50,
  )
  assert.equal(result[0].newUnitCostBase, 0)
})

test('rounding: unit cost rounded to 6 decimal places', () => {
  // base = 100/3 (≈33.333...), overhead = 0, receivedQty = 10
  // → unit cost = 100/3/10 ≈ 3.3333333... rounded to 6dp = 3.333333
  const result = recomputeManufacturingUnitCosts(
    [{ id: 'L1', receivedQty: 10, base: 100 / 3 }],
    0,
  )
  assert.equal(result[0].newUnitCostBase, 3.333333)
})

test('empty layer list returns empty result', () => {
  assert.deepEqual(recomputeManufacturingUnitCosts([], 100), [])
})
