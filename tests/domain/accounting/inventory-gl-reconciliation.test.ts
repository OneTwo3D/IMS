import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_INVENTORY_GL_SWEEP_LIMIT,
  evaluateInventoryGlReconciliation,
} from '@/lib/domain/accounting/inventory-gl-reconciliation'

test('balanced when the rounded subledger equals the GL balance', () => {
  const r = evaluateInventoryGlReconciliation({ subledgerValue: 1000.0, glBalance: 1000.0 })
  assert.equal(r.action, 'balanced')
  assert.equal(r.delta, 0)
})

test('sub-penny subledger value still balances once rounded to GL precision', () => {
  // 6dp subledger value rounds to the same 2dp as the GL balance.
  const r = evaluateInventoryGlReconciliation({ subledgerValue: 1000.004321, glBalance: 1000.0 })
  assert.equal(r.action, 'balanced')
  assert.equal(r.delta, 0)
})

test('rounding-scale gap within the sweep limit is classified sweep, not flag', () => {
  const r = evaluateInventoryGlReconciliation({ subledgerValue: 1000.5, glBalance: 1000.0 })
  assert.equal(r.action, 'sweep')
  assert.equal(r.delta, 0.5)
  assert.equal(r.sweepLimit, DEFAULT_INVENTORY_GL_SWEEP_LIMIT)
})

test('gap exactly at the sweep limit sweeps; just beyond it flags', () => {
  assert.equal(
    evaluateInventoryGlReconciliation({ subledgerValue: 101, glBalance: 100, sweepLimit: 1 }).action,
    'sweep',
  )
  assert.equal(
    evaluateInventoryGlReconciliation({ subledgerValue: 101.01, glBalance: 100, sweepLimit: 1 }).action,
    'flag',
  )
})

test('material discrepancy is flagged (never swept), with a signed delta', () => {
  const over = evaluateInventoryGlReconciliation({ subledgerValue: 5000, glBalance: 4200, sweepLimit: 1 })
  assert.equal(over.action, 'flag')
  assert.equal(over.delta, 800) // GL understated vs subledger

  const under = evaluateInventoryGlReconciliation({ subledgerValue: 4200, glBalance: 5000, sweepLimit: 1 })
  assert.equal(under.action, 'flag')
  assert.equal(under.delta, -800) // GL overstated vs subledger
})

test('delta is computed on GL-rounded operands (no float dust)', () => {
  const r = evaluateInventoryGlReconciliation({ subledgerValue: 0.1 + 0.2, glBalance: 0.3, sweepLimit: 1 })
  assert.equal(r.delta, 0)
  assert.equal(r.action, 'balanced')
})
