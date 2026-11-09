import assert from 'node:assert/strict'
import test from 'node:test'

import { selectDocumentClaim, type DocumentClaim } from '../../lib/domain/invoice-documents/claim-selection.ts'
import { DEFAULT_INVOICE_DOCUMENT_MAX_BYTES, invoiceDocumentMaxBytes, validateFetchedPdf } from '../../lib/domain/invoice-documents/pdf-validate.ts'
import { assessDocumentEvidence, type EvidenceSubject } from '../../lib/domain/invoice-documents/order-evidence.ts'
import { DOCUMENT_MISSING_ESCALATION_MS, nextAttemptDelayMs, recheckDelayMs, shouldEscalateMissing } from '../../lib/domain/invoice-documents/backoff.ts'

const ACTIVE = { orderCancelled: false }
const CANCELLED = { orderCancelled: true }
const claim = (id: string, status: string): DocumentClaim => ({ documentId: id, documentNumber: 'INV-1', status })

test('one live document is selected, whatever voided predecessors stand beside it', () => {
  const r = selectDocumentClaim([claim('a', 'VOIDED'), claim('b', 'AUTHORISED')], 'invoice INV-1', ACTIVE)
  assert.deepEqual(r, { outcome: 'select', claim: claim('b', 'AUTHORISED') })
  assert.equal(selectDocumentClaim([claim('p', 'PAID')], 'x', ACTIVE).outcome, 'select')
})

test('two live documents are never chosen between', () => {
  const r = selectDocumentClaim([claim('a', 'AUTHORISED'), claim('b', 'PAID')], 'invoice INV-1', ACTIVE)
  assert.equal(r.outcome, 'attention')
})

test('a draft or submitted document is waited for, an empty answer is waited for', () => {
  assert.equal(selectDocumentClaim([claim('a', 'DRAFT')], 'x', ACTIVE).outcome, 'wait')
  assert.equal(selectDocumentClaim([claim('a', 'SUBMITTED')], 'x', ACTIVE).outcome, 'wait')
  assert.equal(selectDocumentClaim([], 'x', ACTIVE).outcome, 'wait')
  assert.equal(selectDocumentClaim([claim('a', 'DELETED')], 'x', ACTIVE).outcome, 'wait')
})

test('a voided document is the customer document only on a CANCELLED order; on an active order it is waited for', () => {
  assert.equal(selectDocumentClaim([claim('a', 'VOIDED')], 'x', CANCELLED).outcome, 'select')
  assert.equal(selectDocumentClaim([claim('a', 'VOIDED'), claim('b', 'VOIDED')], 'x', CANCELLED).outcome, 'attention')
  assert.equal(selectDocumentClaim([claim('a', 'VOIDED')], 'x', ACTIVE).outcome, 'wait')
  assert.equal(selectDocumentClaim([claim('a', 'VOIDED'), claim('b', 'VOIDED')], 'x', ACTIVE).outcome, 'wait')
  assert.equal(selectDocumentClaim([claim('a', 'VOIDED'), claim('b', 'AUTHORISED')], 'x', ACTIVE).outcome, 'select', 'a live replacement wins on either kind of order')
})

test('a status IMS does not know needs a person', () => {
  assert.equal(selectDocumentClaim([claim('a', 'SOMETHING_NEW')], 'x', ACTIVE).outcome, 'attention')
  assert.equal(selectDocumentClaim([claim('a', 'authorised')], 'x', ACTIVE).outcome, 'select', 'case-insensitive')
})

function pdf(body = 'x'.repeat(400)): Buffer {
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, 'latin1')
}

test('a whole PDF validates and is hashed; anything else is refused', () => {
  const ok = validateFetchedPdf(pdf())
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.match(ok.sha256, /^[a-f0-9]{64}$/)
    assert.equal(ok.byteSize, pdf().length)
  }
  assert.equal(validateFetchedPdf(Buffer.from('<html>' + 'x'.repeat(500))).ok, false, 'not a PDF')
  assert.equal(validateFetchedPdf(Buffer.from('%PDF-1.4\n' + 'x'.repeat(500))).ok, false, 'truncated: no EOF marker')
  assert.equal(validateFetchedPdf(Buffer.from('%PDF-1.4 %%EOF')).ok, false, 'too small')
  assert.equal(validateFetchedPdf(pdf('x'.repeat(5000)), 1000).ok, false, 'over the limit')
})

