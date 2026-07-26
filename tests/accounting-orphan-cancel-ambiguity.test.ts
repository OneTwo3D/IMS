import assert from 'node:assert/strict'
import test from 'node:test'

import { LIVE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/sales/order-delete-guard'
import { settlementStatus } from '@/lib/domain/accounting/settlement-status'

// o3d-sref. cancelOrphanedAccountingSyncRows retires an orphaned connector's queue. It treated
// PENDING and stale PROCESSING rows identically, moving both to CANCELLED — but they are not the
// same fact:
//
//   PENDING          nothing was sent. "The ledger was never told" is TRUE.
//   PROCESSING       the claim was TAKEN, so the processor may already have made its remote call —
//                    they post BEFORE persisting SYNCED and the externalTransactionId — and then
//                    died without recording the result.
//
// CANCELLED reads as deliberately abandoned and does not block a hard delete. So a stale PROCESSING
// row became a green light: the order was deleted, the old worker's request then succeeded, and the
// external document was left against an order that no longer existed. Exactly what the o3d-5r8 claim
// protocol exists to prevent, reached through the orphan sweep rather than a race on the claim.
//
// o3d-v7sy's "carries an external id, whatever the status" widening cannot reach this: at the moment
// of deletion the id does not exist yet.

test('CANCELLED_UNVERIFIED is in the delete guard\'s live set; plain CANCELLED is not (o3d-sref)', () => {
  const live: readonly string[] = LIVE_ACCOUNTING_SYNC_STATUSES

  assert.ok(
    live.includes('CANCELLED_UNVERIFIED'),
    'an unverifiable row must block deletion — a document may exist and nothing can prove otherwise',
  )
  assert.ok(
    !live.includes('CANCELLED'),
    'a provably pre-call PENDING retirement must still NOT block, or the sweep stops being useful',
  )
  // The two must be distinguishable at all — collapsing them is the bug.
  assert.notEqual('CANCELLED', 'CANCELLED_UNVERIFIED')
})

test('an unverified row reports UNKNOWN settlement, not NOT_SENT (o3d-sref)', () => {
  // The operator-facing half. Telling someone "the ledger was never told" invites them to re-send a
  // payment that may already be there — paying the invoice twice. The verdict has to say it is
  // unknown and that they must look.
  const verdict = settlementStatus({
    paidLocally: true,
    syncEnabled: true,
    // Required: with no posted document a payment cannot be attached, and the verdict correctly
    // says to chase the document instead — a different question from the one under test.
    documentPosted: true,
    payment: {
      status: 'CANCELLED_UNVERIFIED',
      externalTransactionId: null,
      errorMessage: 'abandoned mid-flight',
      retryCount: 1,
      amount: 100,
      paymentId: 'pay-1',
    },
    totalForeign: 100,
  })

  assert.equal(verdict.status, 'LEDGER_UNMATCHED')
  assert.equal(verdict.discrepancy, true)
  assert.match(verdict.detail, /UNKNOWN/)
  assert.match(verdict.detail, /twice/, 'and it warns against the double payment')
})

test('a plainly CANCELLED row still reports NOT_SENT (o3d-sref)', () => {
  // The contrast that makes the new state worth having: this one IS provable.
  const verdict = settlementStatus({
    paidLocally: true,
    syncEnabled: true,
    // Required: with no posted document a payment cannot be attached, and the verdict correctly
    // says to chase the document instead — a different question from the one under test.
    documentPosted: true,
    payment: {
      status: 'CANCELLED',
      externalTransactionId: null,
      errorMessage: 'orphaned',
      retryCount: 0,
      amount: 100,
      paymentId: 'pay-1',
    },
    totalForeign: 100,
  })

  assert.equal(verdict.status, 'NOT_SENT')
  assert.match(verdict.detail, /never told/)
})

test('an unverified row counts as HELD BY LEDGER when IMS shows unpaid (o3d-sref)', () => {
  // The mirrored disagreement: not paid here, but the ledger may hold a payment. Reporting a flat
  // UNPAID would hide it.
  const verdict = settlementStatus({
    paidLocally: false,
    syncEnabled: true,
    documentPosted: true,
    payment: {
      status: 'CANCELLED_UNVERIFIED',
      externalTransactionId: null,
      errorMessage: 'abandoned mid-flight',
      retryCount: 1,
      amount: 100,
      paymentId: 'pay-1',
    },
    totalForeign: 100,
  })

  assert.equal(verdict.status, 'LEDGER_UNMATCHED')
  assert.equal(verdict.discrepancy, true)
})
