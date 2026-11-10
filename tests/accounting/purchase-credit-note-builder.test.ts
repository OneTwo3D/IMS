import assert from 'node:assert/strict'
import test from 'node:test'

import { buildXeroPurchaseCreditNote, XERO_PURCHASE_CREDIT_NOTE_TYPE } from '@/lib/connectors/xero/credit-notes'
import type { CreditNoteData } from '@/lib/connectors/types'

// audit-g5u2: the supplier credit note must post as ACCPAYCREDIT (purchase), not
// ACCRECCREDIT (sales), with the expense-account lines and IMS FX rate stamped.

const base: CreditNoteData = {
  creditNoteNumber: 'SCN-001',
  contactName: 'Freight Co',
  date: '2026-06-13',
  currency: 'EUR',
  currencyRateToBase: 0.85,
  lines: [
    { description: 'Duplicate freight bill credit', quantity: 1, unitAmount: 120, accountCode: '6200', taxType: 'NONE', noTaxKind: 'no-vat-rate' },
  ],
  reference: 'PO-FREIGHT-9',
}

test('builds an ACCPAYCREDIT (purchase) credit note, not a sales one', () => {
  const body = buildXeroPurchaseCreditNote(base, 'AUTHORISED', 'contact-123', 'GBP')
  assert.equal(body.Type, XERO_PURCHASE_CREDIT_NOTE_TYPE)
  assert.equal(XERO_PURCHASE_CREDIT_NOTE_TYPE, 'ACCPAYCREDIT')
  assert.deepEqual(body.Contact, { ContactID: 'contact-123' })
  assert.equal(body.Status, 'AUTHORISED')
  assert.equal(body.CurrencyCode, 'EUR')
  assert.equal(body.CreditNoteNumber, 'SCN-001')
  assert.equal(body.Reference, 'PO-FREIGHT-9')
})

test('maps line items with the expense account code + tax type', () => {
  const body = buildXeroPurchaseCreditNote(base, 'DRAFT', 'c1', 'GBP')
  const lines = body.LineItems as Array<Record<string, unknown>>
  assert.equal(lines.length, 1)
  assert.equal(lines[0].AccountCode, '6200')
  assert.equal(lines[0].UnitAmount, 120)
  assert.equal(lines[0].TaxType, 'NONE')
  assert.equal(body.LineAmountTypes, 'Exclusive') // lineAmountsIncludeTax omitted
})

test('a missing line tax type is REFUSED, not defaulted to NONE (ACC-H3)', () => {
  assert.throws(() => buildXeroPurchaseCreditNote(
    { ...base, lines: [{ description: 'x', quantity: 1, unitAmount: 10, accountCode: '6200' }] },
    'AUTHORISED',
    'c1',
    'GBP',
  ), /NOTHING WAS SENT\. Supplier credit note SCN-001 was refused: no tax type on line 1 "x"/)
})

test('stamps the IMS FX rate and omits Reference when absent', () => {
  const withRate = buildXeroPurchaseCreditNote(base, 'AUTHORISED', 'c1', 'GBP')
  assert.ok('CurrencyRate' in withRate, 'CurrencyRate should be stamped when currencyRateToBase is set')

  const noRef = buildXeroPurchaseCreditNote({ ...base, reference: undefined }, 'AUTHORISED', 'c1', 'GBP')
  assert.equal('Reference' in noRef, false)
})
