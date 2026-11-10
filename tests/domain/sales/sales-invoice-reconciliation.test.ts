import assert from 'node:assert/strict'
import test from 'node:test'

import { invoiceReconciliationProblem, type ReconcilableInvoice } from '@/lib/domain/sales/sales-invoice-reconciliation'

const exclusive = (storedTax: number, extra: Partial<ReconcilableInvoice> = {}): ReconcilableInvoice => ({
  lineAmountsIncludeTax: false, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 100, storedTax }], ...extra,
})

test('a consistent invoice reconciles exactly', () => {
  assert.equal(invoiceReconciliationProblem(exclusive(20), 120), null)
  assert.equal(invoiceReconciliationProblem({ lineAmountsIncludeTax: true, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 120, storedTax: 20 }], shippingAmount: 12, discountAmount: 6 }, 126), null)
})

// [mutation: shrink the bound to nothing, or widen it to swallow a real mismatch]
test('rounding of a few pennies is within the bound (0.01 per line plus two), a real difference is not', () => {
  assert.equal(invoiceReconciliationProblem(exclusive(20), 120.02), null, 'two pennies on one line')
  assert.equal(invoiceReconciliationProblem(exclusive(20), 119.97), null, 'three pennies is the bound for one line')
  assert.notEqual(invoiceReconciliationProblem(exclusive(20), 120.05), null, 'five pennies is not rounding')
  const three = { lineAmountsIncludeTax: false, headerRate: 0.2, lines: [1, 2, 3].map(() => ({ quantity: 1, unitAmount: 33.33, storedTax: 6.67 })) }
  assert.equal(invoiceReconciliationProblem(three, 120.03), null, 'three lines widen the bound to five pennies')
})

test('the shipping that takes the header rate while the order taxed it at 0% is a 2.00 mismatch', () => {
  const p = invoiceReconciliationProblem(exclusive(20, { shippingAmount: 10 }), 130)
  assert.deepEqual(p, { expected: 132, orderTotal: 130, difference: 2 })
})
