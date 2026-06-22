import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_INVENTORY_GL_SWEEP_LIMIT,
  buildInventoryReconciliationSweepJournal,
  evaluateInventoryGlReconciliation,
  type InventoryGlReconciliationResult,
} from '@/lib/domain/accounting/inventory-gl-reconciliation'

const SWEEP_ACCOUNTS = { inventoryAccount: '1200', roundingAccount: '7999', currency: 'GBP' }

function availableResult(subledgerValue: number, glBalance: number): InventoryGlReconciliationResult {
  return {
    available: true,
    balanceDate: '2026-06-20',
    ...evaluateInventoryGlReconciliation({ subledgerValue, glBalance }),
  }
}

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

test('zero subledger (zero on-hand stock) against a stale non-zero GL balance is flagged', () => {
  // The sparse-snapshot zero-stock case: a covered date with no inventory rows
  // means a 0 subledger, which must still reconcile so a stale GL balance is caught.
  const r = evaluateInventoryGlReconciliation({ subledgerValue: 0, glBalance: 1234.56, sweepLimit: 1 })
  assert.equal(r.action, 'flag')
  assert.equal(r.delta, -1234.56)
})

test('delta is computed on GL-rounded operands (no float dust)', () => {
  const r = evaluateInventoryGlReconciliation({ subledgerValue: 0.1 + 0.2, glBalance: 0.3, sweepLimit: 1 })
  assert.equal(r.delta, 0)
  assert.equal(r.action, 'balanced')
})

test('sweep journal: subledger above GL → DR Inventory / CR Rounding, balanced', () => {
  // subledger 1000.47 vs GL 1000.00 → delta +0.47, within sweep limit.
  const journal = buildInventoryReconciliationSweepJournal(availableResult(1000.47, 1000.0), SWEEP_ACCOUNTS)
  assert.ok(journal)
  assert.equal(journal.amount, 0.47)
  assert.equal(journal.subledgerHigher, true)
  assert.equal(journal.date, '2026-06-20')
  assert.deepEqual(journal.lines, [
    { accountCode: '1200', description: 'Inventory subledger reconciliation 2026-06-20', debit: 0.47 },
    { accountCode: '7999', description: 'Inventory subledger reconciliation 2026-06-20', credit: 0.47 },
  ])
  // Balanced: debits === credits.
  const debit = journal.lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  const credit = journal.lines.reduce((s, l) => s + (l.credit ?? 0), 0)
  assert.equal(debit, credit)
})

test('sweep journal: GL above subledger → CR Inventory / DR Rounding', () => {
  // subledger 999.50 vs GL 1000.00 → delta -0.50.
  const journal = buildInventoryReconciliationSweepJournal(availableResult(999.5, 1000.0), SWEEP_ACCOUNTS)
  assert.ok(journal)
  assert.equal(journal.amount, 0.5)
  assert.equal(journal.subledgerHigher, false)
  assert.deepEqual(journal.lines, [
    { accountCode: '1200', description: 'Inventory subledger reconciliation 2026-06-20', credit: 0.5 },
    { accountCode: '7999', description: 'Inventory subledger reconciliation 2026-06-20', debit: 0.5 },
  ])
})

test('sweep journal: material gap (flag) is never swept', () => {
  // £50 gap → action 'flag'.
  assert.equal(buildInventoryReconciliationSweepJournal(availableResult(1050.0, 1000.0), SWEEP_ACCOUNTS), null)
})

test('sweep journal: balanced reconciliation produces no journal', () => {
  assert.equal(buildInventoryReconciliationSweepJournal(availableResult(1000.0, 1000.0), SWEEP_ACCOUNTS), null)
})

test('sweep journal: unavailable reconciliation produces no journal', () => {
  assert.equal(
    buildInventoryReconciliationSweepJournal({ available: false, reason: 'no_gl_snapshot' }, SWEEP_ACCOUNTS),
    null,
  )
})

test('sweep journal: no journal when the rounding-difference account is unconfigured', () => {
  // The account being blank is the opt-out: residue is accepted within tolerance.
  assert.equal(
    buildInventoryReconciliationSweepJournal(availableResult(1000.47, 1000.0), { ...SWEEP_ACCOUNTS, roundingAccount: '  ' }),
    null,
  )
})

test('sweep journal: no journal when the inventory account is unconfigured', () => {
  assert.equal(
    buildInventoryReconciliationSweepJournal(availableResult(1000.47, 1000.0), { ...SWEEP_ACCOUNTS, inventoryAccount: '' }),
    null,
  )
})
