import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RECURRING_SWEEP_CAP, evaluateAccountGlReconciliation, guardRecurringSweep } from '@/lib/domain/accounting/account-gl-reconciliation'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import { inventoryGlReconciliationFinding } from '@/lib/domain/accounting/invariants'
import { evaluateSubledgerCrossCheck } from '@/lib/domain/accounting/subledger-journal-cross-check'
import { inventoryGlVarianceFromSnapshot } from '@/lib/domain/inventory/inventory-costing-reports'
import { toDecimal } from '@/lib/domain/math/decimal'

// ACC-M7: a residue that is within the per-day limit every day is a recurring error, not rounding.
test('ACC-M7: a sweep that takes the trailing swept total past the cap is a flag, not a sweep', () => {
  const day = evaluateAccountGlReconciliation({ subledgerValue: 100.9, glBalance: 100 })
  assert.equal(day.action, 'sweep', 'within the £1 per-day limit on its own')
  assert.equal(guardRecurringSweep(day, { priorSweptNet: 0, cap: DEFAULT_RECURRING_SWEEP_CAP }).action, 'sweep')
  const capped = guardRecurringSweep(day, { priorSweptNet: 4.5, cap: DEFAULT_RECURRING_SWEEP_CAP })
  assert.equal(capped.action, 'flag')
  assert.equal(capped.recurringSweepCap?.projectedNet, 5.4, 'the cap is named on the result, so it is not reported as a gap beyond tolerance')
  // Signed: the opposite direction brings the net back under the cap.
  assert.equal(guardRecurringSweep(day, { priorSweptNet: -4.5, cap: DEFAULT_RECURRING_SWEEP_CAP }).action, 'sweep')
  // Only a sweep is downgraded.
  const balanced = evaluateAccountGlReconciliation({ subledgerValue: 100, glBalance: 100 })
  assert.equal(guardRecurringSweep(balanced, { priorSweptNet: 99, cap: 5 }).action, 'balanced')
})

function journalDateOf(upserts: Array<{ create: { journalDate: Date } }>): string {
  return upserts[0]!.create.journalDate.toISOString().slice(0, 10)
}

test('ACC-M8: a COGS sub-ledger row for a Date is dated on the London business day, as its journal is', async () => {
  const upserts: Array<{ create: { journalDate: Date } }> = []
  const client = { cogsSubledgerMovement: { upsert: async (a: { create: { journalDate: Date } }) => { upserts.push(a); return {} } } } as never
  // 00:30 BST on 2 July is 23:30 UTC on 1 July: the journal is dated the 2nd.
  await recordCogsSubledgerMovement(client, { sourceType: 'DISPATCH', sourceRef: 's', idempotencyKey: 'k', baseDelta: 5, journalDate: new Date('2026-07-01T23:30:00.000Z') })
  assert.equal(journalDateOf(upserts), '2026-07-02')
})

test('ACC-M8: a transit sub-ledger row for a Date is dated on the London business day', async () => {
  const upserts: Array<{ create: { journalDate: Date } }> = []
  const client = { transitSubledgerMovement: { upsert: async (a: { create: { journalDate: Date } }) => { upserts.push(a); return {} } } } as never
  await recordTransitSubledgerMovement(client, { sourceType: 'STOCK_RECEIPT', sourceRef: 's', idempotencyKey: 'k', baseDelta: -5, journalDate: new Date('2026-07-01T23:30:00.000Z') })
  assert.equal(journalDateOf(upserts), '2026-07-02')
})

test('ACC-M9: the manufacturing reclass is a recordable COGS sub-ledger source', async () => {
  const upserts: Array<{ create: { sourceType: string; baseDelta: unknown } }> = []
  const client = { cogsSubledgerMovement: { upsert: async (a: { create: { sourceType: string; baseDelta: unknown } }) => { upserts.push(a); return {} } } } as never
  await recordCogsSubledgerMovement(client, { sourceType: 'MANUFACTURING_RECLASS', sourceRef: 'po1', idempotencyKey: 'MFG_RECLASS:po1:x', baseDelta: -12.5, journalDate: '2026-07-02' })
  assert.equal(upserts[0]!.create.sourceType, 'MANUFACTURING_RECLASS')
  assert.equal(Number(upserts[0]!.create.baseDelta), -12.5)
})

