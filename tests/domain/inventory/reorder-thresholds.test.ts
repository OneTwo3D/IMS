import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { parseOverrideInput, resolveReorderThresholds } from '@/lib/domain/inventory/reorder-thresholds'

const PRODUCT = { reorderPoint: new Prisma.Decimal('50'), safetyStockQty: '10', reorderQty: 25 }

test('no override row: every field inherits the Product value', () => {
  const r = resolveReorderThresholds(PRODUCT, null)
  assert.equal(r.reorderPoint?.toString(), '50')
  assert.equal(r.safetyStockQty?.toString(), '10')
  assert.equal(r.reorderQty?.toString(), '25')
  assert.deepEqual(r.overridden, [])
})

test('null overrides inherit; a set override wins per field, independently', () => {
  const r = resolveReorderThresholds(PRODUCT, { reorderPoint: '8', safetyStockQty: null, reorderQty: undefined })
  assert.equal(r.reorderPoint?.toString(), '8')
  assert.equal(r.safetyStockQty?.toString(), '10')
  assert.equal(r.reorderQty?.toString(), '25')
  assert.deepEqual(r.overridden, ['reorderPoint'])
})

test('an override of zero is an override, not "unset"', () => {
  const r = resolveReorderThresholds(PRODUCT, { reorderQty: new Prisma.Decimal(0), safetyStockQty: 0 })
  assert.equal(r.reorderQty?.toString(), '0')
  assert.equal(r.safetyStockQty?.toString(), '0')
  assert.deepEqual(r.overridden, ['safetyStockQty', 'reorderQty'])
})

test('unset on both sides resolves to null, not zero', () => {
  const r = resolveReorderThresholds({ reorderPoint: null, safetyStockQty: null, reorderQty: null }, { reorderPoint: null })
  assert.equal(r.reorderPoint, null)
  assert.equal(r.safetyStockQty, null)
  assert.equal(r.reorderQty, null)
  assert.deepEqual(r.overridden, [])
})

test('an override applies even when the Product value is unset', () => {
  const r = resolveReorderThresholds({ reorderPoint: null, safetyStockQty: null, reorderQty: null }, { safetyStockQty: '3.5' })
  assert.equal(r.safetyStockQty?.toString(), '3.5')
  assert.deepEqual(r.overridden, ['safetyStockQty'])
})

test('parseOverrideInput: blank inherits, numbers parse, junk and out-of-range are refused', () => {
  assert.deepEqual(parseOverrideInput(''), { ok: true, value: null })
  assert.deepEqual(parseOverrideInput('   '), { ok: true, value: null })
  assert.deepEqual(parseOverrideInput(null), { ok: true, value: null })
  const zero = parseOverrideInput('0')
  assert.ok(zero.ok && zero.value?.toString() === '0')
  const frac = parseOverrideInput(' 12.5 ')
  assert.ok(frac.ok && frac.value?.toString() === '12.5')
  for (const bad of ['-1', 'abc', '1e3', '1,000', '1.23456', '100000000', '.5', 'NaN', '--2']) {
    assert.equal(parseOverrideInput(bad).ok, false, bad)
  }
  assert.equal(parseOverrideInput('99999999.9999').ok, true)
})
