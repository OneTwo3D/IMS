import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_GL_SWEEP_LIMIT,
  buildAccountReconciliationSweepJournal,
  evaluateAccountGlReconciliation,
  type AccountGlReconciliationResult,
} from '@/lib/domain/accounting/account-gl-reconciliation'

const COGS_LABELS = { descriptionLabel: 'COGS subledger reconciliation', accountLabel: 'COGS' }
const SWEEP_ACCOUNTS = { account: '5000', roundingAccount: '7999', currency: 'GBP', ...COGS_LABELS }

function availableResult(subledgerValue: number, glBalance: number): AccountGlReconciliationResult {
  return {
    available: true,
    balanceDate: '2026-06-20',
    ...evaluateAccountGlReconciliation({ subledgerValue, glBalance }),
  }
}

test('balanced / sweep / flag classification mirrors the inventory evaluator', () => {
  assert.equal(evaluateAccountGlReconciliation({ subledgerValue: 1000, glBalance: 1000 }).action, 'balanced')
  assert.equal(evaluateAccountGlReconciliation({ subledgerValue: 1000.5, glBalance: 1000 }).action, 'sweep')
  assert.equal(
    evaluateAccountGlReconciliation({ subledgerValue: 5000, glBalance: 4200, sweepLimit: 1 }).action,
    'flag',
  )
  assert.equal(DEFAULT_GL_SWEEP_LIMIT, 1)
})

test('period-movement basis works with negative movements (a net COGS reversal window)', () => {
  // COGS reconciles a period MOVEMENT, which can be negative when refunds dominate.
  const r = evaluateAccountGlReconciliation({ subledgerValue: -300.4, glBalance: -300, sweepLimit: 1 })
  assert.equal(r.action, 'sweep')
  assert.equal(r.delta, -0.4)
})

test('sweep journal for an expense account: subledger above GL → DR COGS / CR Rounding', () => {
  const journal = buildAccountReconciliationSweepJournal(availableResult(1000.47, 1000.0), SWEEP_ACCOUNTS)
  assert.ok(journal)
  assert.equal(journal.amount, 0.47)
  assert.equal(journal.subledgerHigher, true)
  assert.deepEqual(journal.lines, [
    { accountCode: '5000', description: 'COGS subledger reconciliation 2026-06-20', debit: 0.47 },
    { accountCode: '7999', description: 'COGS subledger reconciliation 2026-06-20', credit: 0.47 },
  ])
  assert.match(journal.narration, /^COGS subledger-vs-GL rounding sweep: DR COGS GBP 0\.47 /)
  const debit = journal.lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  const credit = journal.lines.reduce((s, l) => s + (l.credit ?? 0), 0)
  assert.equal(debit, credit)
})

test('sweep journal: GL above subledger → CR COGS / DR Rounding', () => {
  const journal = buildAccountReconciliationSweepJournal(availableResult(999.5, 1000.0), SWEEP_ACCOUNTS)
  assert.ok(journal)
  assert.equal(journal.subledgerHigher, false)
  assert.deepEqual(journal.lines, [
    { accountCode: '5000', description: 'COGS subledger reconciliation 2026-06-20', credit: 0.5 },
    { accountCode: '7999', description: 'COGS subledger reconciliation 2026-06-20', debit: 0.5 },
  ])
})

test('sweep journal: material gap flags (no journal); blank rounding account opts out', () => {
  assert.equal(buildAccountReconciliationSweepJournal(availableResult(1050.0, 1000.0), SWEEP_ACCOUNTS), null)
  assert.equal(
    buildAccountReconciliationSweepJournal(availableResult(1000.47, 1000.0), { ...SWEEP_ACCOUNTS, roundingAccount: '  ' }),
    null,
  )
  assert.equal(
    buildAccountReconciliationSweepJournal({ available: false, reason: 'no_gl_snapshot' }, SWEEP_ACCOUNTS),
    null,
  )
})
