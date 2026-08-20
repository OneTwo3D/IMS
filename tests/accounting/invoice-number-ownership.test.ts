import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideInvoiceNumberPost,
  type InvoiceNumberLookup,
  type LedgerInvoiceClaim,
} from '@/lib/domain/accounting/invoice-number-ownership'

// ---------------------------------------------------------------------------
// o3d-k26m.5 — the ownership fence on the sales-invoice CREATE.
//
// `POST /Invoices` is update-or-create on InvoiceNumber. o3d-k26m.1 made the number WooCommerce's
// own `_wcpdf_invoice_number`, which the outgoing xeroom plugin is posting to the SAME live
// organisation today — so a create for an already-invoiced order does not duplicate, it silently
// REPLACES xeroom's invoice. Round 1 mitigated that with documentation. These pin the refusal.
//
// Every assertion is on the specific verdict and the specific number/reason, never on "it
// returned something falsy": a fence that refuses for the wrong reason is a fence that will let
// the wrong thing through the day the reason changes.
// ---------------------------------------------------------------------------

const OURS = 'xero-invoice-id-ours'
const THEIRS = 'xero-invoice-id-theirs'

function claim(invoiceId: string, overrides: Partial<LedgerInvoiceClaim> = {}): LedgerInvoiceClaim {
  return {
    invoiceId,
    invoiceNumber: '164981',
    status: 'AUTHORISED',
    contactName: 'A Customer',
    total: 120.5,
    ...overrides,
  }
}

function heldBy(...claims: LedgerInvoiceClaim[]): InvoiceNumberLookup {
  return { ok: true, claims }
}

const UNCLAIMED: InvoiceNumberLookup = { ok: true, claims: [] }

test('a number nobody holds is posted', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: UNCLAIMED,
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, true)
  assert.equal(decision.post && decision.basis, 'unclaimed')
})

test('the number held by the document this order is linked to is our own — post', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(OURS)),
    ownedInvoiceId: OURS,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, true)
  assert.equal(decision.post && decision.basis, 'own-document')
  assert.equal(decision.post && decision.claimedInvoiceId, OURS)
})

test('a number held by a document IMS does not own is REFUSED, naming the number and the overwrite', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(THEIRS)),
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_FOREIGN_DOCUMENT')
  // An ownership verdict is not a transient condition; retrying spends API budget on the same answer.
  assert.equal(decision.post === false && decision.retryable, false)
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /164981/)
  assert.match(reason, /xero-invoice-id-theirs/)
  assert.match(reason, /silently REPLACE/)
  // The operator has to be told which plugin is the expected cause, or "refused" is a dead end.
  assert.match(reason, /xeroom plugin already/)
})

test('a number held by a DIFFERENT document than the one this order is linked to is refused', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(THEIRS)),
    ownedInvoiceId: OURS,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT')
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /already linked to ledger document xero-invoice-id-ours/)
  assert.match(reason, /held by a DIFFERENT document/)
})

test('a VOIDED document still holds its number, and the create is refused with that reason', () => {
  for (const status of ['VOIDED', 'DELETED', 'voided']) {
    const decision = decideInvoiceNumberPost({
      invoiceNumber: '164981',
      lookup: heldBy(claim(THEIRS, { status })),
      ownedInvoiceId: null,
      orderLabel: 'order WC-164981',
    })
    assert.equal(decision.post, false, `${status} must not post`)
    assert.equal(
      decision.post === false && decision.code,
      'NUMBER_HELD_BY_VOIDED_DOCUMENT',
      `${status} must be refused as a voided holder, not as a foreign document`,
    )
    assert.match(decision.post === false ? decision.reason : '', new RegExp(`a ${status} document`))
  }
})

test('an unreachable ledger REFUSES and says nothing was sent — it never reads as "unclaimed"', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: { ok: false, error: 'Not connected to Xero' },
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'LEDGER_LOOKUP_UNAVAILABLE')
  // The ONE retryable refusal: nothing was decided, so the outbox must run it again.
  assert.equal(decision.post === false && decision.retryable, true)
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /Not connected to Xero/)
  assert.match(reason, /NOTHING WAS SENT/)
})

test('an empty invoice number is refused rather than fenced against nothing', () => {
  for (const invoiceNumber of [null, undefined, '', '   ']) {
    const decision = decideInvoiceNumberPost({
      invoiceNumber,
      lookup: UNCLAIMED,
      ownedInvoiceId: null,
      orderLabel: 'order WC-164981',
    })
    assert.equal(decision.post, false, `${JSON.stringify(invoiceNumber)} must not post`)
    assert.equal(decision.post === false && decision.code, 'NO_INVOICE_NUMBER')
    assert.equal(decision.post === false && decision.retryable, false)
  }
})

// ---------------------------------------------------------------------------
// Codex round 3, CRITICAL: a pre-request record does not identify the holder.
//
// Round 2 posted on this inference: "nobody held this number when this row set out to post it;
// somebody holds it now; therefore the holder is ours." The record is a fact about the LOOKUP's
// moment and cannot identify a holder — and the licence is only ever reached when the number IS
// held. Once xeroom is removed the only documents that can hold one of these numbers are the
// ~14,415 it already posted, so "held now, unclaimed then" means THE LOOKUP MISSED ONE: the licence
// would fire exactly where the fence has already failed, repeat the overwrite, and remove the
// refusal that would have exposed it. It was the only wrong answer in the fence that ended in an
// overwrite instead of a refusal.
// ---------------------------------------------------------------------------

