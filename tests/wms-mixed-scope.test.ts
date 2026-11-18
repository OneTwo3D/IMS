import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apportionMinor, computeMixedScope, type ComputeMixedScopeInput, type ScopeLineInput } from '@/lib/domain/wms/mixed-scope'

const W = 'wh-wms'
const O = 'wh-own'

function line(id: string, over: Partial<ScopeLineInput> = {}): ScopeLineInput {
  return {
    lineId: id, sku: `SKU-${id}`, description: `Line ${id}`, orderedQty: 2, refundedQty: 0, netMinor: 2000, vatMinor: 400,
    requirements: [{ productId: `p-${id}`, perUnit: '1' }], isFee: false, ...over,
  }
}
function input(over: Partial<ComputeMixedScopeInput>): ComputeMixedScopeInput {
  return {
    wmsWarehouseId: W,
    lines: [line('a'), line('b')],
    allocations: [
      { lineId: 'a', productId: 'p-a', warehouseId: W, qty: '2' },
      { lineId: 'b', productId: 'p-b', warehouseId: O, qty: '2' },
    ],
    shipments: [],
    money: { discountMinor: 0, shippingMinor: 500, totalVatMinor: 900 },
    minorFactor: 100,
    ...over,
  }
}

test('apportionMinor: largest remainder, deterministic ties, exact sum', () => {
  assert.deepEqual(apportionMinor(100, [1, 1, 1]), [34, 33, 33])
  assert.deepEqual(apportionMinor(10, [1, 2]), [3, 7])
  assert.deepEqual(apportionMinor(1, [1, 1]), [1, 0])
  assert.deepEqual(apportionMinor(0, [1, 1]), [0, 0])
  assert.deepEqual(apportionMinor(-100, [1, 1, 1]), [-34, -33, -33])
  assert.deepEqual(apportionMinor(7, [0, 0]), [7, 0])
  for (const total of [1, 99, 1234, 100001]) {
    const parts = apportionMinor(total, [3.3, 1.1, 7.7, 0.4])
    assert.equal(parts.reduce((a, b) => a + b, 0), total)
  }
  assert.throws(() => apportionMinor(1.5, [1]))
})

test('single warehouse (or nothing allocated) is FULL: the caller sends the order unchanged', () => {
  assert.deepEqual(computeMixedScope(input({ allocations: [{ lineId: 'a', productId: 'p-a', warehouseId: W, qty: '2' }, { lineId: 'b', productId: 'p-b', warehouseId: W, qty: '2' }] })), { mode: 'FULL' })
  assert.deepEqual(computeMixedScope(input({ allocations: [] })), { mode: 'FULL' })
})

test('mixed order sends only the WMS warehouse units and carries shipping and residual VAT when no other part has shipped', () => {
  const scope = computeMixedScope(input({}))
  assert.equal(scope.mode, 'MIXED')
  if (scope.mode !== 'MIXED') return
  assert.deepEqual(scope.lines.map((l) => [l.sku, l.quantity, l.unitPriceExVat, l.unitPriceVat]), [['SKU-a', 2, 10, 2]])
  assert.equal(scope.shippingMinor, 500)
  assert.equal(scope.shippingCarried, true)
  // line a VAT 400 + residual (900 - 800 = 100)
  assert.equal(scope.vatMinor, 500)
})

test('Q2: shipping and residual VAT go to whichever part ships first', () => {
  const scope = computeMixedScope(input({ shipments: [{ id: 's1', warehouseId: O, status: 'SHIPPED' }] }))
  assert.equal(scope.mode, 'MIXED')
  if (scope.mode !== 'MIXED') return
  assert.equal(scope.shippingMinor, 0)
  assert.equal(scope.shippingCarried, false)
  assert.equal(scope.vatMinor, 400)
  // an unshipped other-warehouse shipment does not take the shipping
  const pending = computeMixedScope(input({ shipments: [{ id: 's1', warehouseId: O, status: 'PENDING' }] }))
  assert.equal(pending.mode === 'MIXED' && pending.shippingMinor, 500)
})

