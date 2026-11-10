import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findPurchaseDocumentTaxTypeProblems,
  noVatRateKind,
  purchaseDocumentTaxTypeRefusal,
} from '@/lib/domain/accounting/purchase-document-tax-types'
import { calculatePurchaseInvoice, type PurchaseInvoiceCostLine, type PurchaseInvoicePoLine } from '@/lib/domain/purchasing/purchase-invoice-edit'
import { buildSupplierCreditNoteSyncPayload, resolveSupplierCreditNoteTaxType } from '@/lib/domain/purchasing/supplier-credit-note'

/** ACC-H3: a blank tax type on a bill or supplier credit-note line is a refusal, never NONE. */

const line = (over: Record<string, unknown> = {}) => ({ description: 'Goods', taxType: 'INPUT2', ...over })

test('finder: blank / missing / whitespace is missing; unexplained NONE is explicit-none; a decided code and a named NONE pass', () => {
  assert.deepEqual(findPurchaseDocumentTaxTypeProblems({ lines: [line({ taxType: undefined }), line({ taxType: '' }), line({ taxType: '  ' }), line({ taxType: 'none' })] }).map((p) => p.kind),
    ['missing', 'missing', 'missing', 'explicit-none'])
  assert.deepEqual(findPurchaseDocumentTaxTypeProblems({ lines: [line(), line({ taxType: 'NONE', noTaxKind: 'cost-not-vatable' }), line({ taxType: ' none ', noTaxKind: 'no-vat-rate' })] }), [])
  assert.equal(purchaseDocumentTaxTypeRefusal('Purchase bill X', { lines: [line()] }), null)
  assert.match(purchaseDocumentTaxTypeRefusal('Purchase bill X', { lines: [line({ taxType: undefined, description: 'Freight' })] })!, /^NOTHING WAS SENT\. Purchase bill X was refused: no tax type on line 1 "Freight"/)
  assert.equal(noVatRateKind('NONE'), 'no-vat-rate')
  assert.equal(noVatRateKind('INPUT2'), undefined)
  assert.equal(noVatRateKind(undefined), undefined)
})

const poLines = new Map<string, PurchaseInvoicePoLine>([
  ['rated', { id: 'rated', qty: 5, product: { sku: 'A' }, taxRate: { accountingTaxType: 'INPUT2', rate: '0.2' } }],
  ['unmapped', { id: 'unmapped', qty: 5, product: { sku: 'B' }, taxRate: { accountingTaxType: null, rate: '0.2' } }],
  ['norate', { id: 'norate', qty: 5, product: { sku: 'C' }, taxRate: null }],
  ['novat', { id: 'novat', qty: 5, product: { sku: 'D' }, taxRate: { accountingTaxType: 'NONE', rate: '0' } }],
])
const costLines = new Map<string, PurchaseInvoiceCostLine>([
  ['vatable', { id: 'vatable', description: 'Freight', amountForeign: 50, vatable: true }],
  ['exempt', { id: 'exempt', description: 'Handling', amountForeign: 50, vatable: false }],
])
const calc = (lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => calculatePurchaseInvoice({
  lines: lines as never, fxRateToBase: 1, poReference: 'PO-1', poTaxRatePercent: '0.2', transitAccount: '631', poLineById: poLines, costLineById: costLines, ...over,
})

test('producer: a goods line whose rate is unmapped, and one with no rate and no supplier default, leave the type BLANK (refused later), never NONE', () => {
  const result = calc([
    { kind: 'product', poLineId: 'unmapped', qtyBilled: 1, unitCostForeign: 10 },
    { kind: 'product', poLineId: 'norate', qtyBilled: 1, unitCostForeign: 10 },
  ])
  assert.deepEqual(result.accountingLines.map((l) => l.taxType), [undefined, undefined])
  assert.equal(result.accountingLines.some((l) => l.noTaxKind), false)
  assert.equal(findPurchaseDocumentTaxTypeProblems({ lines: result.accountingLines }).length, 2)
})

test('producer: a vatable cost line with no supplier default is blank; a non-vatable one is a NAMED NONE; a No VAT rate is a NAMED NONE', () => {
  const noDefault = calc([{ kind: 'cost', costLineId: 'vatable', amountForeign: 50 }])
  assert.equal(noDefault.accountingLines[0].taxType, undefined)
  const withDefault = calc([{ kind: 'cost', costLineId: 'vatable', amountForeign: 50 }, { kind: 'cost', costLineId: 'exempt', amountForeign: 50 }, { kind: 'product', poLineId: 'novat', qtyBilled: 1, unitCostForeign: 10 }], { fallbackTaxType: 'INPUT2' })
  assert.deepEqual(withDefault.accountingLines.map((l) => [l.taxType, l.noTaxKind]), [['INPUT2', undefined], ['NONE', 'cost-not-vatable'], ['NONE', 'no-vat-rate']])
  assert.deepEqual(findPurchaseDocumentTaxTypeProblems({ lines: withDefault.accountingLines }), [])
})

test('supplier credit note: a bill that carried VAT with no supplier tax type is UNDECIDED (not NONE) and the payload line carries none; a bill with no VAT is a named NONE', () => {
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, supplierTaxType: null }), undefined)
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, supplierTaxType: '' }), undefined)
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, supplierTaxType: 'INPUT2', isReverseCharge: true, reverseChargeTaxType: null }), 'INPUT2')
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, isReverseCharge: true, supplierTaxType: null }), undefined)
  const common = { creditNoteId: 'c1', creditNoteNumber: null, reference: null, reason: null, supplierName: 'S', supplierId: 's1', currency: 'GBP', fxRateToBase: 1, amountForeign: 10, transitAccount: '631', date: '2026-11-02' }
  const undecided = buildSupplierCreditNoteSyncPayload({ ...common, taxType: undefined }) as { lines: Array<Record<string, unknown>> }
  assert.notEqual(undecided.lines[0].taxType, 'NONE')
  assert.equal(findPurchaseDocumentTaxTypeProblems({ lines: undecided.lines as never }).length, 1)
  const untaxed = buildSupplierCreditNoteSyncPayload({ ...common, taxType: resolveSupplierCreditNoteTaxType({ billHadTax: false, supplierTaxType: 'INPUT2' }) }) as { lines: Array<Record<string, unknown>> }
  assert.deepEqual([untaxed.lines[0].taxType, untaxed.lines[0].noTaxKind], ['NONE', 'no-vat-rate'])
  assert.deepEqual(findPurchaseDocumentTaxTypeProblems({ lines: untaxed.lines as never }), [])
})
