import assert from 'node:assert/strict'
import test from 'node:test'

import { invoiceNumberIsExternallySupplied, resolveSalesInvoiceNumberForPost } from '@/lib/domain/accounting/sales-invoice-number'

// ---------------------------------------------------------------------------
// o3d-k26m.1 — one order, one invoice number, whichever route posts it.
//
// IMS reaches the accounting connector twice: the WooCommerce importer (which now records
// WooCommerce's `_wcpdf_invoice_number` on the order) and `queueSalesInvoiceForOrder` (draft
// finalisation), which used to derive `INV-<order number>` regardless of what the order already
// carried. The Xero sales-invoice create is an UPSERT ON InvoiceNumber, so two routes with two
// numbers is two documents in the ledger — not one document posted twice.
// ---------------------------------------------------------------------------

test('a number already recorded on the order is the one posted', () => {
  const result = resolveSalesInvoiceNumberForPost({
    persistedInvoiceNumber: '164981',
    fallbackPrefix: 'INV-',
    orderReference: '164981',
  })
  // The regression: 'INV-164981' — a second Xero document for an order already posted as 164981.
  assert.equal(result.invoiceNumber, '164981')
  assert.equal(result.source, 'persisted')
})

test('a manually generated IMS number is posted as printed, not re-derived', () => {
  const result = resolveSalesInvoiceNumberForPost({
    persistedInvoiceNumber: 'INV-2026-00042',
    fallbackPrefix: 'INV-',
    orderReference: 'SO-1001',
  })
  assert.equal(result.invoiceNumber, 'INV-2026-00042')
  assert.equal(result.source, 'persisted')
})

test('falls back to prefix + order reference only when nothing is recorded', () => {
  for (const persisted of [null, undefined, '', '   ']) {
    const result = resolveSalesInvoiceNumberForPost({
      persistedInvoiceNumber: persisted,
      fallbackPrefix: 'INV-',
      orderReference: 'SO-1001',
    })
    assert.equal(result.invoiceNumber, 'INV-SO-1001')
    assert.equal(result.source, 'derived')
  }
})

// o3d-k26m.1 — a storefront-supplied number must not be squatted on by an IMS-minted one.
//
// `SalesOrder.invoiceNumber` is now load-bearing: it is what gets posted, and the WooCommerce
// backfill that captures `_wcpdf_invoice_number` is guarded on the column being null. So an
// invoice number minted into it (the on-shipped trigger does exactly that) would both post the
// order under a number the customer's own invoice does not carry AND permanently block the real
// number from ever landing.

test('WooCommerce orders take their invoice number from the storefront', () => {
  assert.equal(invoiceNumberIsExternallySupplied(['woocommerce']), true)
  assert.equal(invoiceNumberIsExternallySupplied(['shiphero', 'woocommerce']), true)
})

test('orders with no storefront link, or a connector that supplies no number, still mint', () => {
  assert.equal(invoiceNumberIsExternallySupplied([]), false)
  assert.equal(invoiceNumberIsExternallySupplied(['mintsoft']), false)
})
