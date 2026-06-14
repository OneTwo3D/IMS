import assert from 'node:assert/strict'
import test from 'node:test'

import {
  validateRecordSupplierCreditNote,
  buildSupplierCreditNoteSyncPayload,
  resolveSupplierCreditNoteTaxType,
} from '@/lib/domain/purchasing/supplier-credit-note'

// audit-g5u2.3: a supplier credit note can only be recorded against a billed PO,
// and its Xero payload reverses the freight bill on the transit/clearing account.

test('record validation: requires a positive amount', () => {
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 0, hasInvoice: true, selectedInvoiceBelongsToPo: null }),
    'Credit note amount must be greater than 0',
  )
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: -5, hasInvoice: true, selectedInvoiceBelongsToPo: null }),
    'Credit note amount must be greater than 0',
  )
})

test('record validation: requires the PO to have a recorded invoice', () => {
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 100, hasInvoice: false, selectedInvoiceBelongsToPo: null }),
    'Record the supplier invoice before crediting it',
  )
})

test('record validation: rejects an invoice that belongs to another PO', () => {
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 100, hasInvoice: true, selectedInvoiceBelongsToPo: false }),
    'The selected invoice does not belong to this purchase order',
  )
})

test('record validation: passes for a valid request', () => {
  assert.equal(validateRecordSupplierCreditNote({ amountForeign: 120, hasInvoice: true, selectedInvoiceBelongsToPo: true }), null)
  assert.equal(validateRecordSupplierCreditNote({ amountForeign: 120, hasInvoice: true, selectedInvoiceBelongsToPo: null }), null)
})

test('record validation: rejects over-crediting the bill (Codex review)', () => {
  // 80 remaining, asking for 100 → blocked.
  assert.match(
    validateRecordSupplierCreditNote({ amountForeign: 100, hasInvoice: true, selectedInvoiceBelongsToPo: true, remainingCreditableForeign: 80 }) ?? '',
    /exceeds the remaining creditable amount/,
  )
  // Exactly the remaining amount is allowed (within epsilon).
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 80, hasInvoice: true, selectedInvoiceBelongsToPo: true, remainingCreditableForeign: 80 }),
    null,
  )
  // No cap supplied → no over-credit check.
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 9999, hasInvoice: true, selectedInvoiceBelongsToPo: true, remainingCreditableForeign: null }),
    null,
  )
})

test('sync payload reverses on the transit account with the supplier contact', () => {
  const payload = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'scn-1',
    creditNoteNumber: 'CN-77',
    reference: 'PO-9',
    reason: 'Duplicate freight bill',
    supplierName: 'Freight Co',
    supplierId: 'sup-1',
    currency: 'EUR',
    fxRateToBase: 0.85,
    amountForeign: 120,
    transitAccount: '1250',
    taxType: 'INPUT2',
    date: '2026-06-13',
  })
  assert.equal(payload.contactName, 'Freight Co')
  assert.equal(payload.supplierId, 'sup-1')
  assert.equal(payload.currency, 'EUR')
  assert.equal(payload.currencyRateToBase, 0.85)
  assert.equal(payload.creditNoteNumber, 'CN-77')
  const lines = payload.lines as Array<Record<string, unknown>>
  assert.equal(lines.length, 1)
  assert.equal(lines[0].accountCode, '1250')
  assert.equal(lines[0].unitAmount, 120)
  assert.equal(lines[0].description, 'Duplicate freight bill')
  assert.equal(lines[0].taxType, 'INPUT2') // audit-oy5p: mirrors the bill's tax type
})

test('credit-note tax type mirrors the bill: supplier tax type when the bill had VAT, else NONE', () => {
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, supplierTaxType: 'INPUT2' }), 'INPUT2')
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: false, supplierTaxType: 'INPUT2' }), 'NONE')
  // Bill had VAT but the supplier has no mapped tax type → fall back to NONE (defensive).
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, supplierTaxType: null }), 'NONE')
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, supplierTaxType: undefined }), 'NONE')
})

test('sync payload falls back to reference then a synthetic number, and a default line description', () => {
  const noNumber = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'scn-2', creditNoteNumber: null, reference: 'PO-ABC', reason: null,
    supplierName: 'S', supplierId: 's', currency: 'GBP', fxRateToBase: 1, amountForeign: 10, transitAccount: 'T', taxType: 'NONE', date: '2026-06-13',
  })
  assert.equal(noNumber.creditNoteNumber, 'PO-ABC')
  assert.equal((noNumber.lines as Array<Record<string, unknown>>)[0].description, 'Supplier credit note')

  const noRef = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'scn-3', creditNoteNumber: null, reference: null, reason: null,
    supplierName: 'S', supplierId: 's', currency: 'GBP', fxRateToBase: 1, amountForeign: 10, transitAccount: 'T', taxType: 'NONE', date: '2026-06-13',
  })
  assert.equal(noRef.creditNoteNumber, 'SCN-scn-3')
  assert.equal(noRef.reference, undefined)
})