test('the size ceiling is configurable and falls back on nonsense', () => {
  assert.equal(invoiceDocumentMaxBytes({ INVOICE_DOCUMENT_MAX_BYTES: '2048' }), 2048)
  assert.equal(invoiceDocumentMaxBytes({ INVOICE_DOCUMENT_MAX_BYTES: 'lots' }), DEFAULT_INVOICE_DOCUMENT_MAX_BYTES)
  assert.equal(invoiceDocumentMaxBytes({}), DEFAULT_INVOICE_DOCUMENT_MAX_BYTES)
})

test('retries widen, then hold at a day; a long-missing document is escalated', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(nextAttemptDelayMs), [600_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000, 86_400_000, 86_400_000])
  const first = new Date('2026-11-01T00:00:00Z')
  assert.equal(shouldEscalateMissing(first, new Date(first.getTime() + DOCUMENT_MISSING_ESCALATION_MS - 1)), false)
  assert.equal(shouldEscalateMissing(first, new Date(first.getTime() + DOCUMENT_MISSING_ESCALATION_MS)), true)
})

const subject = (over: Partial<EvidenceSubject> = {}): EvidenceSubject => ({
  orderNumbers: ['12345', 'SO-0099'], customerName: 'Ada Lovelace', currency: 'GBP', expectedTotal: 100,
  anchorDate: new Date('2026-11-01T00:00:00Z'), dateToleranceDays: 14, ...over,
})
const doc = (over: Partial<DocumentClaim> = {}): DocumentClaim => ({ documentId: 'd', documentNumber: 'INV-1', status: 'AUTHORISED', total: 100, currencyCode: 'GBP', ...over })

test('evidence: total must match within a penny or two, and the ledger must report one', () => {
  assert.equal(assessDocumentEvidence(subject(), doc({ reference: 'order 12345' })).ok, true)
  assert.equal(assessDocumentEvidence(subject(), doc({ total: 100.01, reference: 'order 12345' })).ok, true)
  assert.equal(assessDocumentEvidence(subject(), doc({ total: 101, reference: 'order 12345' })).ok, false)
  assert.equal(assessDocumentEvidence(subject(), doc({ total: undefined, reference: 'order 12345' })).ok, false)
})

test('evidence: currency must be REPORTED and equal', () => {
  assert.equal(assessDocumentEvidence(subject(), doc({ currencyCode: 'EUR', reference: '12345' })).ok, false)
  assert.equal(assessDocumentEvidence(subject(), doc({ currencyCode: undefined, reference: '12345' })).ok, false, 'a document that states no currency is refused')
})

test('evidence: the customer OR the order reference must match; a total and a date alone are not identity', () => {
  assert.equal(assessDocumentEvidence(subject(), doc({ reference: 'WC order #12345' })).ok, true)
  assert.equal(assessDocumentEvidence(subject(), doc({ contactName: 'ada  LOVELACE' })).ok, true)
  assert.equal(assessDocumentEvidence(subject(), doc({ dateString: '2026-11-02' })).ok, false, 'total + currency + date, nothing about who: refused')
  assert.equal(assessDocumentEvidence(subject(), doc({})).ok, false)
})

test('evidence: an explicit conflict on the customer or the reference refuses the document even when another key matches', () => {
  assert.equal(assessDocumentEvidence(subject(), doc({ reference: '12345', contactName: 'Bob Builder', dateString: '2026-11-02' })).ok, false, 'reference matches, customer is someone else')
  assert.equal(assessDocumentEvidence(subject(), doc({ contactName: 'Ada Lovelace', reference: 'order 99999', dateString: '2026-11-02' })).ok, false, 'customer matches, reference names another order')
  assert.equal(assessDocumentEvidence(subject(), doc({ reference: 'order 123456' })).ok, false, '123456 is not 12345')
})

test('evidence: the date is supporting only', () => {
  const near = assessDocumentEvidence(subject(), doc({ reference: '12345', dateString: '2026-11-02' }))
  const far = assessDocumentEvidence(subject(), doc({ reference: '12345', dateString: '2026-12-25' }))
  assert.equal(near.ok && near.matched.includes('date'), true)
  assert.equal(far.ok && !far.matched.includes('date'), true, 'a far date neither refuses nor corroborates')
})

