import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPaymentAgainstListing,
  databaseLedgerFence,
  registrationBindsToPaidState,
  zeroPaidIsProvenReversal,
  type PaidStateBinding,
  type RegisteredPaymentRow,
} from '@/lib/connectors/xero/invoice-delta'

/**
 * o3d-psrx r6 (Codex HIGH 2) — WHAT THE SURVIVING MARKER BUYS, AND WHAT A PART-COVERED ORDER READS AS.
 *
 * `addPayment` now clears `SalesOrder.unregisteredPaidAt` only when the non-refund receipts on the
 * order COVER its total (r6), where r5 cleared it on any non-refund receipt at all. The write-site
 * halves of that rule are proved in tests/sales-add-payment-clears-paid-provenance.test.ts. This file
 * is the other end: what the column being kept — or destroyed by a penny — actually decides.
 *
 * THE DECISION IT DECIDES is not the one the finding's narration suggests, and saying so plainly is
 * the point of this file. A part-covered order's own registration binds to the current paid state
 * either way, so the marker does NOT stand between a GBP 1 registration going missing and the ledger's
 * zero being read (that gap is the part-payment-versus-removal residual the QuickBooks poller's header
 * already files, and nothing here narrows or widens it). What the marker decides is the OTHER half of
 * `registrationBindsToPaidState`: with the marker gone, `unregisteredPaidAt == null` is "this flag was
 * never off-ledger", and EVERY registration the order has ever carried — including one from a paid
 * episode that was reversed — is handed back to the CURRENT paid flag. That is r4's Codex HIGH exactly,
 * re-created by r5's over-wide clearing, and a penny of receipt was enough to do it.
 *
 * THE STEADY STATE OF AN ORDER THAT IS PART-COVERED FOR EVER, enumerated so nobody has to infer it:
 *
 *   receipt recorded, not yet registered   RECEIPT_NOT_REGISTERED  — WITHHELD. IMS's own silence.
 *   its registration in flight             REGISTRATION_UNDECIDED  — WITHHELD.
 *   its registration posted and bound      the LEDGER decides (STILL_HELD / GONE / …). The marker is
 *                                          not consulted, because something posted is left to speak.
 *   nothing posted is left to speak        PAID_WITHOUT_LEDGER_RECEIPT — WITHHELD, which is exactly
 *                                          what the remaining uncovered balance is: a paid flag with
 *                                          nothing in any ledger behind it.
 *
 * So the order is neither silently registered in full nor permanently withheld. It is withheld only
 * in the state its own sentence describes, and the moment a bound registration exists the ledger's
 * answer is taken.
 */

const READ_AT = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))

/** This paid episode began here — the order was marked paid by hand, off-ledger, for GBP 100. */
const EPISODE_BEGAN = new Date('2026-08-20T10:00:00.000Z')
/** …and this registration completed an hour BEFORE it: it belongs to a paid state that was reversed. */
const STALE_COMPLETION = new Date('2026-08-20T09:00:00.000Z')

const staleRegistration: RegisteredPaymentRow = {
  id: 'log_stale',
  status: 'SYNCED',
  externalTransactionId: 'PAY-OLD',
  syncedAt: STALE_COMPLETION,
  // Database-minted and equal, so `databaseStampedCompletion` vouches for it: this row is not
  // undecidable, it is decidably OLD. That is what makes the episode test the only thing left.
  syncedAtDatabaseClock: STALE_COMPLETION,
  // Against the document the order still points at. Only the EPISODE separates it from this flag.
  registeredAgainstInvoiceId: 'inv_1',
}

const withMarker: PaidStateBinding = { accountingInvoiceId: 'inv_1', unregisteredPaidAt: EPISODE_BEGAN }
const markerErased: PaidStateBinding = { accountingInvoiceId: 'inv_1', unregisteredPaidAt: null }

test('[o3d-psrx r6] the marker is the ONLY thing holding a previous episode\'s registration off this flag', () => {
  assert.equal(
    registrationBindsToPaidState(staleRegistration, STALE_COMPLETION, withMarker),
    false,
    'a registration that completed before this paid episode began cannot speak for it',
  )
  assert.equal(
    registrationBindsToPaidState(staleRegistration, STALE_COMPLETION, markerErased),
    true,
    'THE FINDING: with the marker gone the same row binds — nothing else in the row or the state '
    + 'distinguishes it, so a penny of receipt that clears the marker hands it back',
  )
})

test('[o3d-psrx r6] and that difference is a CHARGEBACK, not a change of wording', () => {
  // The ledger has been read in full and holds nothing on this document. Both arms below see the
  // identical evidence; they differ only in whether the off-ledger marker survived a partial receipt.
  const listedNothing = new Set<string>()

  const kept = classifyRegisteredPaymentAgainstListing(
    listedNothing, [staleRegistration], READ_AT, [], true, withMarker,
  )
  assert.equal(kept.verdict, 'PAID_WITHOUT_LEDGER_RECEIPT')
  assert.equal(zeroPaidIsProvenReversal(kept), false,
    'the flag was entered off-ledger and the stale row says nothing about it — paidAt is LEFT SET')

  const erased = classifyRegisteredPaymentAgainstListing(
    listedNothing, [staleRegistration], READ_AT, [], false, markerErased,
  )
  assert.equal(erased.verdict, 'GONE')
  assert.equal(zeroPaidIsProvenReversal(erased), true,
    'THE COST: the reversed episode\'s payment is read as THIS flag\'s payment, found missing, and a '
    + 'chargeback credit note is raised against a sale nobody reversed')
})

test('[o3d-psrx r6] the part-covered order\'s OWN receipt is not withheld by the surviving marker', () => {
  // The marker is asked only when nothing posted is left to speak. A receipt whose registration
  // posted AFTER the episode began binds normally, so keeping the marker does not park the order:
  // the ledger's own answer is taken, exactly as it is for a fully covered one.
  const ownRegistration: RegisteredPaymentRow = {
    id: 'log_own',
    status: 'SYNCED',
    externalTransactionId: 'PAY-NEW',
    syncedAt: new Date('2026-08-20T11:00:00.000Z'),
    syncedAtDatabaseClock: new Date('2026-08-20T11:00:00.000Z'),
    registeredAgainstInvoiceId: 'inv_1',
  }
  const stillHeld = classifyRegisteredPaymentAgainstListing(
    new Set(['pay-new']), [ownRegistration], READ_AT, [], true, withMarker,
  )
  assert.equal(stillHeld.verdict, 'STILL_HELD',
    'the marker is standing and the ledger still decided — it is not a permanent withholding')

  // And before that registration exists, the receipt itself is what withholds — IMS\'s own silence,
  // named by payment id so an operator can see which receipt the poller is waiting on.
  const notYet = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [], READ_AT, ['pay-new'], true, withMarker,
  )
  assert.equal(notYet.verdict, 'RECEIPT_NOT_REGISTERED')
  assert.equal(zeroPaidIsProvenReversal(notYet), false)
})