test('Q3: the discount is pro-rated by sent net, in pence, summing to the order discount', () => {
  const lines = [line('a', { netMinor: 3000 }), line('b', { netMinor: 1000 })]
  const scope = computeMixedScope(input({ lines, money: { discountMinor: 1001, shippingMinor: 0, totalVatMinor: 800 } }))
  assert.equal(scope.mode, 'MIXED')
  if (scope.mode !== 'MIXED') return
  // W sends 3000 of 4000 net: 750.75 -> 751; the other part gets 250
  assert.equal(scope.discountMinor, 751)
})

test('Q1: any unallocated unit holds the push', () => {
  const scope = computeMixedScope(input({ allocations: [{ lineId: 'a', productId: 'p-a', warehouseId: W, qty: '2' }, { lineId: 'b', productId: 'p-b', warehouseId: O, qty: '1' }] }))
  assert.equal(scope.mode, 'HOLD')
  // a refunded unit is not demand
  const refunded = computeMixedScope(input({ lines: [line('a'), line('b', { refundedQty: 1 })], allocations: [{ lineId: 'a', productId: 'p-a', warehouseId: W, qty: '2' }, { lineId: 'b', productId: 'p-b', warehouseId: O, qty: '1' }] }))
  assert.equal(refunded.mode, 'MIXED')
})

test('Q4: a kit is whole units; split inside a unit is refused', () => {
  const kit = (over: Partial<ScopeLineInput> = {}) => line('k', { orderedQty: 2, sku: 'KIT', requirements: [{ productId: 'c1', perUnit: '1' }, { productId: 'c2', perUnit: '2' }], ...over })
  const whole = computeMixedScope(input({
    lines: [kit(), line('a')],
    allocations: [
      { lineId: 'k', productId: 'c1', warehouseId: W, qty: '1' }, { lineId: 'k', productId: 'c2', warehouseId: W, qty: '2' },
      { lineId: 'k', productId: 'c1', warehouseId: O, qty: '1' }, { lineId: 'k', productId: 'c2', warehouseId: O, qty: '2' },
      { lineId: 'a', productId: 'p-a', warehouseId: W, qty: '2' },
    ],
  }))
  assert.equal(whole.mode, 'MIXED')
  if (whole.mode === 'MIXED') assert.deepEqual(whole.lines.filter((l) => l.sku === 'KIT').map((l) => l.quantity), [1])
  const split = computeMixedScope(input({
    lines: [kit({ orderedQty: 1 })],
    allocations: [
      { lineId: 'k', productId: 'c1', warehouseId: W, qty: '1' }, { lineId: 'k', productId: 'c2', warehouseId: O, qty: '2' },
    ],
  }))
  assert.equal(split.mode, 'REFUSED')
  if (split.mode === 'REFUSED') assert.equal(split.code, 'SPLIT_KIT')
})

test('nothing allocated to the WMS warehouse is EMPTY', () => {
  const scope = computeMixedScope(input({ allocations: [{ lineId: 'a', productId: 'p-a', warehouseId: O, qty: '2' }, { lineId: 'b', productId: 'p-b', warehouseId: O, qty: '2' }] }))
  assert.equal(scope.mode, 'EMPTY')
})

test('the hash is stable and moves with the scope', () => {
  const a = computeMixedScope(input({}))
  const b = computeMixedScope(input({}))
  const c = computeMixedScope(input({ shipments: [{ id: 's', warehouseId: O, status: 'SHIPPED' }] }))
  assert.equal(a.mode === 'MIXED' && b.mode === 'MIXED' && a.hash, b.mode === 'MIXED' && b.hash)
  assert.notEqual(a.mode === 'MIXED' && a.hash, c.mode === 'MIXED' && c.hash)
})

test('fee lines are never sent and lines with no stock requirement stay with the WMS part', () => {
  const fee = line('f', { isFee: true, sku: null, requirements: [] })
  const service = line('s', { requirements: [], orderedQty: 1, netMinor: 500, vatMinor: 100 })
  const scope = computeMixedScope(input({ lines: [line('a'), line('b'), fee, service], money: { discountMinor: 0, shippingMinor: 0, totalVatMinor: 900 } }))
  assert.equal(scope.mode, 'MIXED')
  if (scope.mode !== 'MIXED') return
  assert.deepEqual(scope.lines.map((l) => l.sku), ['SKU-a', 'SKU-s'])
})
