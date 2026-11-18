import assert from 'node:assert/strict'
import test from 'node:test'
import { sameScopeLines, warehouseShipmentsMatchAllocations } from '../lib/domain/wms/scoped-despatch-checks.ts'

test('sameScopeLines: equal by line regardless of order; a changed or missing line is a mismatch', () => {
  assert.equal(sameScopeLines([{ lineId: 'a', quantity: 1 }, { lineId: 'b', quantity: '2.0000' }], [{ lineId: 'b', quantity: 2 }, { lineId: 'a', quantity: 1 }]), true)
  assert.equal(sameScopeLines([{ lineId: 'a', quantity: 1 }], [{ lineId: 'a', quantity: 2 }]), false)
  assert.equal(sameScopeLines([{ lineId: 'a', quantity: 1 }], [{ lineId: 'a', quantity: 1 }, { lineId: 'b', quantity: 1 }]), false)
  assert.equal(sameScopeLines([], []), true)
})

test('warehouseShipmentsMatchAllocations: exact per (line, product); names the first difference', () => {
  assert.equal(warehouseShipmentsMatchAllocations([{ lineId: 'a', productId: 'p', qty: '1.0000' }, { lineId: 'a', productId: 'p', qty: 1 }], [{ lineId: 'a', productId: 'p', qty: 2 }]), null)
  assert.match(warehouseShipmentsMatchAllocations([{ lineId: 'a', productId: 'p', qty: 1 }], [{ lineId: 'a', productId: 'p', qty: 2 }]) ?? '', /hold 1 .* 2 is allocated/)
  assert.match(warehouseShipmentsMatchAllocations([], [{ lineId: 'a', productId: 'p', qty: 2 }]) ?? '', /hold 0/)
  assert.match(warehouseShipmentsMatchAllocations([{ lineId: 'a', productId: 'p', qty: 2 }], []) ?? '', /where 0 is allocated/)
})
