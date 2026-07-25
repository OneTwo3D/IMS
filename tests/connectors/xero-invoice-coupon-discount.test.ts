import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSalesInvoicePayload } from '@/lib/connectors/xero/invoices'

type Line = { Quantity?: number; UnitAmount?: number; DiscountRate?: number; AccountCode?: string; Description?: string }

/** What Xero will actually charge: each line after its DiscountRate, summed (a negative line subtracts). */
function effectiveTotal(payload: Record<string, unknown>): number {
  const lines = (payload.LineItems ?? []) as Line[]
  return lines.reduce((sum, l) => {
    const gross = (l.Quantity ?? 0) * (l.UnitAmount ?? 0)
    return sum + gross * (1 - (l.DiscountRate ?? 0) / 100)
  }, 0)
}

/**
 * A WooCommerce CART coupon reaches the invoice builder TWICE.
 *
 * mapWcLineItems derives a per-line discountAmount as (subtotal - total), and mapWcOrderDiscount separately
 * sums coupon_lines into an order-level discountAmount; order-import.ts sends BOTH
 * (sync/order-import.ts:780 and :789). buildSalesInvoicePayload then applies the per-line figure as a Xero
 * DiscountRate AND appends the order-level figure as a negative "Order discount" line — so a single coupon
 * is deducted twice whenever xero_discount_account is configured (it is: 210 on the rig and on stage).
 */
test('a cart coupon is deducted ONCE, not twice, when a discount account is configured', { skip: 'CONFIRMED DEFECT o3d-y14 — currently builds 80 for a 90 order. Un-skip with the fix; do not "correct" the expectation.' }, () => {
  // £100 of goods with a £10 cart coupon. Woo's order total is therefore £90.
  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'E2E-COUPON-1',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200', discountAmount: 10 }],
      discountAmount: 10,
      discountAccountCode: '210',
    } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )

  assert.equal(
    effectiveTotal(payload),
    90,
    'the invoice must equal the Woo order total (100 goods - 10 coupon); 80 means the coupon was applied ' +
      'both as a per-line DiscountRate and as an order-level negative line',
  )
})

test('a per-line discount with NO order-level coupon is unaffected', () => {
  // The control: a genuine per-line markdown with no coupon_lines must still discount exactly once.
  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'E2E-COUPON-2',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200', discountAmount: 10 }],
      discountAccountCode: '210',
    } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )
  assert.equal(effectiveTotal(payload), 90)
})

test('an order-level discount with NO per-line discount is unaffected', () => {
  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'E2E-COUPON-3',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200' }],
      discountAmount: 10,
      discountAccountCode: '210',
    } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )
  assert.equal(effectiveTotal(payload), 90)
})
