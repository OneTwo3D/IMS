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
 * o3d-psrx r5 (Codex HIGH 3) — A REGISTRATION WHOSE PAYLOAD NAMES NO DOCUMENT IS NOT AUTOMATICALLY
 * UNBINDABLE, AND THE ONE THAT IS STILL WITHHELD.
 *
 * Round 4 bound every registration to the document its PAYLOAD named. For a row from before that
 * field existed, or one an older release compacted to `{}`, the payload names nothing — and round 4
 * read that as "cannot be tied to any document", permanently. Codex's finding is the last clause of
 * that sentence: a payload is not the only evidence. When THE LEDGER ITSELF lists the registration's
 * payment on the document being examined, the ledger has answered "which document" directly, and it
 * is the authority on that question.
 *
 * WHY IT IS NOT MERELY A NICER VERDICT. `posted` is what the STILL_HELD test runs over. A listed but
 * "unbound" row never reached `posted`, so a document with a second registration that HAD been removed
 * reported GONE — a reversal admitted, `paidAt` cleared, a chargeback credit note raised — while the
 * ledger was still holding IMS's money on that very invoice. The fourth case below is that exact
 * shape and it is the reason this is a correctness fix rather than a relaxation.
 *
 * AND THE CONTROLS ARE THE POINT, as they were in r2. "Bind more rows" would pass the headline
 * assertions and destroy the reversal pass, so every case here is paired: a genuine chargeback on a
 * properly bound registration must still reverse, a payload naming a DIFFERENT document must still be
 * refused, and the residue — a payload-less row the ledger does NOT list — must still withhold,
 * because absence cannot identify a document.
 */

const READ_AT = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))
const EPISODE_BEGAN = new Date('2026-08-20T10:00:00.000Z')
const COMPLETED = new Date('2026-08-20T11:00:00.000Z')

/** A SYNCED registration the database stamped, finished before the ledger was read. */
const registration = (overrides: Partial<RegisteredPaymentRow> = {}): RegisteredPaymentRow => ({
  id: 'log_1',
  status: 'SYNCED',
  externalTransactionId: 'PAY-1',
  syncedAt: COMPLETED,
  syncedAtDatabaseClock: COMPLETED,
  ...overrides,
})

/** The paid flag under examination: this invoice, entered off-ledger at EPISODE_BEGAN. */
const offLedgerEpisode: PaidStateBinding = {
  accountingInvoiceId: 'INV-CURRENT',
  unregisteredPaidAt: EPISODE_BEGAN,
}

const ledgerSourcedFlag: PaidStateBinding = {
  accountingInvoiceId: 'INV-CURRENT',
  unregisteredPaidAt: null,
}

test('[o3d-psrx r5] a payload-less registration the LEDGER lists on this document discharges the marker', () => {
  const legacy = registration({ externalTransactionId: 'PAY-LEGACY', registeredAgainstInvoiceId: null })

  // The precondition this case exists for: the payload cannot name a document, so round 4's only
  // source of evidence is genuinely absent. If this ever stops holding the test is asserting nothing.
  assert.equal(legacy.registeredAgainstInvoiceId, null,
    'the row must actually be payload-less, or the ledger branch is never reached')

  const listed = new Set(['pay-legacy'])
  assert.equal(
    registrationBindsToPaidState(legacy, COMPLETED, offLedgerEpisode, listed), true,
    'the ledger names this payment on this document, so the row speaks for this paid flag',
  )

  const verdict = classifyRegisteredPaymentAgainstListing(
    listed, [legacy], READ_AT, [], /* paidWithoutLedgerReceipt */ true, offLedgerEpisode,
  )
  // The marker is DISCHARGED: the classifier stops consulting `unregisteredPaidAt` and lets the
  // ledger's own list decide. PAID_WITHOUT_LEDGER_RECEIPT here would be round 4's answer.
  assert.deepEqual(verdict, { verdict: 'STILL_HELD', paymentIds: ['PAY-LEGACY'] })
  assert.equal(zeroPaidIsProvenReversal(verdict), false)
})

test('[o3d-psrx r5] a payload-less registration the ledger does NOT list stays unbound — the residue', () => {
  const legacy = registration({ externalTransactionId: 'PAY-LEGACY', registeredAgainstInvoiceId: null })

  assert.equal(
    registrationBindsToPaidState(legacy, COMPLETED, ledgerSourcedFlag, new Set()), false,
    'absence cannot identify a document: "removed from this invoice" and "belonged to an invoice this '
    + 'order no longer has" produce the same silence',
  )

  // Withheld, not admitted. NOTHING_REGISTERED here would be the reversal round 4 refused to admit
  // and this change must not start admitting.
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set(), [legacy], READ_AT, [], false, ledgerSourcedFlag,
  )
  assert.deepEqual(verdict, { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] })
  assert.equal(zeroPaidIsProvenReversal(verdict), false)
})

