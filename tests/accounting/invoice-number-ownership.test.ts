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

function claimOn(invoiceId: string, overrides: Partial<LedgerInvoiceClaim> = {}): InvoiceNumberLookup {
  return {
    ok: true,
    claim: {
      invoiceId,
      invoiceNumber: '164981',
      status: 'AUTHORISED',
      contactName: 'A Customer',
      total: 120.5,
      ...overrides,
    },
  }
}

const UNCLAIMED: InvoiceNumberLookup = { ok: true, claim: null }

test('a number nobody holds is posted, and the claim is recorded first', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: UNCLAIMED,
    ownedInvoiceId: null,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, true)
  assert.equal(decision.post && decision.basis, 'unclaimed')
  // The claim is what makes a lost response recoverable. Posting without recording it re-opens
  // the crash-after-post hole the fence would otherwise create.
  assert.equal(decision.post && decision.recordClaim, true)
})

test('the number held by the document this order is linked to is our own — post', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: claimOn(OURS),
    ownedInvoiceId: OURS,
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, true)
  assert.equal(decision.post && decision.basis, 'own-document')
  assert.equal(decision.post && decision.claimedInvoiceId, OURS)
  // Nothing to claim: the authoritative link already exists.
  assert.equal(decision.post && decision.recordClaim, false)
})

test('a number held by a document IMS does not own is REFUSED, naming the number and the overwrite', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: claimOn(THEIRS),
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
    lookup: claimOn(THEIRS),
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
      lookup: claimOn(THEIRS, { status }),
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
// The lost-response case. Without this the fence turns a self-healing retry into a permanent
// refusal: today the retry simply re-POSTs and the upsert lands back on the same document.
// ---------------------------------------------------------------------------

test('this row claimed the number before it posted, so the document now holding it is ours', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: claimOn(THEIRS),
    ownedInvoiceId: null,
    ownClaimInvoiceNumber: '164981',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, true)
  assert.equal(decision.post && decision.basis, 'own-claim')
  assert.equal(decision.post && decision.claimedInvoiceId, THEIRS)
  assert.equal(decision.post && decision.recordClaim, false)
})

test('a claim on a DIFFERENT number licenses nothing', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: claimOn(THEIRS),
    ownedInvoiceId: null,
    // The payload's number moved after the claim was taken. The claim says nothing about 164981.
    ownClaimInvoiceNumber: '164980',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_FOREIGN_DOCUMENT')
})

test('a claim cannot override the order’s own recorded document id', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: claimOn(THEIRS),
    // The order IS linked to a document, and it is not the one holding the number. The recorded
    // id is stronger evidence than a claim and must win.
    ownedInvoiceId: OURS,
    ownClaimInvoiceNumber: '164981',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT')
})

test('a claim does not license posting onto a VOIDED document', () => {
  const decision = decideInvoiceNumberPost({
    invoiceNumber: '164981',
    lookup: claimOn(THEIRS, { status: 'VOIDED' }),
    ownedInvoiceId: null,
    ownClaimInvoiceNumber: '164981',
    orderLabel: 'order WC-164981',
  })
  assert.equal(decision.post, false)
  assert.equal(decision.post === false && decision.code, 'NUMBER_HELD_BY_VOIDED_DOCUMENT')
})
