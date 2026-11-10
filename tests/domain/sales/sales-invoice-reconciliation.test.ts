import assert from 'node:assert/strict'
import test from 'node:test'

import { invoiceReconciliationProblem, type ReconcilableInvoice } from '@/lib/domain/sales/sales-invoice-reconciliation'

const exclusive = (storedTax: number, extra: Partial<ReconcilableInvoice> = {}): ReconcilableInvoice => ({
  lineAmountsIncludeTax: false, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 100, rate: 0.2, storedTax }], ...extra,
})

test('a consistent invoice reconciles exactly', () => {
  assert.equal(invoiceReconciliationProblem(exclusive(20), 120), null)
  assert.equal(invoiceReconciliationProblem({ lineAmountsIncludeTax: true, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 120, rate: 0.2, storedTax: 20 }], shippingAmount: 12, discountAmount: 6 }, 126), null)
})

// [mutation: shrink the bound to nothing, or widen it to swallow a real mismatch]
test('rounding of a few pennies is within the bound (0.01 per line plus two), a real difference is not', () => {
  assert.equal(invoiceReconciliationProblem(exclusive(20), 120.02), null, 'two pennies on one line')
  assert.equal(invoiceReconciliationProblem(exclusive(20), 119.97), null, 'three pennies is the bound for one line')
  assert.notEqual(invoiceReconciliationProblem(exclusive(20), 120.05), null, 'five pennies is not rounding')
  const three = { lineAmountsIncludeTax: false, headerRate: 0.2, lines: [1, 2, 3].map(() => ({ quantity: 1, unitAmount: 33.33, rate: 0.2, storedTax: 6.67 })) }
  assert.equal(invoiceReconciliationProblem(three, 120.03), null, 'three lines widen the bound to five pennies')
})

test('the shipping that takes the header rate while the order taxed it at 0% is a 2.00 mismatch', () => {
  const p = invoiceReconciliationProblem(exclusive(20, { shippingAmount: 10 }), 130)
  assert.deepEqual(p, { expected: 132, orderTotal: 130, difference: 2 })
})

// [mutation: price the lines from their stored VAT instead of the code they are sent on]
test('tax is priced from the code each part is SENT on, not from the VAT the order stored', () => {
  // A 10 fee stored with no VAT but sent on the taxable code: the ledger adds 2.00 the order never charged.
  const sentTaxable = { lineAmountsIncludeTax: false, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 100, rate: 0.2, storedTax: 20 }, { quantity: 1, unitAmount: 10, rate: 0.2, storedTax: 0 }] }
  assert.deepEqual(invoiceReconciliationProblem(sentTaxable, 130), { expected: 132, orderTotal: 130, difference: 2 })
  // The same fee sent on a no-tax code reconciles.
  const sentExempt = { ...sentTaxable, lines: [sentTaxable.lines[0]!, { quantity: 1, unitAmount: 10, rate: 0, storedTax: 0 }] }
  assert.equal(invoiceReconciliationProblem(sentExempt, 130), null)
})

test('a code nobody can price falls back to the stored VAT; shipping and the discount fall back to the header rate', () => {
  const unknown = { lineAmountsIncludeTax: false, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 100, rate: null, storedTax: 20 }], shippingAmount: 10, discountAmount: 5 }
  assert.equal(invoiceReconciliationProblem(unknown, 126), null)
  assert.deepEqual(invoiceReconciliationProblem({ ...unknown, shippingRate: 0, discountRate: 0 }, 126), { expected: 125, orderTotal: 126, difference: -1 })
})
