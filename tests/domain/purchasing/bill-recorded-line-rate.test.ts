import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import type { OrderRateCandidate } from '@/lib/domain/purchasing/order-rate-tax-code'
import { calculatePurchaseInvoice, PurchaseBillTaxRefusal, type PurchaseInvoicePoLine } from '@/lib/domain/purchasing/purchase-invoice-edit'
import { resolveSupplierCreditNoteTaxType } from '@/lib/domain/purchasing/supplier-credit-note'

/**
 * A NEW BILL TAKES THE RATE THE ORDER LINE WAS RECORDED AT. The rate editor refreshes the order lines of DRAFT orders only, so a non-draft line recorded at 20% can sit on a
 * rate row that now says 5%: the bill must not quietly re-price it.
 */
const r = (id: string, rate: number, accountingTaxType: string, name = id): OrderRateCandidate =>
  ({ id, name, rate, accountingTaxType, active: true, usedFor: 'PURCHASE', isCompound: false, reverseCharge: false })
const std = r('std', 0.2, 'INPUT2', 'UK Standard')
const candidates = [std, r('red', 0.05, 'INPUT5', 'UK Reduced')]

// The order line was priced at 20% (tax 20 on 100). Its linked rate row has SINCE been changed to 5% (INPUT5, id 'red').
const line = (over: Partial<PurchaseInvoicePoLine> = {}): Map<string, PurchaseInvoicePoLine> => new Map([['p', {
  id: 'p', qty: 10, product: { sku: 'SKU-1' }, taxRate: { id: 'red', accountingTaxType: 'INPUT5', rate: '0.05' }, taxForeign: 20, totalForeign: 100, ...over,
}]])
const bill = (poLineById: Map<string, PurchaseInvoicePoLine>, unitCost: number, over: Record<string, unknown> = {}) => calculatePurchaseInvoice({
  lines: [{ kind: 'product', poLineId: 'p', qtyBilled: 1, unitCostForeign: unitCost }], fxRateToBase: 1, poReference: 'PO-1', transitAccount: '631', poTaxRatePercent: 0.05,
  poLineById, costLineById: new Map(), rateCandidates: candidates, ...over,
})

test('a non-draft order line recorded at 20% whose linked rate is now 5% bills at the RECORDED 20% on the 20% code', () => {
  const result = bill(line(), 100)
  assert.equal(result.taxForeign, 20, 'VAT at the recorded 20%, not the current 5%')
  assert.deepEqual([result.accountingLines[0].taxType, result.accountingLines[0].taxRateId, result.accountingLines[0].taxRateBasis], ['INPUT2', 'std', 'plain'])
  assert.deepEqual([result.lineTaxRates[0].rate, result.lineTaxRates[0].taxRateId], [0.2, 'std'])
})

