import assert from 'node:assert/strict'
import test from 'node:test'

import { calculatePurchaseInvoice, type PurchaseInvoiceCostLine, type PurchaseInvoicePoLine } from '@/lib/domain/purchasing/purchase-invoice-edit'

/**
 * ACC-H2: a bill's VAT is each billed line's OWN rate on its own net, never the blended `PO tax / PO subtotal`. The PO's tax includes the
 * VAT on its vatable cost lines while its subtotal does not, so goods 100 @ 20% plus vatable freight 50 gave a "rate" of 30% and a bill VAT of 45
 * where 30 is right. A part-billed mixed-rate order has no single rate at all.
 *
 * The legacy `poSubtotalForeign` / `poTaxForeign` the old callers passed are still supplied here (and ignored): against the old code they
 * produce the blended answer, which is what makes these assertions fail without the fix.
 */

const legacy = (subtotal: number, tax: number) => ({ poSubtotalForeign: subtotal, poTaxForeign: tax })

const poLines = new Map<string, PurchaseInvoicePoLine>([
  ['std', { id: 'std', qty: 10, product: { sku: 'STD' }, taxRate: { accountingTaxType: 'INPUT2', rate: '0.2' }, totalForeign: 100, taxForeign: 20 }],
  ['low', { id: 'low', qty: 10, product: { sku: 'LOW' }, taxRate: { accountingTaxType: 'INPUT5', rate: '0.05' }, totalForeign: 100, taxForeign: 5 }],
  ['zero', { id: 'zero', qty: 10, product: { sku: 'ZERO' }, taxRate: { accountingTaxType: 'ZERORATEDINPUT', rate: '0' }, totalForeign: 100, taxForeign: 0 }],
  ['compound', { id: 'compound', qty: 10, product: { sku: 'CMP' }, taxRate: { accountingTaxType: 'INPUT2', rate: '0.1', isCompound: true, components: [{ id: 'c1' }] }, totalForeign: 100, taxForeign: 21 }],
])
const costLines = new Map<string, PurchaseInvoiceCostLine>([
  ['freight', { id: 'freight', description: 'Freight', amountForeign: 50, vatable: true }],
  ['handling', { id: 'handling', description: 'Handling', amountForeign: 50, vatable: false }],
])
const bill = (lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => calculatePurchaseInvoice({
  lines: lines as never, fxRateToBase: 1, poReference: 'PO-1', transitAccount: '631', fallbackTaxType: 'INPUT2', poLineById: poLines, costLineById: costLines, ...over,
} as never)
const goods = (id: string, net = 100) => ({ kind: 'product', poLineId: id, qtyBilled: 1, unitCostForeign: net })
const cost = (id: string, amountForeign = 50) => ({ kind: 'cost', costLineId: id, amountForeign })

test('goods 100 @ 20% + vatable freight 50: VAT is 30, not the blended 45', () => {
  const result = bill([goods('std'), cost('freight')], { poType: 'GOODS', poTaxRatePercent: '0.2', ...legacy(100, 30) })
  assert.equal(result.taxForeign, 30)
  assert.equal(result.subtotalForeign, 150)
  assert.equal(result.totalForeign, 180)
  assert.equal(result.taxBase, 30)
})

test('a mixed-rate order billed in part uses the billed line\'s own rate: the 5% line alone is 5, not the blended 12.5', () => {
  const only5 = bill([goods('low')], { poType: 'GOODS', poTaxRatePercent: '0.2', ...legacy(200, 25) })
  assert.equal(only5.taxForeign, 5)
  const only20 = bill([goods('std')], { poType: 'GOODS', poTaxRatePercent: '0.2', ...legacy(200, 25) })
  assert.equal(only20.taxForeign, 20)
  const both = bill([goods('std'), goods('low'), goods('zero')], { poType: 'GOODS', poTaxRatePercent: '0.2', ...legacy(300, 25) })
  assert.equal(both.taxForeign, 25)
  assert.equal(both.totalForeign, 325)
})

test('the bill total reconciles: total = net + sum of each line\'s own tax, header = lines, base = foreign / fx', () => {
  const result = bill([goods('std', 80), goods('low', 40), cost('freight', 25), cost('handling', 10)], { poType: 'GOODS', poTaxRatePercent: '0.2', fxRateToBase: 2, ...legacy(120, 40) })
  const expected = 80 * 0.2 + 40 * 0.05 + 25 * 0.2
  assert.equal(result.taxForeign, expected)
  assert.equal(result.totalForeign, result.subtotalForeign + expected)
  assert.equal(result.subtotalForeign, 155)
  assert.equal(result.taxBase, expected / 2)
  assert.equal(result.totalBase, (155 + expected) / 2)
})

test('a non-vatable cost line carries no VAT; a vatable one takes the order\'s rate; no recorded rate means none', () => {
  assert.equal(bill([cost('handling')], { poType: 'GOODS', poTaxRatePercent: '0.2', ...legacy(100, 20) }).taxForeign, 0)
  assert.equal(bill([cost('freight')], { poType: 'GOODS', poTaxRatePercent: '0.2', ...legacy(100, 20) }).taxForeign, 10)
  assert.equal(bill([cost('freight')], { poType: 'GOODS', poTaxRatePercent: null, ...legacy(100, 20) }).taxForeign, 0)
})

test('a compound rate uses the line\'s own recorded effective rate (21%), not its stored 10%', () => {
  assert.equal(bill([goods('compound')], { poType: 'GOODS', poTaxRatePercent: '0.2', ...legacy(100, 21) }).taxForeign, 21)
})

test('a goods line with no rate row takes the order rate; a FREIGHT order taxes every line at its recorded rate', () => {
  const noRate = new Map<string, PurchaseInvoicePoLine>([['none', { id: 'none', qty: 1, product: { sku: 'N' }, taxRate: null }]])
  assert.equal(bill([goods('none')], { poType: 'GOODS', poTaxRatePercent: '0.2', poLineById: noRate, ...legacy(100, 20) }).taxForeign, 20)
  assert.equal(bill([goods('low')], { poType: 'FREIGHT', poTaxRatePercent: '0.2', ...legacy(100, 20) }).taxForeign, 20)
})
