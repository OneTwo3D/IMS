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

test('a part without ":" is refused instead of defaulting to 1, as is an empty SKU or an empty quantity', () => {
  for (const bad of ['SKU', ':3', 'SKU:', 'SKU: ', 'SKU:1:']) {
    const parsed = parseComponentsCell(bad)
    assert.equal(parsed[0]!.ok, false, `"${bad}" must be refused`)
  }
})

test('each refusal names its own reason', () => {
  const reason = (cell: string) => { const p = parseComponentsCell(cell)[0]!; return p.ok ? '' : p.reason }
  assert.match(reason(':3'), /SKU is empty/)
  assert.match(reason('SKU'), /no ":" found/)
  assert.match(reason('SKU:'), /quantity is empty/)
  assert.match(reason('SKU:0'), /greater than zero/)
  assert.match(reason('SKU:1,5'), /plain number/)
})

test('parseComponentQty names the reason', () => {
  assert.deepEqual(parseComponentQty('12'), { ok: true, qty: 12 })
  const refused = parseComponentQty('1,5')
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.reason, /plain number/)
  assert.deepEqual(parseComponentQty(''), { ok: false, reason: 'the quantity is empty' })
})

test('a SKU containing ":" round-trips through the export form SKU:qty, because the quantity follows the last ":"', () => {
  assert.deepEqual(parseComponentsCell('PART:A:1'), [{ ok: true, sku: 'PART:A', qty: 1 }])
  assert.deepEqual(parseComponentsCell('PART:A:1;B:2.5;X:Y:Z:0.0001'), [
    { ok: true, sku: 'PART:A', qty: 1 },
    { ok: true, sku: 'B', qty: 2.5 },
    { ok: true, sku: 'X:Y:Z', qty: 0.0001 },
  ])
  // The export writes `${sku}:${Number(qty)}`; reading it back gives the same pair.
  for (const [sku, qty] of [['PART:A', 3], ['A:B:C', 0.25], ['PLAIN', 12]] as const) {
    assert.deepEqual(parseComponentsCell(`${sku}:${Number(qty)}`), [{ ok: true, sku, qty }])
  }
  // A SKU with a ":" and no quantity reads its tail as the quantity and is refused.
  assert.equal(parseComponentsCell('PART:A')[0]!.ok, false)
})