test('with no active purchase code at the recorded rate the bill is REFUSED with a clear message; a line that agrees (or records nothing) is unchanged', () => {
  assert.throws(() => bill(line(), 100, { rateCandidates: [r('red', 0.05, 'INPUT5')] }), (e: unknown) => e instanceof PurchaseBillTaxRefusal
    && /SKU-1 has changed since the order was raised \(recorded 20%, now 5%\).*Correct the line's tax rate on the purchase order/.test(e.message))
  assert.throws(() => bill(line(), 100, { rateCandidates: [] }), PurchaseBillTaxRefusal)
  // An unmapped recorded code does not count.
  assert.throws(() => bill(line(), 100, { rateCandidates: [r('red', 0.05, 'INPUT5'), r('std', 0.2, '')] }), PurchaseBillTaxRefusal)
  // Agreeing: recorded 5 on 100 and the rate is 5%: the current rate and its own code.
  const same = bill(line({ taxForeign: 5 }), 100)
  assert.deepEqual([same.taxForeign, same.accountingLines[0].taxType, same.accountingLines[0].taxRateBasis], [5, 'INPUT5', 'purchase_line'])
  // Nothing recorded by the caller: the current rate, as before.
  const none = bill(line({ taxForeign: undefined, totalForeign: undefined }), 100)
  assert.deepEqual([none.taxForeign, none.accountingLines[0].taxType], [5, 'INPUT5'])
  // A reverse-charge or compound line that has diverged cannot be put back on a code safely.
  assert.throws(() => bill(line({ taxRate: { id: 'rc', accountingTaxType: 'RC', rate: '0.05', reverseCharge: true } }), 100), PurchaseBillTaxRefusal)
  assert.throws(() => bill(line({ taxRate: { id: 'c', accountingTaxType: 'INPUT5', rate: '0.05', isCompound: true, components: [{ rate: '0.05' }] } }), 100), PurchaseBillTaxRefusal)
})

test('where the recorded net is below 1 the ratio is unreliable: the current rate is accepted only if its tax reproduces the recorded tax within one minor unit, else refused', () => {
  // net 0.5, recorded tax 0.10 (20%); rate now 5% -> 0.03: not reproduced.
  assert.throws(() => bill(line({ taxForeign: 0.1, totalForeign: 0.5 }), 0.5), (e: unknown) => e instanceof PurchaseBillTaxRefusal && /too small/.test(e.message))
  // net 0.5, recorded tax 0.03 (rate unchanged at 5%): reproduced.
  assert.equal(bill(line({ taxForeign: 0.03, totalForeign: 0.5 }), 0.5).accountingLines[0].taxType, 'INPUT5')
  // net 0.05: any rate up to 20% reproduces 0.01 within a minor unit, so it is accepted (the header-level checks cover the rest).
  assert.equal(bill(line({ taxForeign: 0.01, totalForeign: 0.05 }), 0.05).accountingLines[0].taxType, 'INPUT5')
})

test('a booked line is untouched by the recorded-rate check (it keeps its snapshot)', () => {
  const result = calculatePurchaseInvoice({
    lines: [{ kind: 'product', id: 'l1', poLineId: 'p', qtyBilled: 1, unitCostForeign: 100, booked: { taxType: 'INPUT5', rate: 0.05, taxRateId: 'red', reverseCharge: false } }],
    fxRateToBase: 1, poReference: 'PO-1', transitAccount: '631', poTaxRatePercent: 0.05, poLineById: line(), costLineById: new Map(), rateCandidates: candidates,
  })
  assert.equal(result.taxForeign, 5)
})

test('wiring: create and edit read the recorded line tax and net and pass the rate candidates', () => {
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  assert.equal((source.match(/rateCandidates: orderRate\.candidates,/g) ?? []).length, 2)
  assert.equal((source.match(/What the order line recorded when it was priced/g) ?? []).length >= 1, true)
})

test('a credit against a legacy bill with one 20% line and one UNTYPED zero-rate line is refused (every blank type is undecided, whatever its rate)', () => {
  const taxed = { taxType: 'INPUT2', rate: 0.2, taxRateId: 'std' }
  for (const lines of [[taxed, { taxType: undefined, rate: 0 }], [{ taxType: undefined, rate: 0 }, taxed], [{ taxType: undefined, rate: 0 }], [{ taxType: '  ', rate: 0 }]]) {
    const result = resolveSupplierCreditNoteTaxType({ billHadTax: lines.length > 1, billLines: lines })
    assert.equal(result.taxType, undefined, JSON.stringify(lines))
    assert.notEqual(result.mixed, true, 'undecided, not a mixed bill')
  }
  // Typed exempt lines are a decided treatment (mixed with a taxed line they are refused as mixed); a single typed exempt bill still works.
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: false, billLines: [{ taxType: 'NONE', rate: 0 }] }).taxType, 'NONE')
  assert.equal(resolveSupplierCreditNoteTaxType({ billHadTax: true, billLines: [taxed, { taxType: 'NONE', rate: 0 }] }).mixed, true)
})
