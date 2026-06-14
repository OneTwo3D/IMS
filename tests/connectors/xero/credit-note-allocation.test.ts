import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCreditNoteAllocationAmount } from '@/lib/connectors/xero/credit-notes'

// audit-v08m: the amount applied when allocating a supplier credit note to its
// bill is capped at the credit's un-allocated balance AND the bill's outstanding
// balance, so Xero never rejects an over-allocation (which would retry forever).

test('allocation amount is capped by the smallest of requested / remaining credit / amount due', () => {
  // Bill owes the least → cap at the bill.
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 120, remainingCredit: 120, amountDue: 80 }), 80)
  // Credit has the least remaining → cap at the credit.
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 120, remainingCredit: 50, amountDue: 80 }), 50)
  // Requested is the least → honour the request.
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 30, remainingCredit: 50, amountDue: 80 }), 30)
})

test('allocation amount is 0 when nothing is left to apply (idempotent no-op)', () => {
  // Credit already fully allocated (retry after success).
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 120, remainingCredit: 0, amountDue: 80 }), 0)
  // Bill already settled.
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 120, remainingCredit: 120, amountDue: 0 }), 0)
  // Negative / non-finite guarded.
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 120, remainingCredit: -5, amountDue: 80 }), 0)
  assert.equal(resolveCreditNoteAllocationAmount({ requested: Number.NaN, remainingCredit: 120, amountDue: 80 }), 0)
})

test('allocation amount is rounded to 2dp so float noise cannot exceed the cap', () => {
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 33.333333, remainingCredit: 100, amountDue: 100 }), 33.33)
  assert.equal(resolveCreditNoteAllocationAmount({ requested: 10.005, remainingCredit: 100, amountDue: 100 }), 10.01)
})
