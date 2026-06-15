import assert from 'node:assert/strict'
import test from 'node:test'

import { selectCreditNotesNeedingAllocation, type CreditNoteAllocationCandidate } from '@/lib/connectors/xero/sync-processor'

// audit-w77e: the cron sweep enqueues a PURCHASE_CREDIT_NOTE_ALLOCATION for posted
// credit notes whose bill synced to Xero only after the credit posted (so v08m's
// at-post enqueue was skipped). selectCreditNotesNeedingAllocation is the pure
// filter: keep posted credits that have a credit id + a bill id but NO allocation
// row yet.

function candidate(over: Partial<CreditNoteAllocationCandidate> = {}): CreditNoteAllocationCandidate {
  return {
    id: 'cn-1',
    accountingCreditNoteId: 'xero-cn-1',
    amountForeign: 120,
    purchaseInvoice: { accountingInvoiceId: 'xero-inv-1' },
    ...over,
  }
}

test('selects a posted credit with a bill id and no existing allocation row', () => {
  const out = selectCreditNotesNeedingAllocation([candidate()], new Set())
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    supplierCreditNoteId: 'cn-1',
    creditNoteId: 'xero-cn-1',
    accountingInvoiceId: 'xero-inv-1',
    amount: 120,
  })
})

test('skips a credit that already has an allocation row of any status', () => {
  const out = selectCreditNotesNeedingAllocation([candidate()], new Set(['cn-1']))
  assert.equal(out.length, 0)
})

test('skips when the credit or bill external id is missing (defensive)', () => {
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ accountingCreditNoteId: null })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ purchaseInvoice: null })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ purchaseInvoice: { accountingInvoiceId: null } })], new Set()).length, 0)
})

test('skips a non-positive or non-finite amount (Codex review — no useless row)', () => {
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ amountForeign: 0 })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ amountForeign: -5 })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ amountForeign: Number.NaN })], new Set()).length, 0)
})

test('coerces a Decimal-like amount to a number', () => {
  const out = selectCreditNotesNeedingAllocation(
    [candidate({ amountForeign: { toString: () => '99.5' } as unknown as number })],
    new Set(),
  )
  assert.equal(out[0].amount, 99.5)
})

test('filters a mixed batch — keeps only the fillable gaps', () => {
  const batch: CreditNoteAllocationCandidate[] = [
    candidate({ id: 'a' }), // fillable
    candidate({ id: 'b' }), // already allocated
    candidate({ id: 'c', accountingCreditNoteId: null }), // not posted to Xero
    candidate({ id: 'd' }), // fillable
  ]
  const out = selectCreditNotesNeedingAllocation(batch, new Set(['b']))
  assert.deepEqual(out.map((o) => o.supplierCreditNoteId), ['a', 'd'])
})
