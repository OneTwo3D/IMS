import assert from 'node:assert/strict'
import test from 'node:test'

import { journalSentPennyImbalance } from '@/lib/domain/accounting/journal-balance'
import { reverseChargeSwapMissing, SalesInvoiceReverseChargeSwapNotSetError, SalesInvoiceDoesNotReconcileError } from '@/lib/domain/sales/sales-invoice-reconciliation'

// o3d-hqvrp.59 — the enqueue penny balance. Pure: nothing here touches a network or a database.

test('journalSentPennyImbalance: balanced, imbalanced and non-journal payloads', () => {
  assert.equal(journalSentPennyImbalance({ lines: [{ debit: 10.1 }, { credit: 10.1 }] }), 0)
  assert.equal(journalSentPennyImbalance({ lines: [{ debit: 33.333 }, { debit: 33.333 }, { debit: 33.334 }, { credit: 100 }] }), -1)
  assert.equal(journalSentPennyImbalance({ lines: [{ unitAmount: 5, quantity: 1 }] }), null)
  assert.equal(journalSentPennyImbalance({}), null)
  // Symmetric 3dp half-penny amounts: the wire's Math.round(12.345 * 100) is 1234 on both sides, so the wire sends it balanced and the enqueue must not refuse it.
  assert.equal(journalSentPennyImbalance({ lines: [{ debit: 12.345 }, { credit: 12.345 }] }), 0)
})

// o3d-hqvrp.53 — a reverse-charge line with the swap setting empty is refused.

test('reverseChargeSwapMissing: only a reverse-charge line with an empty setting', () => {
  const rc = [{ taxRate: { reverseCharge: true } }]
  assert.equal(reverseChargeSwapMissing(rc, ''), true)
  assert.equal(reverseChargeSwapMissing(rc, '  '), true)
  assert.equal(reverseChargeSwapMissing(rc, null), true)
  assert.equal(reverseChargeSwapMissing(rc, 'ECOUTPUTSERVICES'), false)
  assert.equal(reverseChargeSwapMissing([{ taxRate: { reverseCharge: false } }, { taxRate: null }], ''), false)
})

test('the refusal is a reconciliation refusal, so every caller that refuses a mismatch refuses it', () => {
  const err = new SalesInvoiceReverseChargeSwapNotSetError('GBP')
  assert.ok(err instanceof SalesInvoiceDoesNotReconcileError)
  assert.match(err.message, /reverse-charge sales tax type/)
})
