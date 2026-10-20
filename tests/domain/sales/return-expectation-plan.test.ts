import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { sumCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { roundQuantity } from '@/lib/domain/math/decimal'
import {
  ReturnExpectationPlanError,
  planReturnExpectationLines,
} from '@/lib/domain/sales/return-expectation-plan'
import { deriveReturnExpectationStatus, isReturnExpectationOpen } from '@/lib/domain/workflows/return-expectation-state'
import { readReturnsInTransitEnabled, REFUND_RETURNS_IN_TRANSIT_SETTING } from '@/lib/domain/sales/return-expectation'

const skus = new Map([['p1', 'SKU-1'], ['p2', 'SKU-2']])

test('[plan] one line per (refund line, product): two refund lines of one product stay two lines', () => {
  const plan = planReturnExpectationLines([
    { productId: 'p1', qty: 1, refundLineId: 'rl-a', unitCostBase: '10', sourceCostLayerId: 'cl-1', poLineId: 'po-1' },
    { productId: 'p1', qty: 2, refundLineId: 'rl-b', unitCostBase: '11', sourceCostLayerId: 'cl-2' },
    { productId: 'p1', qty: 1, refundLineId: 'rl-a', unitCostBase: '12', sourceCostLayerId: 'cl-3' },
    { productId: 'p2', qty: 1, refundLineId: 'rl-a', unitCostBase: '5' },
  ], skus)
  assert.deepEqual(plan.lines.map((line) => [line.refundLineId, line.productId, line.qty.toFixed(6), line.transitValueBase.toFixed(6)]), [
    ['rl-a', 'p1', '2.000000', '22.000000'],
    ['rl-b', 'p1', '2.000000', '22.000000'],
    ['rl-a', 'p2', '1.000000', '5.000000'],
  ])
  assert.equal(plan.lines[0].costSnapshot.length, 2, 'the cost entries stay separate: arrival slices them FIFO')
  assert.equal(plan.lines[0].sku, 'SKU-1')
  assert.equal(plan.totalValueBase.toFixed(6), '49.000000')
  assert.equal(plan.unpricedEntryCount, 0)
})

test('[plan] the total is the SAME 6dp figure the COGS reversal uses (summed unrounded, rounded once): no tolerance needed', () => {
  // Entries whose per-entry products carry more than 6dp: summing rounded parts would drift from the reversal's figure.
  const entries = [
    { qty: '0.333333', unitCostBase: '3.333333' },
    { qty: '0.333333', unitCostBase: '3.333333' },
    { qty: '0.333334', unitCostBase: '3.333335' },
  ]
  const reversalBase = roundQuantity(sumCostLayerSnapshot(entries.map((entry, index) => ({ costLayerId: `cl-${index}`, ...entry })) as never), 6)
  const plan = planReturnExpectationLines(
    entries.map((entry, index) => ({ productId: 'p1', refundLineId: 'rl', sourceCostLayerId: `cl-${index}`, qty: entry.qty, unitCostBase: entry.unitCostBase })),
    skus,
  )
  assert.equal(plan.totalValueBase.toFixed(6), reversalBase.toFixed(6))
  assert.equal(plan.lines[0].transitValueBase.toFixed(6), reversalBase.toFixed(6))
})

test('[plan] money is Decimal: a float-hostile value does not drift', () => {
  const plan = planReturnExpectationLines([{ productId: 'p1', refundLineId: 'rl', qty: 3, unitCostBase: new Prisma.Decimal('0.1') }], skus)
  assert.equal(plan.totalValueBase.toFixed(6), '0.300000')
})

test('[plan] rows without a cost are counted, not valued', () => {
  const plan = planReturnExpectationLines([
    { productId: 'p1', refundLineId: 'rl', qty: 1 },
    { productId: 'p1', refundLineId: 'rl', qty: 1, unitCostBase: 4 },
  ], skus)
  assert.equal(plan.unpricedEntryCount, 1)
  assert.equal(plan.totalValueBase.toFixed(6), '4.000000')
  assert.equal(plan.lines[0].costSnapshot[0].unitCostBase, null)
})

test('[plan] zero-quantity rows and rows with no product move nothing; an empty return plans nothing', () => {
  assert.equal(planReturnExpectationLines([{ productId: 'p1', refundLineId: 'rl', qty: 0, unitCostBase: 5 }], skus).lines.length, 0)
  assert.equal(planReturnExpectationLines([{ productId: '', refundLineId: 'rl', qty: 1 }], skus).lines.length, 0)
  assert.equal(planReturnExpectationLines([], skus).lines.length, 0)
})

test('[plan] refuses what it cannot attribute: no refund line, no SKU, negative cost, negative quantity', () => {
  const code = (fn: () => unknown) => {
    try { fn() } catch (error) { return error instanceof ReturnExpectationPlanError ? error.code : `other:${String(error)}` }
    return 'no-throw'
  }
  assert.equal(code(() => planReturnExpectationLines([{ productId: 'p1', qty: 1 }], skus)), 'row_without_refund_line')
  assert.equal(code(() => planReturnExpectationLines([{ productId: 'p1', refundLineId: null, qty: 1 }], skus)), 'row_without_refund_line')
  assert.equal(code(() => planReturnExpectationLines([{ productId: 'zz', refundLineId: 'rl', qty: 1 }], skus)), 'row_without_sku')
  assert.equal(code(() => planReturnExpectationLines([{ productId: 'p1', refundLineId: 'rl', qty: 1, unitCostBase: -1 }], skus)), 'row_negative_cost')
  // A negative quantity is dropped like a zero one: it can never add to what is expected back.
  assert.equal(planReturnExpectationLines([{ productId: 'p1', refundLineId: 'rl', qty: -2, unitCostBase: 1 }], skus).lines.length, 0)
})

test('[state] status is derived from the lines and an inconsistent document is refused, never read as closed', () => {
  const line = (qty: string, received = '0', writtenOff = '0') => ({ qty, qtyReceived: received, qtyWrittenOff: writtenOff })
  assert.equal(deriveReturnExpectationStatus([line('2')]), 'IN_TRANSIT')
  assert.equal(deriveReturnExpectationStatus([line('2', '1')]), 'PARTIALLY_RECEIVED')
  assert.equal(deriveReturnExpectationStatus([line('2', '2')]), 'RECEIVED')
  assert.equal(deriveReturnExpectationStatus([line('2', '0', '1')]), 'PARTIALLY_WRITTEN_OFF')
  assert.equal(deriveReturnExpectationStatus([line('2', '0', '2')]), 'WRITTEN_OFF')
  assert.equal(deriveReturnExpectationStatus([line('2', '1', '1')]), 'RECEIVED', 'closed with some of each reads as received; the per-line quantities carry the split')
  assert.equal(deriveReturnExpectationStatus([line('1', '1'), line('1')]), 'PARTIALLY_RECEIVED', 'one line closed does not close the document')
  assert.equal(deriveReturnExpectationStatus([line('0.000001', '0.000001')]), 'RECEIVED', 'Decimal, not float')
  assert.throws(() => deriveReturnExpectationStatus([line('1', '1', '1')]), /return_expectation_line_over_accounted/)
  assert.throws(() => deriveReturnExpectationStatus([]), /return_expectation_has_no_lines/)
  assert.deepEqual(
    (['IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'WRITTEN_OFF', 'PARTIALLY_WRITTEN_OFF'] as const).map(isReturnExpectationOpen),
    [true, true, false, false, true],
  )
})

test('[switch] the setting is read exactly, and an unreadable setting throws instead of answering off', async () => {
  const reader = (value: string | null) => ({ setting: { findUnique: async ({ where }: { where: { key: string } }) => {
    assert.equal(where.key, REFUND_RETURNS_IN_TRANSIT_SETTING)
    return value == null ? null : { value }
  } } }) as never
  assert.equal(await readReturnsInTransitEnabled(reader('true')), true)
  for (const off of [null, '', 'false', 'True', ' true', 'true ', '1']) assert.equal(await readReturnsInTransitEnabled(reader(off)), false, JSON.stringify(off))
  await assert.rejects(() => readReturnsInTransitEnabled({ setting: { findUnique: async () => { throw new Error('boom') } } } as never), /boom/)
})
