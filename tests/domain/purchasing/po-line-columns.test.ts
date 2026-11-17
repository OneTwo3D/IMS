import assert from 'node:assert/strict'
import test from 'node:test'
import { PO_LINE_COLS_DEFAULT, parsePoLineCols } from '@/lib/domain/purchasing/po-line-columns'

test('the PO detail columns default to Barcode and Supplier SKU both shown', () => {
  assert.deepEqual(parsePoLineCols(null), PO_LINE_COLS_DEFAULT)
  assert.deepEqual(PO_LINE_COLS_DEFAULT, ['barcode', 'supplierSku'])
})

test('each column can be hidden on its own, and both can be hidden', () => {
  assert.deepEqual(parsePoLineCols('["barcode"]'), ['barcode'])
  assert.deepEqual(parsePoLineCols('["supplierSku"]'), ['supplierSku'])
  assert.deepEqual(parsePoLineCols('[]'), [])
})

test('unknown keys are dropped and garbage falls back to the default', () => {
  assert.deepEqual(parsePoLineCols('["barcode","nope"]'), ['barcode'])
  assert.deepEqual(parsePoLineCols('not json'), PO_LINE_COLS_DEFAULT)
  assert.deepEqual(parsePoLineCols('{"a":1}'), PO_LINE_COLS_DEFAULT)
})
