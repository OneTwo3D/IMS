import assert from 'node:assert/strict'
import test from 'node:test'

import { selectDocumentClaim, type DocumentClaim } from '../../lib/domain/invoice-documents/claim-selection.ts'
import { DEFAULT_INVOICE_DOCUMENT_MAX_BYTES, invoiceDocumentMaxBytes, validateFetchedPdf } from '../../lib/domain/invoice-documents/pdf-validate.ts'
import { DOCUMENT_MISSING_ESCALATION_MS, nextAttemptDelayMs, shouldEscalateMissing } from '../../lib/domain/invoice-documents/backoff.ts'

const claim = (id: string, status: string): DocumentClaim => ({ documentId: id, documentNumber: 'INV-1', status })

test('one live document is selected, whatever voided predecessors stand beside it', () => {
  const r = selectDocumentClaim([claim('a', 'VOIDED'), claim('b', 'AUTHORISED')], 'invoice INV-1')
  assert.deepEqual(r, { outcome: 'select', claim: claim('b', 'AUTHORISED') })
  assert.equal(selectDocumentClaim([claim('p', 'PAID')], 'x').outcome, 'select')
})

test('two live documents are never chosen between', () => {
  const r = selectDocumentClaim([claim('a', 'AUTHORISED'), claim('b', 'PAID')], 'invoice INV-1')
  assert.equal(r.outcome, 'attention')
})

test('a draft or submitted document is waited for, an empty answer is waited for', () => {
  assert.equal(selectDocumentClaim([claim('a', 'DRAFT')], 'x').outcome, 'wait')
  assert.equal(selectDocumentClaim([claim('a', 'SUBMITTED')], 'x').outcome, 'wait')
  assert.equal(selectDocumentClaim([], 'x').outcome, 'wait')
  assert.equal(selectDocumentClaim([claim('a', 'DELETED')], 'x').outcome, 'wait')
})

test('a cancelled order: a single voided document is still the customer document, several are not chosen between', () => {
  assert.equal(selectDocumentClaim([claim('a', 'VOIDED')], 'x').outcome, 'select')
  assert.equal(selectDocumentClaim([claim('a', 'VOIDED'), claim('b', 'VOIDED')], 'x').outcome, 'attention')
})

test('a status IMS does not know needs a person', () => {
  assert.equal(selectDocumentClaim([claim('a', 'SOMETHING_NEW')], 'x').outcome, 'attention')
  assert.equal(selectDocumentClaim([claim('a', 'authorised')], 'x').outcome, 'select', 'case-insensitive')
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
