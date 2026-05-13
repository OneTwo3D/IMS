import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  buildOverheadAccountDeltas,
  recomputeManufacturingUnitCosts,
  stableHash,
} from '../lib/manufacturing-cost.ts'

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

test('proportional split rounds each layer independently to 6dp', () => {
  // Three layers with bases summing to £100, overhead £10.
  // Total layer value after = 110. Per-layer share is by base:
  //   L1: 33.333... base, gets 33.333.../100 × 10 = 3.333... overhead
  //         → 36.666.../3 ≈ 12.222222 per unit
  //   L2: 33.333... base, same → 12.222222 per unit
  //   L3: 33.333... base, same → 12.222222 per unit
  const result = recomputeManufacturingUnitCosts(
    [
      { id: 'L1', receivedQty: 3, base: 100 / 3 },
      { id: 'L2', receivedQty: 3, base: 100 / 3 },
      { id: 'L3', receivedQty: 3, base: 100 / 3 },
    ],
    10,
  )
  // Each layer should round to the same value at 6dp
  assert.equal(result.length, 3)
  for (const r of result) {
    assert.equal(r.newUnitCostBase, 12.222222)
  }
})

test('equal-share fallback: zero base across layers spreads overhead evenly', () => {
  // Mirrors the disassembly completion-time fallback when totalRecoveredCostBase=0.
  // Three components, each with 0 base + zero source cost. Overhead £30 →
  // each layer gets £10. With 5 units each → £2/unit.
  const result = recomputeManufacturingUnitCosts(
    [
      { id: 'A', receivedQty: 5, base: 0 },
      { id: 'B', receivedQty: 5, base: 0 },
      { id: 'C', receivedQty: 5, base: 0 },
    ],
    30,
  )
  for (const r of result) {
    assert.equal(r.newUnitCostBase, 2)
  }
})

test('mixed receivedQty per layer: proportional share is by base value not qty', () => {
  // L1: base £30 over 1 unit (£30/unit base)
  // L2: base £70 over 7 units (£10/unit base)
  // overhead £100, totalBase £100 → split 30/70
  //   L1 gets £30 overhead → (30 + 30) / 1 = £60
  //   L2 gets £70 overhead → (70 + 70) / 7 = £20
  const result = recomputeManufacturingUnitCosts(
    [
      { id: 'L1', receivedQty: 1, base: 30 },
      { id: 'L2', receivedQty: 7, base: 70 },
    ],
    100,
  )
  const byId = Object.fromEntries(result.map((r) => [r.layerId, r.newUnitCostBase]))
  assert.equal(byId['L1'], 60)
  assert.equal(byId['L2'], 20)
})

test('fractional manufacturing unit-cost helper matches Decimal arithmetic at the current 6dp boundary', () => {
  const layers = [
    { id: 'A', receivedQty: 0.3, base: 0.1 },
    { id: 'B', receivedQty: 0.6, base: 0.2 },
  ]
  const currentMfgCostBase = 0.1

  const result = Object.fromEntries(
    recomputeManufacturingUnitCosts(layers, currentMfgCostBase)
      .map((entry) => [entry.layerId, entry.newUnitCostBase]),
  )

  const totalBase = layers.reduce((sum, layer) => sum.add(layer.base), new Prisma.Decimal(0))
  const expected = Object.fromEntries(layers.map((layer) => {
    const share = new Prisma.Decimal(layer.base).div(totalBase)
    const overhead = new Prisma.Decimal(currentMfgCostBase).mul(share)
    const unitCost = new Prisma.Decimal(layer.base)
      .add(overhead)
      .div(layer.receivedQty)
      .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber()
    return [layer.id, unitCost]
  }))

  assert.deepEqual(result, expected)
})

test('manufacturing cost-layer revaluation still needs Decimal-safe returned quantities and delta totals', {
  todo: 'PR 4.5 Decimalizes recalculateManufacturingCostLayers returnedQty, unitDelta, consumedQty, COGS delta, and inventory delta.',
}, () => {
  assert.equal(typeof recomputeManufacturingUnitCosts, 'function')
})

test('overhead account deltas net same-account edits to zero', () => {
  const result = buildOverheadAccountDeltas(
    [{ amountBase: 100, accountCode: '5100' }],
    [{ amountBase: 100, accountCode: '5100' }],
    '',
  )
  assert.equal(result.missingAccount, false)
  assert.deepEqual([...result.deltas.entries()], [])
})

test('overhead account deltas move value between renamed accounts', () => {
  const result = buildOverheadAccountDeltas(
    [{ amountBase: 100, accountCode: '5100' }],
    [{ amountBase: 100, accountCode: '5200' }],
    '',
  )
  assert.equal(result.missingAccount, false)
  assert.deepEqual(Object.fromEntries(result.deltas), { '5100': -100, '5200': 100 })
})

test('overhead account deltas surface missing account on posted old lines', () => {
  const result = buildOverheadAccountDeltas(
    [{ amountBase: 100, accountCode: null }],
    [{ amountBase: 100, accountCode: '5200' }],
    '',
  )
  assert.equal(result.missingAccount, true)
  assert.deepEqual(Object.fromEntries(result.deltas), { '5200': 100 })
})

test('overhead account deltas drop sub-half-penny rounded changes', () => {
  const result = buildOverheadAccountDeltas(
    [{ amountBase: 100, accountCode: '5100' }],
    [{ amountBase: 100.004, accountCode: '5100' }],
    '',
  )
  assert.equal(result.missingAccount, false)
  assert.deepEqual([...result.deltas.entries()], [])
})

test('stableHash is key-sorted and uses full sha256 digest', () => {
  assert.equal(stableHash({ b: 1, a: 2 }), stableHash({ a: 2, b: 1 }))
  assert.equal(stableHash({ a: 2 }).length, 64)
})
