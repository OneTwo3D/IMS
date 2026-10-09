import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculatePurchaseInvoice,
  PURCHASE_INVOICE_INPUTS_CHANGED_MESSAGE,
  purchaseInvoiceInputsChanged,
  type PurchaseInvoiceTaxInputs,
} from '@/lib/domain/purchasing/purchase-invoice-edit'

/**
 * A BILL'S VAT ON A FREIGHT ORDER USES THE ORDER'S RECORDED RATE ON THE VATABLE LINES BILLED, not the blended
 * `order tax / whole order subtotal`. 100 vatable + 100 exempt at 20% is a PO VAT of 20 on a subtotal of 200, a
 * blended 10%: billing the vatable 100 alone used to record 10 instead of 20.
 */

const costLines = new Map([
  ['vat', { id: 'vat', description: 'Duty', amountForeign: 100, vatable: true }],
  ['exempt', { id: 'exempt', description: 'Handling', amountForeign: 100, vatable: false }],
])
const base = (over: Record<string, unknown> = {}) => calculatePurchaseInvoice({
  lines: [{ kind: 'cost', costLineId: 'vat', amountForeign: 100 }],
  fxRateToBase: 1,
  poReference: 'F-1',
  poSubtotalForeign: 200,
  poTaxForeign: 20,
  transitAccount: '631',
  poLineById: new Map(),
  costLineById: costLines,
  ...over,
} as never)

test('freight bill: partial bill of the vatable line records 20 (the order rate), not the blended 10', () => {
  const bill = base({ poType: 'FREIGHT', poTaxRatePercent: '0.2000' })
  console.log(`freight bill PRECONDITION: PO tax 20 / subtotal 200 (blended 10%), billing vatable 100 -> tax ${bill.taxForeign}, total ${bill.totalForeign}`)
  assert.equal(bill.taxForeign, 20)
  assert.equal(bill.totalForeign, 120)
  // The exempt line alone carries no VAT.
  assert.equal(base({ poType: 'FREIGHT', poTaxRatePercent: '0.2', lines: [{ kind: 'cost', costLineId: 'exempt', amountForeign: 100 }] }).taxForeign, 0)
  // Both lines: 20 on the vatable one.
  assert.equal(base({ poType: 'FREIGHT', poTaxRatePercent: '0.2', lines: [{ kind: 'cost', costLineId: 'vat', amountForeign: 100 }, { kind: 'cost', costLineId: 'exempt', amountForeign: 100 }] }).taxForeign, 20)
})

test('non-freight order and a freight order with no recorded rate keep the blended rate (unchanged behaviour)', () => {
  const goods = base({ poType: 'GOODS', poTaxRatePercent: '0.2' })
  const legacyFreight = base({ poType: 'FREIGHT', poTaxRatePercent: null })
  console.log(`unchanged PRECONDITION: GOODS with a rate -> tax ${goods.taxForeign}; FREIGHT with no recorded rate -> tax ${legacyFreight.taxForeign}`)
  assert.equal(goods.taxForeign, 10)
  assert.equal(legacyFreight.taxForeign, 10)
})

const snapshot = (over: Partial<PurchaseInvoiceTaxInputs> = {}): PurchaseInvoiceTaxInputs => ({
  fxRateToBase: '1.00000000', type: 'FREIGHT', taxRatePercent: '0.2000', taxForeign: '20.0000', subtotalForeign: '200.0000',
  costLines: [{ id: 'vat', description: 'Duty', amountForeign: '100.0000', vatable: true }, { id: 'exempt', description: 'Handling', amountForeign: '100.0000', vatable: false }],
  ...over,
})

test('inputs changed: identical snapshots (numeric strings that differ only in scale, reordered lines) are unchanged; each consumed field is detected', () => {
  assert.equal(purchaseInvoiceInputsChanged(snapshot(), snapshot({ taxForeign: '20', fxRateToBase: '1' })), false)
  assert.equal(purchaseInvoiceInputsChanged(snapshot(), snapshot({ costLines: [...snapshot().costLines].reverse() })), false)
  const flipped = snapshot({ costLines: [{ id: 'vat', description: 'Duty', amountForeign: '100.0000', vatable: false }, snapshot().costLines[1]!] })
  const results = {
    vatableFlag: purchaseInvoiceInputsChanged(snapshot(), flipped),
    rate: purchaseInvoiceInputsChanged(snapshot(), snapshot({ taxRatePercent: '0.1' })),
    recordedRateAppeared: purchaseInvoiceInputsChanged(snapshot({ taxRatePercent: null }), snapshot()),
    tax: purchaseInvoiceInputsChanged(snapshot(), snapshot({ taxForeign: '0' })),
    amount: purchaseInvoiceInputsChanged(snapshot(), snapshot({ costLines: [{ id: 'vat', description: 'Duty', amountForeign: '110', vatable: true }, snapshot().costLines[1]!] })),
    lineGone: purchaseInvoiceInputsChanged(snapshot(), snapshot({ costLines: [snapshot().costLines[0]!] })),
    fx: purchaseInvoiceInputsChanged(snapshot(), snapshot({ fxRateToBase: '1.1' })),
  }
  console.log(`inputs-changed PRECONDITION: ${JSON.stringify(results)}`)
  assert.deepEqual(Object.values(results), Object.values(results).map(() => true))
  assert.match(PURCHASE_INVOICE_INPUTS_CHANGED_MESSAGE, /not saved/)
})
