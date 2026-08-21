import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WC_PDF_INVOICE_NUMBER_META_KEY,
  resolveWcAccountingInvoiceNumber,
} from '@/lib/connectors/woocommerce/sync/invoice-number'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

// ---------------------------------------------------------------------------
// o3d-k26m.1 — the accounting invoice number for a WooCommerce order is WooCommerce's.
//
// xeroom takes it from `_wcpdf_invoice_number` (xeroom_invoice_no_active=meta) and has done so
// for 14,415 orders since 2021-07-04; order 164981 posted to Xero as invoice 164981. IMS used to
// build `INWC-164981` instead, which breaks the sequence AND — because the two numbers differ —
// hides an accidental double-post during cutover behind two documents that don't look alike.
//
// These pin the two halves that decide what reaches the ledger: the exact number when the meta
// is there, and a REFUSAL (never a substitute) when it is not.
// ---------------------------------------------------------------------------

function order(meta: Array<{ key: string; value: unknown }>, number = '164981'): WcFullOrder {
  return {
    id: 987654,
    number,
    meta_data: meta.map((m, i) => ({ id: i, key: m.key, value: m.value })),
  } as unknown as WcFullOrder
}

test('takes _wcpdf_invoice_number verbatim — no prefix, exactly what xeroom posted', () => {
  const result = resolveWcAccountingInvoiceNumber(order([{ key: '_wcpdf_invoice_number', value: '164981' }]))
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.invoiceNumber, '164981')
  // The regression this guards: INWC-164981, INV-164981, or any other decoration.
  assert.equal(result.ok && result.invoiceNumber.startsWith('INWC-'), false)
})

test('keeps a formatted number exactly as the PDF prints it', () => {
  const result = resolveWcAccountingInvoiceNumber(order([{ key: '_wcpdf_invoice_number', value: ' 2026-000412 ' }]))
  assert.equal(result.ok && result.invoiceNumber, '2026-000412')
})

test('accepts a numeric meta value (WC REST is not consistent about the type)', () => {
  const result = resolveWcAccountingInvoiceNumber(order([{ key: '_wcpdf_invoice_number', value: 164981 }]))
  assert.equal(result.ok && result.invoiceNumber, '164981')
})

test('refuses — with the meta key named — when WooCommerce has not numbered the invoice yet', () => {
  const result = resolveWcAccountingInvoiceNumber(order([{ key: '_billing_vat', value: 'GB123' }]))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.metaKey, '_wcpdf_invoice_number')
  assert.equal(
    result.ok === false && result.reason,
    'WooCommerce order 164981 carries no _wcpdf_invoice_number; the invoice number is assigned by WooCommerce PDF Invoices and IMS will not invent one.',
  )
})

test('a blank meta value is "not numbered yet", not an invoice number', () => {
  const result = resolveWcAccountingInvoiceNumber(order([{ key: '_wcpdf_invoice_number', value: '   ' }]))
  assert.equal(
    result.ok === false && result.reason,
    'WooCommerce order 164981 has a blank _wcpdf_invoice_number; the PDF plugin has not numbered this invoice yet.',
  )
})

test('zero is refused rather than posted as invoice "0"', () => {
  const asString = resolveWcAccountingInvoiceNumber(order([{ key: '_wcpdf_invoice_number', value: '0' }]))
  assert.equal(
    asString.ok === false && asString.reason,
    'WooCommerce order 164981 has _wcpdf_invoice_number=0, which is not a usable invoice number.',
  )
  const asNumber = resolveWcAccountingInvoiceNumber(order([{ key: '_wcpdf_invoice_number', value: 0 }]))
  assert.equal(
    asNumber.ok === false && asNumber.reason,
    'WooCommerce order 164981 has _wcpdf_invoice_number=0, which is not a usable invoice number.',
  )
})

test('a non-scalar meta value is refused, not stringified into a document number', () => {
  const result = resolveWcAccountingInvoiceNumber(order([{ key: '_wcpdf_invoice_number', value: { number: 164981 } }]))
  assert.equal(
    result.ok === false && result.reason,
    'WooCommerce order 164981 has a non-scalar _wcpdf_invoice_number (object); refusing to derive an invoice number from it.',
  )
})

test('falls back to the WC order id in the refusal when the order has no number', () => {
  const result = resolveWcAccountingInvoiceNumber({ id: 987654, number: '', meta_data: [] } as unknown as WcFullOrder)
  assert.equal(
    result.ok === false && result.reason,
    'WooCommerce order 987654 carries no _wcpdf_invoice_number; the invoice number is assigned by WooCommerce PDF Invoices and IMS will not invent one.',
  )
})

test('the meta key is overridable (xeroom_inv_number_meta_key has an equivalent setting)', () => {
  const result = resolveWcAccountingInvoiceNumber(
    order([{ key: '_custom_invoice_no', value: 'X-9' }, { key: '_wcpdf_invoice_number', value: '164981' }]),
    { metaKey: '_custom_invoice_no' },
  )
  assert.equal(result.ok && result.invoiceNumber, 'X-9')
  assert.equal(result.ok && result.metaKey, '_custom_invoice_no')
})

test('the default key is the one xeroom reads', () => {
  assert.equal(WC_PDF_INVOICE_NUMBER_META_KEY, '_wcpdf_invoice_number')
})
