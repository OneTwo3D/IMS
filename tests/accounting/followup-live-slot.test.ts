import assert from 'node:assert/strict'
import test from 'node:test'

import { liveRowOccupiesFollowUpSlot } from '@/lib/domain/accounting/followup-idempotency'

/**
 * o3d-hbgo. `hasExistingSyncLog` decided "this follow-up already exists" from
 * (connector, type, referenceType, referenceId) alone, and the partial unique index was scoped the same
 * way — neither consulted the external document the follow-up TARGETS. So an order whose invoice was
 * deleted and re-posted kept the SYNCED INVOICE_PAYMENT row from the first invoice, the payment for the
 * second was skipped as already-handled, and the replacement was never settled. Silently: a skip logs
 * nothing.
 *
 * The row-level dedup now uses the SAME anchors as the remote idempotency token (o3d-h2wx), because a
 * dedup scoped more coarsely than the token can only discard work the token could already tell apart.
 */

test('o3d-hbgo: a live row against a DIFFERENT invoice does not own the replacement s follow-up', () => {
  // THE DEFECT THIS CLOSES. Before, this returned true from the row count alone and the payment for
  // INV-2 was never enqueued.
  assert.equal(
    liveRowOccupiesFollowUpSlot({ accountingInvoiceId: 'INV-1', amount: 100 }, { accountingInvoiceId: 'INV-2', amount: 100 }),
    false,
  )
})

test('a live row against the SAME invoice still owns the slot', () => {
  // The dedup must not become vacuous: this is the concurrent-enqueue case the check exists for.
  assert.equal(
    liveRowOccupiesFollowUpSlot({ accountingInvoiceId: 'INV-1', amount: 100 }, { accountingInvoiceId: 'INV-1', amount: 100 }),
    true,
  )
})

test('a live row with NO recorded anchors owns the slot, whatever we are about to enqueue', () => {
  // We cannot tell what it targeted, and skipping a possibly-duplicate payment is recoverable where
  // posting one is not. Deliberately STRICTER than the database index, which gives unanchored rows
  // their own COALESCE('') slot: the application guard may exceed the constraint that backs it, never
  // fall short of it.
  assert.equal(liveRowOccupiesFollowUpSlot({ amount: 100 }, { accountingInvoiceId: 'INV-2' }), true)
  assert.equal(liveRowOccupiesFollowUpSlot(null, { accountingInvoiceId: 'INV-2' }), true)
})

test('a credit-note allocation is separated by the credit it allocates, not only the bill', () => {
  // PURCHASE_CREDIT_NOTE_ALLOCATION dereferences BOTH ids, so both anchor it: two different credits
  // allocated to one bill are two different remote artefacts.
  assert.equal(
    liveRowOccupiesFollowUpSlot(
      { creditNoteId: 'CN-1', accountingInvoiceId: 'BILL-1' },
      { creditNoteId: 'CN-2', accountingInvoiceId: 'BILL-1' },
    ),
    false,
  )
})

test('anchors are compared element-wise, so a separator inside an id cannot fake a match', () => {
  // Joining the anchors into one string would make ('A:B', '') and ('A', 'B') indistinguishable, and an
  // external id is not ours to assume anything about.
  assert.equal(
    liveRowOccupiesFollowUpSlot(
      { accountingInvoiceId: 'A:B', creditNoteId: '' },
      { accountingInvoiceId: 'A', creditNoteId: 'B' },
    ),
    false,
  )
})

test('a whitespace-padded anchor is the same anchor', () => {
  // The stored payload is JSON written by several call sites; trimming is what stops a stray space from
  // reading as a different document and re-posting a payment.
  assert.equal(
    liveRowOccupiesFollowUpSlot({ accountingInvoiceId: ' INV-1 ' }, { accountingInvoiceId: 'INV-1' }),
    true,
  )
})
