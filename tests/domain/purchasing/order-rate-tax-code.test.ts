import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { findPurchaseDocumentTaxTypeProblems } from '@/lib/domain/accounting/purchase-document-tax-types'
import { billTaxCodeDisagreementMessage, billTaxCodeDisagreements, resolveOrderRateTaxCode, type OrderRateCandidate } from '@/lib/domain/purchasing/order-rate-tax-code'
import { calculatePurchaseInvoice, type PurchaseInvoiceCostLine, type PurchaseInvoicePoLine } from '@/lib/domain/purchasing/purchase-invoice-edit'

/**
 * ACC-H2 follow-up: a vatable cost line's VAT is taken at the order's RECORDED rate, so its tax code must be the code of THAT rate, not the
 * supplier's current default. A PO overridden to 5% under a 20% supplier default recorded 5% VAT in IMS while the ledger charged 20%.
 */

const r = (id: string, rate: number, accountingTaxType: string | null, over: Partial<OrderRateCandidate> = {}): OrderRateCandidate =>
  ({ id, name: id, rate, accountingTaxType, active: true, usedFor: 'PURCHASE', isCompound: false, reverseCharge: false, ...over })
const standard = r('std', 0.2, 'INPUT2', { name: 'UK Standard' })
const reduced = r('red', 0.05, 'INPUT5', { name: 'UK Reduced' })
const zero = r('zero', 0, 'ZERORATEDINPUT')

const costLines = new Map<string, PurchaseInvoiceCostLine>([['freight', { id: 'freight', description: 'Freight', amountForeign: 100, vatable: true }]])
const bill = (code: ReturnType<typeof resolveOrderRateTaxCode>, poTaxRatePercent: number | null) => calculatePurchaseInvoice({
  lines: [{ kind: 'cost', costLineId: 'freight', amountForeign: 100 }], fxRateToBase: 1, poReference: 'PO-1', transitAccount: '631', poType: 'GOODS',
  poTaxRatePercent, fallbackTaxType: code?.taxType, fallbackTaxRateId: code?.taxRateId, poLineById: new Map(), costLineById: costLines,
})

test('a PO charged at 5% under a 20% supplier default posts its freight on the 5% code, and IMS VAT matches it', () => {
  const code = resolveOrderRateTaxCode({ recordedRate: '0.0500', recordedName: 'UK Reduced', candidates: [standard, reduced, zero], supplierDefault: standard })
  assert.deepEqual(code, { taxType: 'INPUT5', taxRateId: 'red' })
  const result = bill(code, 0.05)
  assert.equal(result.taxForeign, 5)
  assert.deepEqual([result.accountingLines[0].taxType, result.accountingLines[0].taxRateId, result.accountingLines[0].taxRateBasis], ['INPUT5', 'red', 'plain'])
  assert.deepEqual(findPurchaseDocumentTaxTypeProblems({ lines: result.accountingLines }), [])
})

test('a recorded rate with no mapped type, or no rate at that percentage, resolves to nothing: the line is left blank and refused', () => {
  const unmapped = resolveOrderRateTaxCode({ recordedRate: 0.05, candidates: [standard, r('red', 0.05, null)], supplierDefault: standard })
  assert.equal(unmapped, null)
  assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.05, candidates: [standard], supplierDefault: standard }), null)
  const result = bill(unmapped, 0.05)
  assert.equal(result.accountingLines[0].taxType, undefined)
  assert.equal(findPurchaseDocumentTaxTypeProblems({ lines: result.accountingLines }).length, 1)
})

test('a PO with NO recorded rate bills 0 VAT and needs a 0% code: the taxable supplier default is never borrowed; ambiguous or absent 0% codes refuse', () => {
  assert.deepEqual(resolveOrderRateTaxCode({ recordedRate: null, candidates: [standard, zero], supplierDefault: standard }), { taxType: 'ZERORATEDINPUT', taxRateId: 'zero' })
  assert.equal(resolveOrderRateTaxCode({ recordedRate: null, candidates: [standard], supplierDefault: standard }), null)
  assert.equal(resolveOrderRateTaxCode({ recordedRate: null, candidates: [zero, r('none', 0, 'NONE')], supplierDefault: standard }), null)
  const ok = bill(resolveOrderRateTaxCode({ recordedRate: null, candidates: [standard, zero], supplierDefault: standard }), null)
  assert.equal(ok.taxForeign, 0)
  assert.equal(ok.accountingLines[0].taxType, 'ZERORATEDINPUT')
})

test('ties: the supplier default wins among equals, a name narrows, two different codes at one percentage refuse; unusable rates are ignored', () => {
  const twin = r('twin', 0.2, 'INPUT20B', { name: 'Other 20' })
  assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [twin], supplierDefault: standard })?.taxRateId, 'std')
  assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, recordedName: ' other  20 ', candidates: [standard, twin], supplierDefault: null })?.taxRateId, 'twin')
  assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [standard, twin], supplierDefault: null }), null)
  assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [r('i', 0.2, 'X', { active: false }), r('s', 0.2, 'X', { usedFor: 'SALES' }), r('c', 0.2, 'X', { isCompound: true }), r('v', 0.2, 'X', { reverseCharge: true })], supplierDefault: null }), null)
  assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [r('a', 0.2, 'INPUT2'), r('b', 0.2, 'input2')], supplierDefault: null })?.taxType, 'INPUT2')
})

