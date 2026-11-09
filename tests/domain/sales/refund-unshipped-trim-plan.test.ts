import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '../../../app/generated/prisma/client'
import { planUnshippedTrim } from '../../../lib/domain/sales/refund-unshipped-trim-plan'

const D = (v: string) => new Prisma.Decimal(v)
const simple = (id: string, productId: string, qty: string) => ({ id, qty, requirements: [{ productId, factor: D('1') }] })
const summary = (steps: ReturnType<typeof planUnshippedTrim>) => steps.map((s) => [s.productId, s.warehouseId, s.qty.toFixed(4)])

test('a kit trims every component in proportion to the refunded kits', () => {
  const steps = planUnshippedTrim({
    lines: [{ id: 'L', qty: '4', requirements: [{ productId: 'c1', factor: D('1') }, { productId: 'c2', factor: D('3') }] }],
    rows: [
      { lineId: 'L', productId: 'c1', warehouseId: 'w', qty: '4' },
      { lineId: 'L', productId: 'c2', warehouseId: 'w', qty: '12' },
    ],
    committed: [],
    refundedByLine: new Map([['L', '1']]),
    noDemand: false,
  })
  assert.deepEqual(summary(steps), [['c1', 'w', '1.0000'], ['c2', 'w', '3.0000']])
})

test('the trim is spread over warehouse rows, largest room first, and never below a committed row', () => {
  const steps = planUnshippedTrim({
    lines: [simple('L', 'p', '10')],
    rows: [
      { lineId: 'L', productId: 'p', warehouseId: 'w1', qty: '6' },
      { lineId: 'L', productId: 'p', warehouseId: 'w2', qty: '4' },
    ],
    committed: [{ lineId: 'L', productId: 'p', warehouseId: 'w1', qty: '5' }],
    refundedByLine: new Map([['L', '5']]),
    noDemand: false,
  })
  // keep = max(10 - 5, committed 5) = 5; current 10; excess 5. w1 has room 1, w2 room 4.
  assert.deepEqual(summary(steps), [['p', 'w2', '4.0000'], ['p', 'w1', '1.0000']])
})

test('a partly allocated line is not trimmed for units that were never reserved', () => {
  const steps = planUnshippedTrim({
    lines: [simple('L', 'p', '5')],
    rows: [{ lineId: 'L', productId: 'p', warehouseId: 'w', qty: '3' }],
    committed: [],
    refundedByLine: new Map([['L', '2']]),
    noDemand: false,
  })
  assert.deepEqual(steps, [])
})

test('already at target (a replay) trims nothing', () => {
  const steps = planUnshippedTrim({
    lines: [simple('L', 'p', '5')],
    rows: [{ lineId: 'L', productId: 'p', warehouseId: 'w', qty: '3' }],
    committed: [{ lineId: 'L', productId: 'p', warehouseId: 'w', qty: '3' }],
    refundedByLine: new Map([['L', '2']]),
    noDemand: false,
  })
  assert.deepEqual(steps, [])
})

test('a row for a component the requirements do not name skips the whole line (a stale pin is not "no demand")', () => {
  const steps = planUnshippedTrim({
    lines: [simple('L', 'p', '5')],
    rows: [{ lineId: 'L', productId: 'old-component', warehouseId: 'w', qty: '5' }],
    committed: [],
    refundedByLine: new Map([['L', '5']]),
    noDemand: false,
  })
  assert.deepEqual(steps, [])
})

test('no demand (cancelled or refunded in full) releases everything above what committed shipments cover', () => {
  const steps = planUnshippedTrim({
    lines: [simple('L', 'p', '5')],
    rows: [{ lineId: 'L', productId: 'p', warehouseId: 'w', qty: '5' }],
    committed: [{ lineId: 'L', productId: 'p', warehouseId: 'w', qty: '2' }],
    refundedByLine: new Map(),
    noDemand: true,
  })
  assert.deepEqual(summary(steps), [['p', 'w', '3.0000']])
})

test('the committed floor can exceed what the refund would leave: committed rows are kept', () => {
  const steps = planUnshippedTrim({
    lines: [simple('L', 'p', '5')],
    rows: [{ lineId: 'L', productId: 'p', warehouseId: 'w', qty: '5' }],
    committed: [{ lineId: 'L', productId: 'p', warehouseId: 'w', qty: '4' }],
    refundedByLine: new Map([['L', '3']]),
    noDemand: false,
  })
  // target 2 but 4 are committed: keep 4, release 1.
  assert.deepEqual(summary(steps), [['p', 'w', '1.0000']])
})

test('the excess is floored to the column scale, never rounded up past what the arithmetic allows', () => {
  const steps = planUnshippedTrim({
    lines: [{ id: 'L', qty: '2', requirements: [{ productId: 'c', factor: D('0.33335') }] }],
    rows: [{ lineId: 'L', productId: 'c', warehouseId: 'w', qty: '0.6667' }],
    committed: [],
    refundedByLine: new Map([['L', '1']]),
    noDemand: false,
  })
  // keep 0.33335, current 0.6667, excess 0.33335 -> floored 0.3333.
  assert.deepEqual(summary(steps), [['c', 'w', '0.3333']])
})
