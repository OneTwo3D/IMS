import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { allocateLandedCost, headerDiscountFactorForPo } from '@/lib/domain/purchasing/landed-cost-allocation'

/**
 * An order-level (header) discount must reach the cost layer's unit cost. 10 x 100 with a 10% header
 * discount: subtotal 900, bill 900. A layer valued at the undiscounted 100 is worth 1,000 and 100 is
 * stranded in Stock in Transit (and COGS is overstated by 10 a unit).
 */
const D = (v: string | number) => new Prisma.Decimal(v)

test('factor is subtotal over the sum of line totals', () => {
  const f = headerDiscountFactorForPo({ subtotalBase: '900', lines: [{ totalBase: '1000' }] })
  assert.equal(f.toString(), '0.9')
  const two = headerDiscountFactorForPo({ subtotalBase: '450', lines: [{ totalBase: '500' }, { totalBase: '500' }] })
  assert.equal(two.toString(), '0.45')
})

test('factor is exactly 1 with no discount, with rounding noise, and for degenerate inputs', () => {
  assert.ok(headerDiscountFactorForPo({ subtotalBase: '1000', lines: [{ totalBase: '1000' }] }).eq(1))
  assert.ok(headerDiscountFactorForPo({ subtotalBase: '999.99996', lines: [{ totalBase: '1000' }] }).eq(1))
  assert.ok(headerDiscountFactorForPo({ subtotalBase: '1200', lines: [{ totalBase: '1000' }] }).eq(1))
  assert.ok(headerDiscountFactorForPo({ subtotalBase: '900', lines: [] }).eq(1))
  assert.ok(headerDiscountFactorForPo({ subtotalBase: null, lines: [{ totalBase: '1000' }] }).eq(1))
  assert.ok(headerDiscountFactorForPo({ subtotalBase: '0', lines: [{ totalBase: '0' }] }).eq(1))
})

test('the layer unit cost is the discounted cost: 10 x 100 less 10% lays 90 a unit, so layers equal the bill', () => {
  const lines = [{ id: 'l1', qty: 10, unitCostBase: D(100), totalBase: D(1000), headerDiscountFactor: D('0.9') }]
  const a = allocateLandedCost(lines, [])
  assert.equal(a.grossUnitCostBaseByLine.get('l1')!.toString(), '90')
  assert.equal(a.grossUnitCostBaseByLine.get('l1')!.mul(10).toString(), '900')
})

test('freight is added on top of the discounted goods cost, and an absent factor changes nothing', () => {
  const discounted = allocateLandedCost(
    [{ id: 'l1', qty: 10, unitCostBase: D(100), totalBase: D(1000), headerDiscountFactor: D('0.9') }],
    [{ amountBase: D(50), distributionMethod: 'BY_VALUE', sourceRank: 0 }],
  )
  assert.equal(discounted.grossUnitCostBaseByLine.get('l1')!.toString(), '95')
  const plain = allocateLandedCost(
    [{ id: 'l1', qty: 10, unitCostBase: D(100), totalBase: D(1000) }],
    [{ amountBase: D(50), distributionMethod: 'BY_VALUE', sourceRank: 0 }],
  )
  assert.equal(plain.grossUnitCostBaseByLine.get('l1')!.toString(), '105')
})

test('a zero-qty line carries the discounted goods cost too', () => {
  const a = allocateLandedCost([{ id: 'l1', qty: 0, unitCostBase: D(100), totalBase: D(0), headerDiscountFactor: D('0.9') }], [])
  assert.equal(a.grossUnitCostBaseByLine.get('l1')!.toString(), '90')
})

test('every writer of a layer cost and both revaluation paths pass the header discount factor', () => {
  const files: Array<[string, number]> = [
    ['app/actions/purchase-orders.ts', 2],
    ['lib/domain/wms/booked-in-service.ts', 1],
    ['lib/connectors/mintsoft/sync/stock-sync.ts', 1],
    ['lib/domain/purchasing/landed-cost-service.ts', 2],
  ]
  for (const [file, minCalls] of files) {
    const src = readFileSync(file, 'utf8')
    const calls = src.match(/headerDiscountFactorForPo\(/g) ?? []
    assert.ok(calls.length >= minCalls, `${file} must call headerDiscountFactorForPo at least ${minCalls} time(s)`)
    assert.ok(src.includes('headerDiscountFactor'), `${file} must hand the factor to the allocation`)
  }
})

test('every landed-cost shipment revaluation funds the change from transit', () => {
  const src = readFileSync('lib/domain/purchasing/landed-cost-service.ts', 'utf8')
  const calls = src.match(/refreshShipmentCogsForCostLayerChange\(tx,[^\n]*\{[^}]*\}?/g) ?? []
  assert.equal(calls.length, 3)
  const idx = [...src.matchAll(/\.refreshShipmentCogsForCostLayerChange\(tx,/g)].map((m) => m.index!)
  assert.equal(idx.length, 3)
  for (const i of idx) assert.ok(src.slice(i, i + 260).includes('offsetCostDeltaToTransit: true'), 'a landed-cost revaluation must set offsetCostDeltaToTransit')
})