test('a supplier default that is inactive, sales-only, compound, reverse-charge, or read without its eligibility fields NEVER wins', () => {
  const other = r('other', 0.2, 'INPUT20B', { name: 'Other 20' })
  const bad: Array<[string, OrderRateCandidate]> = [
    ['inactive', r('std', 0.2, 'INPUT2', { active: false })],
    ['sales-only', r('std', 0.2, 'INPUT2', { usedFor: 'SALES' })],
    ['compound', r('std', 0.2, 'INPUT2', { isCompound: true })],
    ['reverse-charge', r('std', 0.2, 'INPUT2', { reverseCharge: true })],
    ['fields not read', { id: 'std', name: 'std', rate: 0.2, accountingTaxType: 'INPUT2' }],
  ]
  for (const [label, supplierDefault] of bad) {
    assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [other], supplierDefault })?.taxRateId, 'other', label)
    assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [other, r('third', 0.2, 'INPUT20C')], supplierDefault }), null, `${label}: it does not break a tie`)
    assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [], supplierDefault }), null, `${label}: and is no candidate on its own`)
  }
  assert.equal(resolveOrderRateTaxCode({ recordedRate: 0.2, candidates: [other], supplierDefault: r('std', 0.2, 'INPUT2') })?.taxRateId, 'std', 'control: an eligible default wins')
})

test('both callers select the supplier default WITH its eligibility fields (wiring)', () => {
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  const selects = source.match(/taxRate: \{ select: \{ id: true, name: true, rate: true, accountingTaxType: true, active: true, usedFor: true, isCompound: true, reverseCharge: true \} \}/g) ?? []
  assert.equal(selects.length, 2)
})

test('a goods line whose OWN rate is unmapped does not borrow the order-rate code (it would post a different rate than its VAT)', () => {
  const poLines = new Map<string, PurchaseInvoicePoLine>([['p', { id: 'p', qty: 1, product: { sku: 'A' }, taxRate: { accountingTaxType: null, rate: '0.05' } }]])
  const result = calculatePurchaseInvoice({
    lines: [{ kind: 'product', poLineId: 'p', qtyBilled: 1, unitCostForeign: 100 }], fxRateToBase: 1, poReference: 'PO-1', transitAccount: '631',
    poTaxRatePercent: 0.2, fallbackTaxType: 'INPUT2', poLineById: poLines, costLineById: new Map(),
  })
  assert.equal(result.accountingLines[0].taxType, undefined)
})

test('agreement: a bill line whose code charges another rate in the ledger is a disagreement beyond rounding; unknown codes, reverse-charge lines and rounding are not', () => {
  const ledger = new Map<string, number | null>([['INPUT2', 20], ['INPUT5', 5], ['NONE', 0], ['UNKNOWN', null]])
  const line = (taxType: string | undefined, rate: number, checkable = true) => ({ description: 'Freight', taxType, rate, checkable })
  assert.deepEqual(billTaxCodeDisagreements([line('INPUT2', 0.2), line('INPUT5', 0.05), line('NONE', 0), line('INPUT2', 0.200049)], ledger), [])
  const bad = billTaxCodeDisagreements([line('INPUT2', 0.05), line('NONE', 0.2)], ledger)
  assert.equal(bad.length, 2)
  assert.match(bad[0], /taxed at 5% in IMS but posts on INPUT2, which charges 20%/)
  assert.deepEqual(billTaxCodeDisagreements([line('UNKNOWN', 0.2), line('NOT-LISTED', 0.2), line(undefined, 0.2), line('INPUT2', 0.05, false)], ledger), [])
  assert.match(billTaxCodeDisagreementMessage(bad), /was not saved/)
})

test('a goods line at 5% billed on the 20% code is refused by the agreement check', () => {
  const poLines = new Map<string, PurchaseInvoicePoLine>([['p', { id: 'p', qty: 1, product: { sku: 'A' }, taxRate: { accountingTaxType: 'INPUT2', rate: '0.05' } }]])
  const result = calculatePurchaseInvoice({
    lines: [{ kind: 'product', poLineId: 'p', qtyBilled: 1, unitCostForeign: 100 }], fxRateToBase: 1, poReference: 'PO-1', transitAccount: '631',
    poTaxRatePercent: 0.05, poLineById: poLines, costLineById: new Map(),
  })
  assert.equal(billTaxCodeDisagreements(result.lineTaxRates, new Map([['INPUT2', 20]])).length, 1)
})

test('both callers refuse a disagreeing bill before it is saved (wiring)', () => {
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  assert.equal((source.match(/await billTaxCodeRefusal\(invoiceCalculation\.lineTaxRates\)/g) ?? []).length, 2)
})

test('both bill callers take the cost-line code from the order\'s recorded rate, not the supplier default (wiring)', () => {
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  assert.equal((source.match(/resolveOrderRateTaxCode\(/g) ?? []).length, 2)
  assert.doesNotMatch(source, /fallbackTaxType = [^\n]*supplier[^\n]*taxRate\?\.accountingTaxType/)
})