// ACC-M8: the independent cross-check.
test('ACC-M8: a sub-ledger that missed a queued journal disagrees with the queue; matching totals agree', () => {
  const missing = evaluateSubledgerCrossCheck({ ledgerNet: 100, queuedNet: 130, journalCount: 3, ledgerRowCount: 2, unreadableJournalCount: 0 })
  assert.equal(missing.agrees, false)
  assert.equal(missing.delta, -30)
  const rounding = evaluateSubledgerCrossCheck({ ledgerNet: 100.004, queuedNet: 100, journalCount: 1, ledgerRowCount: 1, unreadableJournalCount: 0 })
  assert.equal(rounding.agrees, true)
  const unreadable = evaluateSubledgerCrossCheck({ ledgerNet: 100, queuedNet: 100, journalCount: 1, ledgerRowCount: 1, unreadableJournalCount: 1 })
  assert.equal(unreadable.agrees, false, 'an unreadable journal cannot be called agreeing')
})

// ACC-M10: Allocated Inventory is part of the GL on-hand value.
test('ACC-M10: the costing report GL variance compares the valuation with Inventory + Allocated Inventory', () => {
  const inv = { balanceDate: new Date('2026-10-25T00:00:00.000Z'), amountBase: toDecimal('900.00') }
  const alloc = { balanceDate: new Date('2026-10-25T00:00:00.000Z'), amountBase: toDecimal('100.00') }
  const r = inventoryGlVarianceFromSnapshot(inv, '2026-10-25', toDecimal('1000.00'), '630', { allocated: { accountCode: '631', snapshot: alloc } })
  assert.equal(r.glBalanceBase?.toFixed(2), '1000.00')
  assert.equal(r.glVarianceBase?.toFixed(2), '0.00', 'was -100.00 with Inventory alone')
})

test('ACC-M10: a missing or differently dated Allocated Inventory balance blanks the variance, never compares Inventory alone', () => {
  const inv = { balanceDate: new Date('2026-10-25T00:00:00.000Z'), amountBase: toDecimal('900.00') }
  const stale = { balanceDate: new Date('2026-10-24T00:00:00.000Z'), amountBase: toDecimal('100.00') }
  for (const snapshot of [null, stale]) {
    const r = inventoryGlVarianceFromSnapshot(inv, '2026-10-25', toDecimal('1000.00'), '630', { allocated: { accountCode: '631', snapshot } })
    assert.equal(r.glVarianceBase, null)
    assert.match(r.notices[0]!, /Allocated Inventory account 631/)
  }
})


// o3d-hqvrp.43: a sweep withheld by the recurring cap is its own warning, never a critical gap "beyond rounding tolerance".
test('recurring-sweep cap: reported as a warning with its own code and wording', () => {
  const day = evaluateAccountGlReconciliation({ subledgerValue: 100.9, glBalance: 100 })
  const capped = guardRecurringSweep(day, { priorSweptNet: 4.5, cap: DEFAULT_RECURRING_SWEEP_CAP })
  const finding = inventoryGlReconciliationFinding({ available: true, balanceDate: '2026-11-17', ...capped })
  assert.equal(finding?.severity, 'warning')
  assert.equal(finding?.code, 'inventory_recurring_residue_not_swept')
  assert.match(finding!.message, /Recurring small residue not swept \(cap reached\)/)
  assert.doesNotMatch(finding!.message, /beyond rounding tolerance/)
})

test('recurring-sweep cap: a gap over the per-day limit stays critical, and a sweep or balanced result raises nothing', () => {
  const gap = evaluateAccountGlReconciliation({ subledgerValue: 105, glBalance: 100 })
  assert.equal(inventoryGlReconciliationFinding({ available: true, balanceDate: '2026-11-17', ...gap })?.severity, 'critical')
  assert.equal(inventoryGlReconciliationFinding({ available: true, balanceDate: '2026-11-17', ...evaluateAccountGlReconciliation({ subledgerValue: 100.5, glBalance: 100 }) }), null)
  assert.equal(inventoryGlReconciliationFinding({ available: false, reason: 'no_subledger_snapshot' }), null)
})
