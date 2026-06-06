import assert from 'node:assert/strict'
import test from 'node:test'

import {
  manufacturingCostLayerReceivedAt,
  parseManufacturingCostLines,
} from '@/lib/domain/manufacturing/manufacturing-action-inputs'

test('manufacturing cost layer receivedAt uses completedAt when present', () => {
  const completedAt = new Date('2026-06-01T09:15:00.000Z')
  const transitionAt = new Date('2026-06-02T10:30:00.000Z')

  assert.equal(manufacturingCostLayerReceivedAt({
    orderType: 'ASSEMBLY',
    completedAt,
    transitionAt,
  }), completedAt)
})

test('manufacturing cost layer receivedAt falls back to completion timestamp', () => {
  const transitionAt = new Date('2026-06-02T10:30:00.000Z')

  assert.equal(manufacturingCostLayerReceivedAt({
    orderType: 'ASSEMBLY',
    completedAt: null,
    transitionAt,
  }), transitionAt)
})

test('manufacturing cost layer receivedAt uses transition time for disassembly recovery', () => {
  const oldCompletedAt = new Date('2026-03-01T09:15:00.000Z')
  const transitionAt = new Date('2026-06-02T10:30:00.000Z')

  assert.equal(manufacturingCostLayerReceivedAt({
    orderType: 'DISASSEMBLY',
    completedAt: oldCompletedAt,
    transitionAt,
  }), transitionAt)
})

test('manufacturing cost line parser rejects invalid FX rates', () => {
  const result = parseManufacturingCostLines([
    { description: 'labour', amountForeign: 10, accountCode: '5100' },
  ], 0)

  assert.deepEqual(result, {
    success: false,
    error: 'Invalid FX rate 0 on production order; set a positive rate before editing cost lines.',
  })
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

test('manufacturing cost line parser rounds positive amounts, trims accounts, and preserves input sort positions', () => {
  const result = parseManufacturingCostLines([
    { description: '   ', amountForeign: 10 },
    { description: 'zero placeholder', amountForeign: 0 },
    { description: 'labour', amountForeign: 1.23445, accountCode: ' 5100 ' },
  ], 1.2)

  assert.deepEqual(result, {
    success: true,
    lines: [{
      description: 'labour',
      amountForeign: 1.2345,
      amountBase: 1.4813,
      accountCode: '5100',
      sortOrder: 2,
    }],
  })
})
