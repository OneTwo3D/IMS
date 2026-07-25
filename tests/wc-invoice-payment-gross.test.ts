import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWcInvoicePaymentAmount } from '@/lib/connectors/woocommerce/sync/order-import'

// o3d-c0n: a paid tax-EXCLUSIVE WooCommerce order must settle its Xero invoice for the GROSS the customer
// paid (wcOrder.total). Previously order-import registered no explicit amount, so the payment
// sync-processor fell back to the NET line sum (no tax) and a taxed invoice was under-settled by its VAT —
// never PAID. Tax-INCLUSIVE orders are deliberately left on the fallback (o3d-cyn: their invoice is
// mis-built at the net total, so a gross payment would exceed it).

const paid = { date_paid_gmt: '2026-07-22T10:00:00', prices_include_tax: false }

test('a paid TAXED (tax-exclusive) order settles for its gross total, not the net subtotal (o3d-c0n)', () => {
  // net 80 goods + 16 VAT = 96 gross. The payment must be 96, not 80.
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '96.00' }), 96)
})

test('a paid non-taxed order is unchanged (net == gross)', () => {
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '80.00' }), 80)
})

test('a tax-INCLUSIVE order registers no explicit amount (falls back — o3d-cyn), avoiding an over-payment', () => {
  assert.equal(
    resolveWcInvoicePaymentAmount({ date_paid_gmt: '2026-07-22T10:00:00', prices_include_tax: true, total: '96.00' }),
    undefined,
  )
})

test('an unpaid order registers no payment amount', () => {
  assert.equal(resolveWcInvoicePaymentAmount({ date_paid_gmt: null, prices_include_tax: false, total: '96.00' }), undefined)
})

test('a zero / missing / non-numeric total registers no payment amount', () => {
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '0' }), undefined)
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '' }), undefined)
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: 'n/a' }), undefined)
})