test('evidence: a credit note (no gross total to compare) needs currency plus customer or reference', () => {
  const cn = subject({ expectedTotal: null, dateToleranceDays: 30 })
  assert.equal(assessDocumentEvidence(cn, doc({ total: undefined, reference: '12345' })).ok, true)
  assert.equal(assessDocumentEvidence(cn, doc({ total: undefined, dateString: '2026-11-10' })).ok, false)
  assert.equal(assessDocumentEvidence(cn, doc({ total: undefined, currencyCode: undefined, reference: '12345' })).ok, false)
})

test('rechecks of a stored document: a day, a week, then every thirty days', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(recheckDelayMs), [86_400_000, 604_800_000, 2_592_000_000, 2_592_000_000, 2_592_000_000])
})

test('the invoice gross is the amount paid PLUS the store credit settled against it, and only when the credit was assessed', async () => {
  const { expectedInvoiceGross } = await import('../../lib/domain/invoice-documents/order-evidence.ts')
  assert.deepEqual(expectedInvoiceGross({ totalForeign: '80', storeCreditForeign: '20', storeCreditAssessment: 'ASSESSED' }), { ok: true, total: 100 })
  assert.deepEqual(expectedInvoiceGross({ totalForeign: '100', storeCreditForeign: '0', storeCreditAssessment: null }), { ok: true, total: 100 })
  assert.equal(expectedInvoiceGross({ totalForeign: '80', storeCreditForeign: '20', storeCreditAssessment: null }).ok, false, 'credit never assessed')
  assert.equal(expectedInvoiceGross({ totalForeign: '80', storeCreditForeign: '20', storeCreditAssessment: 'REVIEW_REQUIRED' }).ok, false)
  assert.equal(expectedInvoiceGross({ totalForeign: '100', storeCreditForeign: '0', storeCreditAssessment: 'REVIEW_REQUIRED' }).ok, false)
  assert.equal(expectedInvoiceGross({ totalForeign: '80', storeCreditForeign: 'lots', storeCreditAssessment: 'ASSESSED' }).ok, false, 'an unreadable amount fails closed')
})

test('two readings of one ledger document must agree on every field the ownership check rests on', async () => {
  const { ownershipFingerprintsMatch } = await import('../../lib/domain/invoice-documents/claim-selection.ts')
  const base: DocumentClaim = { documentId: 'd', documentNumber: 'INV-1', status: 'AUTHORISED', total: 100, currencyCode: 'GBP', contactName: 'Ada', reference: '12345', dateString: '2026-11-01', updatedDateUtc: '/Date(1)/' }
  assert.equal(ownershipFingerprintsMatch(base, { ...base }), true)
  assert.equal(ownershipFingerprintsMatch(base, { ...base, status: 'authorised' }), true, 'case is not a change')
  for (const change of [{ status: 'PAID' }, { total: 101 }, { currencyCode: 'EUR' }, { contactName: 'Bob' }, { reference: '999' }, { dateString: '2026-11-02' }, { updatedDateUtc: '/Date(2)/' }, { documentId: 'e' }]) {
    assert.equal(ownershipFingerprintsMatch(base, { ...base, ...change }), false, JSON.stringify(change))
  }
})

test('evidence failures say whether they are a POSITIVE conflict (withdraws a stored document) or missing information (does not)', () => {
  const failure = (claim: DocumentClaim) => { const r = assessDocumentEvidence(subject(), claim); return r.ok ? null : r.conflict }
  assert.equal(failure(doc({ total: 999, reference: '12345' })), true, 'total contradicts')
  assert.equal(failure(doc({ currencyCode: 'EUR', reference: '12345' })), true, 'currency contradicts')
  assert.equal(failure(doc({ contactName: 'Bob', reference: '12345' })), true, 'customer contradicts')
  assert.equal(failure(doc({ reference: '99999', contactName: 'Ada Lovelace' })), true, 'reference names another order')
  assert.equal(failure(doc({ currencyCode: undefined, reference: '12345' })), false, 'currency not stated')
  assert.equal(failure(doc({ total: undefined, reference: '12345' })), false, 'total not stated')
  assert.equal(failure(doc({})), false, 'nothing states whose it is')
})
