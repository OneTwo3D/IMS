import assert from 'node:assert/strict'
import test from 'node:test'

import {
  manufacturingCostLayerReceivedAt,
  parseManufacturingCostLines,
} from '@/lib/domain/manufacturing/manufacturing-action-inputs'

test('manufacturing cost layer receivedAt uses completedAt when present', () => {
  const completedAt = new Date('2026-06-01T09:15:00.000Z')
  const fallback = new Date('2026-06-02T10:30:00.000Z')

  assert.equal(manufacturingCostLayerReceivedAt(completedAt, fallback), completedAt)
})

test('manufacturing cost layer receivedAt falls back to completion timestamp', () => {
  const fallback = new Date('2026-06-02T10:30:00.000Z')

  assert.equal(manufacturingCostLayerReceivedAt(null, fallback), fallback)
})

test('manufacturing cost line parser drops sub-half-penny negative dust', () => {
  const result = parseManufacturingCostLines([
    { description: 'rounding dust', amountForeign: -0.001, accountCode: ' 5100 ' },
  ], 1)

  assert.deepEqual(result, { success: true, lines: [] })
})

test('manufacturing cost line parser rejects real negative cost adjustments before rounding', () => {
  const result = parseManufacturingCostLines([
    { description: 'credit adjustment', amountForeign: -0.006, accountCode: '5100' },
  ], 1)

  assert.deepEqual(result, {
    success: false,
    error: 'Manufacturing cost amounts must be non-negative. Use a separate adjustment to credit inventory.',
  })
})

test('manufacturing cost line parser rounds positive amounts and trims accounts', () => {
  const result = parseManufacturingCostLines([
    { description: '   ', amountForeign: 10 },
    { description: 'labour', amountForeign: 1.23445, accountCode: ' 5100 ' },
  ], 1.2)

  assert.deepEqual(result, {
    success: true,
    lines: [{
      description: 'labour',
      amountForeign: 1.2345,
      amountBase: 1.4813,
      accountCode: '5100',
      sortOrder: 0,
    }],
  })
})
