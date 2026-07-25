import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSalesInvoicePayload } from '@/lib/connectors/xero/invoices'
import { resolveWcOrderLevelDiscount } from '@/lib/connectors/woocommerce/sync/field-mapping'

type Line = {
  Quantity?: number; UnitAmount?: number; DiscountRate?: number; DiscountAmount?: number
  AccountCode?: string; Description?: string
}

/** What Xero will actually charge: each line after its discount, summed (a negative line subtracts). */
function effectiveTotal(payload: Record<string, unknown>): number {
  const lines = (payload.LineItems ?? []) as Line[]
  return lines.reduce((sum, l) => {
    const gross = (l.Quantity ?? 0) * (l.UnitAmount ?? 0)
    const discounted = l.DiscountAmount != null ? gross - l.DiscountAmount : gross * (1 - (l.DiscountRate ?? 0) / 100)
    return sum + discounted
  }, 0)
}

/**
 * o3d-y14. A WooCommerce CART coupon used to reach the invoice builder TWICE: mapWcLineItems derives
 * a per-line discountAmount as (subtotal - total), and mapWcOrderDiscount separately sums coupon_lines
 * into an order-level discountAmount — and order-import.ts sent BOTH. buildSalesInvoicePayload applies
 * the per-line figure as a Xero DiscountRate AND appends the order-level figure as a negative
 * "Order discount" line, so a £90 order posted as £80.
 *
 * The fix is UPSTREAM of this builder, and deliberately so. Both legs are correct for a NATIVE IMS
 * order: app/actions/sales.ts stores `orderDiscountForeign` as a real order-level discount, on top of
 * any per-line markdown, and deducts it from the order total. Netting the two off inside the builder
 * would silently drop that genuine discount. So the builder keeps applying whatever it is given, and
 * the WooCommerce importer stops claiming the coupon twice — see resolveWcOrderLevelDiscount.
 */

test('the coupon a WC order actually carries is deducted ONCE end-to-end', () => {
  // £100 of goods with a £10 cart coupon. Woo reduces the LINE totals by £10, and reports the same
  // £10 in coupon_lines — so the importer sees couponTotal 10 and lineDiscountTotal 10.
  const { orderLevelDiscount } = resolveWcOrderLevelDiscount({
    couponTotalForeign: 10,
    lineDiscountTotalForeign: 10,
  })

  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'E2E-COUPON-1',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200', discountAmount: 10 }],
      discountAmount: orderLevelDiscount > 0 ? orderLevelDiscount : undefined,
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
  assert.equal(
    (payload.LineItems as Line[]).some((l) => l.Description === 'Order discount'),
    false,
    'no order-level discount line, because Woo already put the coupon on the lines',
  )
})

test('coupon money Woo left off the lines still reaches the invoice', () => {
  // The unmodelled shape: the importer keeps the residual rather than dropping it, which would
  // OVERSTATE the invoice by money the customer was never charged.
  const { orderLevelDiscount } = resolveWcOrderLevelDiscount({
    couponTotalForeign: 10,
    lineDiscountTotalForeign: 0,
  })

  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'E2E-COUPON-4',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200' }],
      discountAmount: orderLevelDiscount > 0 ? orderLevelDiscount : undefined,
      discountAccountCode: '210',
    } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )

  assert.equal(effectiveTotal(payload), 90)
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

test('a NATIVE order keeps BOTH legs — the builder must not net them off', () => {
  // app/actions/sales.ts stores orderDiscountForeign as a discount ON TOP of per-line markdowns and
  // deducts it from the order total. £100 goods, £10 line markdown, £5 order discount = £85.
  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'NATIVE-1',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200', discountAmount: 10 }],
      discountAmount: 5,
      discountAccountCode: '210',
    } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )
  assert.equal(effectiveTotal(payload), 85)
})


test('a discount too small to express as a percentage is not silently lost', () => {
  // Xero stores DiscountRate to 2dp, so £0.01 off a £1,000.00 line is 0.001% — it rounded to 0.00 and
  // the discount vanished, posting £1,000.00 for a £999.99 order. It went unnoticed while the same
  // coupon was ALSO sent as an order-level line: the duplicate made small discounts land while
  // double-counting every normal one. The line now carries DiscountAmount, so nothing is converted.
  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'PRECISION-1',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 1, unitAmount: 1000, accountCode: '200', discountAmount: 0.01 }],
      discountAccountCode: '210',
    } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )

  const line = (payload.LineItems as Line[])[0]
  assert.equal(line.DiscountAmount, 0.01, 'the exact amount, not a percentage of it')
  assert.equal(line.DiscountRate, undefined, 'and never both — Xero takes one or the other')
  assert.equal(effectiveTotal(payload), 999.99)
})

test('an awkward fraction survives too, where a rounded percentage would drift', () => {
  // 3.33 off 9.99 is 33.3333…%, which as a 2dp rate (33.33) leaves the line at 6.660333 — a third of a
  // penny out on one line, and it scales with the order.
  const payload = buildSalesInvoicePayload(
    {
      invoiceNumber: 'PRECISION-2',
      date: '2026-07-25',
      lines: [{ description: 'Widget', quantity: 3, unitAmount: 3.33, accountCode: '200', discountAmount: 3.33 }],
      discountAccountCode: '210',
    } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )
  assert.equal((payload.LineItems as Line[])[0].DiscountAmount, 3.33)
  assert.equal(effectiveTotal(payload), 6.66)
})
