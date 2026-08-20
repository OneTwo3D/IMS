import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWcInvoicePaymentAmount } from '@/lib/connectors/woocommerce/sync/order-import'

// o3d-c0n: a paid WooCommerce order must settle its Xero invoice for the GROSS the customer paid
// (wcOrder.total). Previously order-import registered no explicit amount, so the payment sync-processor
// fell back to the NET line sum (no tax) and a taxed invoice was under-settled by its VAT — never PAID.
//
// o3d-cyn: this covers BOTH price conventions now. Tax-INCLUSIVE orders used to be excluded, because
// their invoice was CONSTRUCTED at the net total and a gross payment would have exceeded it; the
// construction now sends every component ex-tax on both conventions, so the invoice totals to
// wcOrder.total either way and the exclusion is gone.

const paid = { date_paid_gmt: '2026-07-22T10:00:00' }

// o3d-cyn r2: the second argument is the caller's finding about whether the document it is about to
// build will total to the order. Every case below is a document that DOES; the ones that do not have
// their own tests in wc-inclusive-invoice-total.test.ts.
const TOTALS = { totalsToTheOrder: true }

test('a paid TAXED (tax-exclusive) order settles for its gross total, not the net subtotal (o3d-c0n)', () => {
  // net 80 goods + 16 VAT = 96 gross. The payment must be 96, not 80.
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '96.00' }, TOTALS), 96)
})

test('a paid non-taxed order is unchanged (net == gross)', () => {
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '80.00' }, TOTALS), 80)
})

test('a paid tax-INCLUSIVE order settles for its gross total too (o3d-cyn removed the exclusion)', () => {
  // net 80 goods + 16 VAT = 96 gross, displayed inclusive of tax. The invoice is now built at 96 as
  // well, so the payment matches it exactly; before the fix this returned undefined because the
  // invoice was built at 80 and a 96 payment would have been rejected by Xero.
  assert.equal(
    resolveWcInvoicePaymentAmount({ date_paid_gmt: '2026-07-22T10:00:00', total: '96.00' }, TOTALS),
    96,
  )
})

test('an unpaid order registers no payment amount', () => {
  assert.equal(resolveWcInvoicePaymentAmount({ date_paid_gmt: null, total: '96.00' }, TOTALS), undefined)
})

test('a zero / missing / non-numeric total registers no payment amount', () => {
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '0' }, TOTALS), undefined)
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '' }, TOTALS), undefined)
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: 'n/a' }, TOTALS), undefined)
})
