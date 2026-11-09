import assert from 'node:assert/strict'
import test from 'node:test'

import { parseComponentQty, parseComponentsCell } from '../../../lib/domain/import/component-recipe-cell'

test('a plain SKU:qty list is read in order, blank parts ignored', () => {
  assert.deepEqual(parseComponentsCell(' A:1 ; B : 2.5 ;; C:0.0001;'), [
    { ok: true, sku: 'A', qty: 1 },
    { ok: true, sku: 'B', qty: 2.5 },
    { ok: true, sku: 'C', qty: 0.0001 },
  ])
})

test('a quantity that parseFloat read a prefix of is refused, not truncated', () => {
  for (const bad of ['1,5', '2 units', '3abc', '1e3', '+1', '-1', '.5', '1.', '1.12345', '0', '0.0000', '1_000', '123456789']) {
    const parsed = parseComponentsCell(`SKU:${bad}`)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]!.ok, false, `"${bad}" must be refused`)
  }
})

test('a part without ":" is refused instead of defaulting to 1, as is one with two, an empty SKU or an empty quantity', () => {
  for (const bad of ['SKU', 'SKU:1:2', ':3', 'SKU:', 'SKU: ']) {
    const parsed = parseComponentsCell(bad)
    assert.equal(parsed[0]!.ok, false, `"${bad}" must be refused`)
  }
})

test('parseComponentQty names the reason', () => {
  assert.deepEqual(parseComponentQty('12'), { ok: true, qty: 12 })
  const refused = parseComponentQty('1,5')
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.reason, /plain number/)
  assert.deepEqual(parseComponentQty(''), { ok: false, reason: 'the quantity is empty' })
})
