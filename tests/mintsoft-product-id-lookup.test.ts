import assert from 'node:assert/strict'
import test from 'node:test'

import { parseMintsoftProductId } from '../lib/connectors/mintsoft/api/client.ts'

// /api/Product/LookupProductId returns a bare int ProductId; 0 means "not found".
test('parses a positive integer ProductId', () => {
  assert.equal(parseMintsoftProductId(12345), 12345)
})

test('parses a numeric string ProductId', () => {
  assert.equal(parseMintsoftProductId('  168 '), 168)
})

test('treats 0 / negative / non-integer as not found', () => {
  assert.equal(parseMintsoftProductId(0), null)
  assert.equal(parseMintsoftProductId('0'), null)
  assert.equal(parseMintsoftProductId(-5), null)
  assert.equal(parseMintsoftProductId(1.5), null)
})

test('rejects non-numeric / absent payloads', () => {
  assert.equal(parseMintsoftProductId(null), null)
  assert.equal(parseMintsoftProductId(undefined), null)
  assert.equal(parseMintsoftProductId(''), null)
  assert.equal(parseMintsoftProductId('abc'), null)
  assert.equal(parseMintsoftProductId({ ProductId: 5 }), null)
})
