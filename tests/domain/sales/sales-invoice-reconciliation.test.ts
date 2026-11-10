import assert from 'node:assert/strict'
import test from 'node:test'

import { SalesInvoiceNotQueuedError, assertInvoiceQueuedOrNotOwed, invoiceReconciliationProblem, reconciliationBound, type ReconcilableInvoice } from '@/lib/domain/sales/sales-invoice-reconciliation'

const exclusive = (storedTax: number, extra: Partial<ReconcilableInvoice> = {}): ReconcilableInvoice => ({
  lineAmountsIncludeTax: false, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 100, rate: 0.2, storedTax }], ...extra,
})

test('a consistent invoice reconciles exactly', () => {
  assert.equal(invoiceReconciliationProblem(exclusive(20), 120), null)
  assert.equal(invoiceReconciliationProblem({ lineAmountsIncludeTax: true, headerRate: 0.2, lines: [{ quantity: 1, unitAmount: 120, rate: 0.2, storedTax: 20 }], shippingAmount: 12, discountAmount: 6 }, 126), null)
})

// [mutation: shrink the bound to nothing, or widen it to swallow a real mismatch]
test('rounding of a few pennies is within the bound (0.005 per line plus 0.03), a real difference is not', () => {
  assert.equal(invoiceReconciliationProblem(exclusive(20), 120.02), null, 'two pennies on one line')
  assert.equal(invoiceReconciliationProblem(exclusive(20), 119.97), null, 'three pennies is within the bound for one line (0.035)')
  assert.notEqual(invoiceReconciliationProblem(exclusive(20), 120.05), null, 'five pennies is not rounding')
  const three = { lineAmountsIncludeTax: false, headerRate: 0.2, lines: [1, 2, 3].map(() => ({ quantity: 1, unitAmount: 33.33, rate: 0.2, storedTax: 6.67 })) }
  assert.equal(invoiceReconciliationProblem(three, 120.03), null, 'three lines: 0.045')
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

// [mutation: remove the cap, or widen the per-line allowance]
test('the bound grows only with what rounding can produce and is capped at 1.00', () => {
  assert.equal(reconciliationBound(0), 0.03)
  assert.equal(reconciliationBound(1), 0.035)
  assert.equal(reconciliationBound(100), 0.53)
  assert.equal(reconciliationBound(194), 1)
  assert.equal(reconciliationBound(5000), 1, 'a huge order is not allowed to hide a whole unit')
})

const many = (n: number, rate: number | null, storedTax: number): ReconcilableInvoice => ({
  lineAmountsIncludeTax: false, headerRate: 0.2, lines: Array.from({ length: n }, () => ({ quantity: 1, unitAmount: 33.33, rate, storedTax })),
})

test('a many-line order whose total differs from the invoice by more than rounding is refused (300 lines, 1.50 out)', () => {
  const invoice = many(300, 0.2, 6.67) // the ledger books 300 x 39.996 = 11998.80
  const refused = invoiceReconciliationProblem(invoice, 11997.3)
  assert.deepEqual(refused, { expected: 11998.8, orderTotal: 11997.3, difference: 1.5 })
})

test('a legitimate many-line rounding case passes: 100 lines whose tax was rounded up a fraction of a penny each (0.40 in total, bound 0.53)', () => {
  // Each line: 33.33 + tax 6.666 = 39.996 at the ledger; the order stored 33.33 + 6.67 = 40.00 a line, so 4000.00 against 3999.60.
  assert.equal(invoiceReconciliationProblem(many(100, 0.2, 6.67), 4000), null)
})

// [mutation: treat a refusal as owed nothing, or a shadow as a refusal]
test('an in-transaction invoice enqueue is accepted when queued, shadowed or not configured, and a refusal throws so the transaction rolls back', () => {
  assertInvoiceQueuedOrNotOwed({ queued: true })
  assertInvoiceQueuedOrNotOwed({ queued: false, reason: 'shadowed' })
  assertInvoiceQueuedOrNotOwed({ queued: false, reason: 'not-configured' })
  for (const reason of ['refused', 'hand-post-deferred', undefined]) {
    assert.throws(() => assertInvoiceQueuedOrNotOwed({ queued: false, reason }), SalesInvoiceNotQueuedError, String(reason))
  }
})