test('[o3d-psrx r5] a ledger that enumerated NOTHING cannot identify a document either', () => {
  const legacy = registration({ registeredAgainstInvoiceId: null })

  // null is "absence cannot be established from this payload", never "no payments" — the distinction
  // LEDGER_DID_NOT_LIST_PAYMENTS exists for, and it must not be read as evidence of membership.
  assert.equal(registrationBindsToPaidState(legacy, COMPLETED, ledgerSourcedFlag, null), false)
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(null, [legacy], READ_AT, [], false, ledgerSourcedFlag),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] },
  )
})

test('[o3d-psrx r5] a ledger still holding a payload-less payment is not a reversal, even beside a removed one', () => {
  // THE OVER-ADMIT ROUND 4 LEFT OPEN. One registration names this document and its payment is gone;
  // the other names nothing and its payment is STILL THERE. Dropping the second from `posted` left
  // `stillHeld` empty over the first alone, so the whole document reported GONE.
  const removed = registration({ id: 'log_removed', externalTransactionId: 'PAY-GONE', registeredAgainstInvoiceId: 'INV-CURRENT' })
  const legacyHeld = registration({ id: 'log_legacy', externalTransactionId: 'PAY-HELD', registeredAgainstInvoiceId: null })

  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set(['pay-held']), [removed, legacyHeld], READ_AT, [], false, ledgerSourcedFlag,
  )
  assert.deepEqual(verdict, { verdict: 'STILL_HELD', paymentIds: ['PAY-HELD'] })
  assert.equal(zeroPaidIsProvenReversal(verdict), false,
    'clearing paidAt here re-arms Mark Paid over a payment the ledger is still holding')
})

test('[o3d-psrx r5] CONTROL: a genuine chargeback on a bound registration still reverses', () => {
  const bound = registration({ registeredAgainstInvoiceId: 'INV-CURRENT' })

  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set(), [bound], READ_AT, [], false, ledgerSourcedFlag,
  )
  assert.deepEqual(verdict, { verdict: 'GONE', paymentIds: ['PAY-1'] })
  assert.equal(zeroPaidIsProvenReversal(verdict), true,
    'the payment IMS registered against THIS document is absent from a list it could read fully')
})

test('[o3d-psrx r5] CONTROL: the ledger listing does not license a payload that names ANOTHER document', () => {
  // o3d-hbgo's rule is untouched. A row that DOES name a document is judged on that name, and a
  // listing cannot overrule it — otherwise the delete-and-re-post contamination returns by the door
  // this change opens.
  const replaced = registration({ registeredAgainstInvoiceId: 'INV-REPLACED' })
  assert.equal(registrationBindsToPaidState(replaced, COMPLETED, offLedgerEpisode, new Set(['pay-1'])), false)
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(new Set(['pay-1']), [replaced], READ_AT, [], true, offLedgerEpisode),
    { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' },
  )
})

test('[o3d-psrx r5] CONTROL: a ledger-identified row is still weighed against the paid EPISODE', () => {
  // Knowing WHICH document a payment sits on says nothing about WHICH paid episode of that document
  // it belongs to, so the episode test applies to ledger-identified rows on the same terms.
  const stale = registration({
    externalTransactionId: 'PAY-STALE',
    registeredAgainstInvoiceId: null,
    syncedAt: new Date('2026-08-20T09:00:00.000Z'),
    syncedAtDatabaseClock: new Date('2026-08-20T09:00:00.000Z'),
  })
  assert.ok(stale.syncedAt!.getTime() < EPISODE_BEGAN.getTime(),
    'the fixture must actually predate the episode, or the episode arm is never reached')
  assert.equal(
    registrationBindsToPaidState(stale, stale.syncedAt!, offLedgerEpisode, new Set(['pay-stale'])), false,
  )
})

test('[o3d-psrx r5] CONTROL: a payload-less row with no external transaction id names nothing at all', () => {
  const nameless = registration({ externalTransactionId: '  ', registeredAgainstInvoiceId: null })
  assert.equal(registrationBindsToPaidState(nameless, COMPLETED, ledgerSourcedFlag, new Set(['pay-1'])), false)
})
