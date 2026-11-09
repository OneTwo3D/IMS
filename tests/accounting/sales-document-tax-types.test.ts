import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NO_TAX_TYPE,
  SALES_NO_TAX_LINE_KINDS,
  describeSalesDocumentTaxTypeRefusal,
  findSalesDocumentTaxTypeProblems,
  isNoTaxType,
  salesDocumentTaxTypeRefusal,
} from '@/lib/domain/accounting/sales-document-tax-types'
import { reconcileWcDocumentTax } from '@/lib/connectors/woocommerce/sync/order-import'

/**
 * No default-to-NONE on a sales invoice or credit note (the refusal floor).
 *
 * The matrix: a missing TaxType at EACH line kind (product line, shipping, order discount, credit-note line), an explicit NONE on an
 * ordinary line, NONE only where a line names why, and the arithmetic backstop for WooCommerce rate 182 carrying money.
 */

const good = { description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200', taxType: 'OUTPUT2' }

test('a document whose every part carries a real tax type is not refused', () => {
  assert.deepEqual(
    findSalesDocumentTaxTypeProblems({ lines: [good], shippingAmount: 5, shippingAccountCode: '300', shippingTaxType: 'OUTPUT2', discountAmount: 1, discountAccountCode: '310', discountTaxType: 'OUTPUT2' }),
    [],
  )
  assert.equal(salesDocumentTaxTypeRefusal('Sales invoice X', { lines: [good] }), null)
})

test('missing TaxType: a product line, in every shape of absent', () => {
  for (const taxType of [undefined, null, '', '   ', 0, {}]) {
    const problems = findSalesDocumentTaxTypeProblems({ lines: [good, { ...good, description: 'Gadget', taxType }] })
    assert.deepEqual(problems, [{ where: 'line 2 "Gadget"', kind: 'missing' }], String(taxType))
  }
})

test('missing TaxType: shipping and the order discount, when the connector would emit them', () => {
  const problems = findSalesDocumentTaxTypeProblems({
    lines: [good],
    shippingAmount: 5, shippingAccountCode: '300', shippingTaxType: undefined,
    discountAmount: 2, discountAccountCode: '310', discountTaxType: '',
  })
  assert.deepEqual(problems, [{ where: 'shipping', kind: 'missing' }, { where: 'order discount', kind: 'missing' }])
})

test('shipping and discount that the connector does not emit are not inspected (no amount, or no account)', () => {
  assert.deepEqual(findSalesDocumentTaxTypeProblems({ lines: [good], shippingAmount: 0, shippingAccountCode: '300', discountAmount: 2 }), [])
  assert.deepEqual(findSalesDocumentTaxTypeProblems({ lines: [good], shippingAmount: 5, discountAmount: undefined, discountAccountCode: '310' }), [])
})

test('missing TaxType: a credit-note line (the same function covers a document with no shipping or discount)', () => {
  const problems = findSalesDocumentTaxTypeProblems({ lines: [{ description: 'Refund line', taxType: undefined }] })
  assert.deepEqual(problems, [{ where: 'line 1 "Refund line"', kind: 'missing' }])
})

test('explicit NONE on an ordinary line is refused, in any case and with whitespace', () => {
  for (const taxType of ['NONE', 'none', ' None ']) {
    assert.equal(isNoTaxType(taxType), true)
    assert.deepEqual(findSalesDocumentTaxTypeProblems({ lines: [{ ...good, taxType }] }), [{ where: 'line 1 "Widget"', kind: 'explicit-none' }])
  }
  assert.equal(isNoTaxType('OUTPUT2'), false)
  assert.equal(isNoTaxType(undefined), false)
})

test('explicit NONE on shipping and the order discount is refused: those can never be a named kind', () => {
  const problems = findSalesDocumentTaxTypeProblems({
    lines: [good], shippingAmount: 5, shippingAccountCode: '300', shippingTaxType: NO_TAX_TYPE, discountAmount: 2, discountAccountCode: '310', discountTaxType: NO_TAX_TYPE,
  })
  assert.deepEqual(problems, [{ where: 'shipping', kind: 'explicit-none' }, { where: 'order discount', kind: 'explicit-none' }])
})

test('NONE is accepted only on a line naming an allowed kind; an unknown kind does not unlock it', () => {
  assert.deepEqual(SALES_NO_TAX_LINE_KINDS, ['fee-no-tax'])
  assert.deepEqual(findSalesDocumentTaxTypeProblems({ lines: [{ ...good, taxType: 'NONE', noTaxKind: 'fee-no-tax' }] }), [])
  for (const noTaxKind of ['other', '', undefined, null, true, 'FEE-NO-TAX']) {
    assert.deepEqual(
      findSalesDocumentTaxTypeProblems({ lines: [{ ...good, taxType: 'NONE', noTaxKind }] }),
      [{ where: 'line 1 "Widget"', kind: 'explicit-none' }],
      String(noTaxKind),
    )
  }
  // The kind unlocks NONE only: it does not excuse a missing code.
  assert.deepEqual(findSalesDocumentTaxTypeProblems({ lines: [{ ...good, taxType: undefined, noTaxKind: 'fee-no-tax' }] }), [{ where: 'line 1 "Widget"', kind: 'missing' }])
})

test('the refusal text names every part and says nothing was sent', () => {
  const text = salesDocumentTaxTypeRefusal('Sales invoice INV-9', {
    lines: [{ ...good, taxType: undefined }, { ...good, description: 'Duty', taxType: 'NONE' }],
    shippingAmount: 5, shippingAccountCode: '300',
  })
  assert.ok(text)
  assert.match(text, /^NOTHING WAS SENT\. Sales invoice INV-9 was refused/)
  assert.match(text, /no tax type on line 1 "Widget", shipping/)
  assert.match(text, /"No VAT" \(NONE\) on line 2 "Duty"/)
  assert.equal(describeSalesDocumentTaxTypeRefusal('x', []), null)
})

test('WooCommerce rate 182 ("Taxes & Duties") mapped to NONE is an explicit NONE: refused, not defaulted', () => {
  // The rate row itself is what carries NONE, so removing the connector's default alone would not have caught it.
  assert.deepEqual(
    findSalesDocumentTaxTypeProblems({ lines: [{ ...good, description: 'Taxes & Duties', taxType: 'NONE' }] }),
    [{ where: 'line 1 "Taxes & Duties"', kind: 'explicit-none' }],
  )
})

test('rate 182 carrying money on a 0% mapping fails the document arithmetic: the existing reconciliation refuses it', () => {
  const result = reconcileWcDocumentTax(
    [{ label: 'Taxes & Duties', netForeign: 20, rateValue: 0, reportedTaxForeign: 4.2 }],
    'EUR',
  )
  assert.equal(result.reconciles, false)
  assert.equal(result.disagreements[0]?.label, 'Taxes & Duties')
  // Zero tax on the same rate is an ordinary 0% rate and reconciles.
  assert.equal(reconcileWcDocumentTax([{ label: 'Taxes & Duties', netForeign: 20, rateValue: 0, reportedTaxForeign: 0 }], 'EUR').reconciles, true)
})

test('the poster and both connector modules run the same refusal; no sales path still defaults to NONE', async () => {
  const { readFileSync } = await import('node:fs')
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const processor = strip(readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8'))
  assert.equal((processor.match(/salesDocumentTaxTypeRefusal\(/g) ?? []).length, 3, 'SALES_INVOICE, SALES_INVOICE_UPDATE and CREDIT_NOTE')
  const invoices = strip(readFileSync('lib/connectors/xero/invoices.ts', 'utf8'))
  assert.doesNotMatch(invoices, /DEFAULT_TAX_TYPE/)
  assert.doesNotMatch(invoices, /\|\|\s*'NONE'/)
  const credit = strip(readFileSync('lib/connectors/xero/credit-notes.ts', 'utf8'))
  // The sales credit note is the first DEFAULT_TAX_TYPE site; the supplier credit note below is a PURCHASE document and keeps its default (out of scope).
  const salesPart = credit.slice(0, credit.indexOf('export const XERO_PURCHASE_CREDIT_NOTE_TYPE'))
  assert.doesNotMatch(salesPart, /DEFAULT_TAX_TYPE/)
  assert.match(salesPart, /salesDocumentTaxTypeRefusal\(/)
})