test('a previous attempt by THIS row does not license posting over whoever holds the number now', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(THEIRS)),
    ownedInvoiceId: null,
    attemptedInvoiceNumber: '164981',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_FOREIGN_DOCUMENT')
  assert.equal(decision.post === false && decision.retryable, false)
})

test('the attempt is named in the refusal, as a lead to check and explicitly not as proof', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(THEIRS)),
    ownedInvoiceId: null,
    attemptedInvoiceNumber: '164981',
    orderLabel: 'order WC-164981',
  })
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /already set out to post under this number once before/)
  assert.match(reason, /a lost response looks exactly like this/)
  // The operator must not read the lead as a verdict.
  assert.match(reason, /NOT proof/)
  assert.match(reason, /link it to this order and the next retry will UPDATE it/)
})

test('an attempt on a DIFFERENT number is not even mentioned', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(THEIRS)),
    ownedInvoiceId: null,
    // The payload's number moved after the attempt was recorded. It says nothing about 164981.
    attemptedInvoiceNumber: '164980',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_FOREIGN_DOCUMENT')
  assert.doesNotMatch(decision.post === false ? decision.reason : '', /already set out to post/)
})

test('an attempt cannot override the order’s own recorded document id', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(THEIRS)),
    // The order IS linked to a document, and it is not the one holding the number.
    ownedInvoiceId: OURS,
    attemptedInvoiceNumber: '164981',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT')
})

test('an attempt does not license posting onto a VOIDED document', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(THEIRS, { status: 'VOIDED' })),
    ownedInvoiceId: null,
    attemptedInvoiceNumber: '164981',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_VOIDED_DOCUMENT')
})

// ---------------------------------------------------------------------------
// Codex round 3: the lookup answers with the WHOLE set of holders, so the decision has to be one
// about a set. Round 2 took `find()`'s first match — and Xero pages oldest-first, so "first" was
// systematically the OLDEST document holding the number.
// ---------------------------------------------------------------------------

test('a live holder is not masked by a voided predecessor that comes back ahead of it', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    // Oldest first, exactly as Xero returns them: the voided predecessor, then the live document.
    lookup: heldBy(claim('xero-invoice-id-old', { status: 'VOIDED' }), claim(OURS)),
    ownedInvoiceId: OURS,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, true)
  assert.equal(decision.post && decision.basis, 'own-document')
  assert.equal(decision.post && decision.claimedInvoiceId, OURS)
})

test('a voided predecessor alongside a FOREIGN live holder still refuses, and both are named', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim('xero-invoice-id-old', { status: 'DELETED' }), claim(THEIRS)),
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_FOREIGN_DOCUMENT')
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /xero-invoice-id-theirs/)
  assert.match(reason, /1 voided\/deleted document also holds that number/)
  assert.match(reason, /xero-invoice-id-old/)
})

test('two LIVE documents holding the number is refused: which one an upsert replaces is unknowable', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim(OURS), claim(THEIRS)),
    // Even owning one of them is not enough — the create addresses the NUMBER, not the id.
    ownedInvoiceId: OURS,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_MULTIPLE_DOCUMENTS')
  assert.equal(decision.post === false && decision.retryable, false)
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /2 live documents/)
  assert.match(reason, /xero-invoice-id-ours/)
  assert.match(reason, /xero-invoice-id-theirs/)
  assert.match(reason, /including when one of them is ours/)
})

test('several voided holders and no live one is a voided refusal that names the extras', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: heldBy(claim('xero-invoice-id-old', { status: 'VOIDED' }), claim(THEIRS, { status: 'DELETED' })),
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_VOIDED_DOCUMENT')
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /a VOIDED document \(invoice xero-invoice-id-old/)
  assert.match(reason, /1 voided\/deleted document also holds that number \(invoice xero-invoice-id-theirs/)
})

// ---------------------------------------------------------------------------
// An unaskable number is not an unreachable ledger (Codex round 4).
// ---------------------------------------------------------------------------

test('a number the ledger’s filter cannot express is refused PERMANENTLY, with its own remedy', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: 'INV,1',
    lookup: { ok: false, unaskable: true, error: 'invoice number "INV,1" contains a comma, which Xero\'s InvoiceNumbers filter reads as the separator between two numbers' },
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_NOT_ASKABLE')
  // Waiting changes nothing: the number has to change, or a human has to post the invoice.
  assert.equal(decision.post === false && decision.retryable, false)
  const reason = decision.post === false ? decision.reason : ''
  assert.match(reason, /NOTHING WAS SENT/)
  assert.match(reason, /comma/)
  assert.match(reason, /_wcpdf_invoice_number/)
  assert.doesNotMatch(reason, /reachable again/, 'this is not the wait-for-the-connection refusal')
})

test('an ordinary lookup failure is still the RETRYABLE one — the two must not be conflated', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: { ok: false, error: 'HTTP 503' },
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post === false && decision.code, 'LEDGER_LOOKUP_UNAVAILABLE')
  assert.equal(decision.post === false && decision.retryable, true)
})
