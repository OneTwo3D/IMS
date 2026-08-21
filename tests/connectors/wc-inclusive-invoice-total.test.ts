import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// mapWcLineItems only touches the database to map SKU → productId; no product rows means
// every line falls through as an unmapped SKU, which is irrelevant to the arithmetic here.
mock.module('@/lib/db', {
  namedExports: { db: { product: { findMany: async () => [] } } },
})

// Loaded through `import()` AFTER the mock above: a static import would hoist above it and pull in
// the real Prisma client.
const fieldMapping = () => import('@/lib/connectors/woocommerce/sync/field-mapping')
const orderImport = () => import('@/lib/connectors/woocommerce/sync/order-import')
const xeroInvoices = () => import('@/lib/connectors/xero/invoices')

import type { WcLineItem, WcCouponLine } from '@/lib/connectors/woocommerce/sync/types'

/**
 * o3d-cyn. A tax-INCLUSIVE WooCommerce store built its Xero invoice at the NET total.
 *
 * WC REST reports `line_items[].subtotal` / `.total` (and `coupon_lines[].discount`, and
 * `shipping_lines[].total`) EX-TAX on BOTH price conventions — the tax is in the parallel
 * `*_tax` fields. The importer sent those ex-tax amounts with `lineAmountsIncludeTax` set from
 * `prices_include_tax`, so for an inclusive store Xero read a net 100 line as a gross one and
 * extracted the VAT back out of it: an order that grossed 120 posted as an invoice of 100.
 * Shipping was singled out and multiplied by (1 + rate) to compensate, which made the document
 * internally inconsistent as well as wrong.
 *
 * The assertion these tests are built around is the one the issue asks for: THE CONSTRUCTED
 * DOCUMENT TOTAL EQUALS `wcOrder.total`, for the inclusive AND the exclusive convention, with
 * and without a coupon.
 */

const RATE = 0.2 // fractional, not a percentage

type XeroLine = {
  Quantity?: number; UnitAmount?: number; DiscountAmount?: number; AccountCode?: string; Description?: string
}

/**
 * What Xero will make of the payload: every line after its discount, then tax added or extracted
 * according to LineAmountTypes. Xero rounds tax per line, which is what `roundPenny` models.
 */
function roundPenny(value: number): number {
  return Math.round(value * 100) / 100
}

function xeroDocumentTotal(payload: Record<string, unknown>, rate: number): number {
  const inclusive = payload.LineAmountTypes === 'Inclusive'
  const lines = (payload.LineItems ?? []) as XeroLine[]
  return roundPenny(lines.reduce((sum, line) => {
    const amount = roundPenny((line.Quantity ?? 0) * (line.UnitAmount ?? 0) - (line.DiscountAmount ?? 0))
    // An Inclusive line IS the gross; an Exclusive line is the net and Xero adds the tax.
    return sum + (inclusive ? amount : amount + roundPenny(amount * rate))
  }, 0))
}

function wcLine(overrides: Partial<WcLineItem> & Pick<WcLineItem, 'subtotal' | 'total' | 'total_tax'>): WcLineItem {
  return {
    id: 1, name: 'Widget', product_id: 10, variation_id: 0, quantity: 1, tax_class: '',
    subtotal_tax: overrides.total_tax, taxes: [], meta_data: [], sku: 'WIDGET', price: 0,
    ...overrides,
  } as WcLineItem
}

/**
 * The whole WC → Xero money path for one order, using the production mappers end to end:
 * mapWcLineItems → resolveWcOrderLevelDiscount → resolveWcAccountingAmountConvention →
 * buildSalesInvoicePayload.
 */
async function buildInvoiceForWcOrder(order: {
  line_items: WcLineItem[]
  coupon_lines?: WcCouponLine[]
  shippingForeign: number
  /** The STORE convention. Every assertion below must hold for BOTH values. */
  pricesIncludeVat: boolean
  /**
   * The ORDER currency. Added when o3d-5tf merged after this branch was cut: the coupon-allocation
   * tolerance is half a MINOR UNIT of this currency rather than a hard-coded half-penny, so the
   * caller has to say which. Defaulted to GBP so the existing fixtures keep the tolerance they were
   * written against, and stated per-fixture so a 0- or 3-decimal currency can be exercised here.
   */
  currency?: string
}): Promise<Record<string, unknown>> {
  const { mapWcLineItems, resolveWcOrderLevelDiscount, mapWcOrderDiscount } = await fieldMapping()
  const { resolveWcAccountingAmountConvention } = await orderImport()
  const { buildSalesInvoicePayload } = await xeroInvoices()

  const mapped = await mapWcLineItems(order.line_items, 1)
  const couponTotal = mapWcOrderDiscount(order.coupon_lines ?? []).discountAmount
  const { orderLevelDiscount } = resolveWcOrderLevelDiscount({
    couponTotalForeign: couponTotal,
    lineDiscountTotalForeign: mapped.reduce((sum, l) => sum + l.discountAmount, 0),
    // o3d-5tf (merged after this branch was cut): the coupon-allocation tolerance is half a MINOR
    // UNIT of the order's currency, not a hard-coded half-penny, so the caller must say which
    // currency. Passed from the fixture's own `currency` rather than hard-coding 'GBP', so a
    // fixture written in a 0- or 3-decimal currency exercises the tolerance it actually gets.
    currency: order.currency ?? 'GBP',
  })
  const { lineAmountsIncludeTax, shippingAmount, discountAmount } = resolveWcAccountingAmountConvention({
    pricesIncludeVat: order.pricesIncludeVat,
    shippingForeign: order.shippingForeign,
    orderLevelDiscountForeign: orderLevelDiscount,
  })
  return buildSalesInvoicePayload(
    {
      invoiceNumber: 'WC-INV-1',
      contactName: 'A Customer',
      date: '2026-08-20',
      currency: 'GBP',
      lines: mapped.map((l) => ({
        description: l.description,
        quantity: l.qty,
        unitAmount: l.unitPriceForeign,
        accountCode: '200',
        taxType: 'OUTPUT2',
        discountAmount: l.discountAmount > 0 ? l.discountAmount : undefined,
      })),
      shippingAmount,
      shippingAccountCode: '425',
      shippingTaxType: 'OUTPUT2',
      discountAmount,
      discountAccountCode: '210',
      lineAmountsIncludeTax,
    },
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )
}

// --- the case that must now pass -------------------------------------------------------------

test('a tax-INCLUSIVE order posts an invoice totalling the order gross, not its net (o3d-cyn)', async () => {
  // The Woo order: one line at net 100.00 + 20.00 VAT, shipping net 10.00 + 2.00 VAT.
  // wcOrder.total = 100 + 20 + 10 + 2 = 132.00. prices_include_tax is TRUE — and changes none of
  // the figures below, which is the entire point.
  const payload = await buildInvoiceForWcOrder({
    line_items: [wcLine({ quantity: 1, subtotal: '100.00', total: '100.00', total_tax: '20.00' })],
    shippingForeign: 10,
    pricesIncludeVat: true,
  })

  assert.equal(payload.LineAmountTypes, 'Exclusive', 'ex-tax WC amounts must never be flagged tax-inclusive')
  const shipping = (payload.LineItems as XeroLine[]).find((l) => l.Description === 'Shipping')
  assert.equal(shipping?.UnitAmount, 10, 'shipping is sent NET (10.00), not grossed up to 12.00')
  assert.equal(
    xeroDocumentTotal(payload, RATE),
    132,
    'invoice total must equal wcOrder.total 132.00; 110.00 is the pre-fix net-treated-as-gross figure',
  )
})

test('a tax-INCLUSIVE order WITH a coupon posts the gross the customer paid (o3d-cyn + o3d-y14)', async () => {
  // Codex's worked example: net 100 of goods less a net 10 coupon, at 20% VAT.
  // Woo: line subtotal 100.00, total 90.00, total_tax 18.00; coupon_lines[].discount 10.00.
  // wcOrder.total = 90 + 18 = 108.00.
  const payload = await buildInvoiceForWcOrder({
    line_items: [wcLine({ quantity: 1, subtotal: '100.00', total: '90.00', total_tax: '18.00' })],
    coupon_lines: [{ id: 1, code: 'TENOFF', discount: '10.00', discount_tax: '2.00' } as WcCouponLine],
    shippingForeign: 0,
    pricesIncludeVat: true,
  })

  const goods = (payload.LineItems as XeroLine[])[0]
  assert.equal(goods.UnitAmount, 100, 'the pre-coupon net unit price')
  assert.equal(goods.DiscountAmount, 10, 'the coupon, ex-tax, exactly as Woo allocated it to the line')
  assert.equal(
    (payload.LineItems as XeroLine[]).some((l) => l.Description === 'Order discount'),
    false,
    'and NOT a second time as an order-level line (o3d-y14)',
  )
  assert.equal(
    xeroDocumentTotal(payload, RATE),
    108,
    'invoice total must equal wcOrder.total 108.00; 90.00 is the pre-fix figure Codex recorded',
  )
})

test('a tax-EXCLUSIVE order is unchanged and still totals the order gross', async () => {
  // Identical figures on an exclusive store — the convention no longer branches, so this is the
  // control that the fix did not move the path that was already right.
  const payload = await buildInvoiceForWcOrder({
    line_items: [wcLine({ quantity: 1, subtotal: '100.00', total: '90.00', total_tax: '18.00' })],
    coupon_lines: [{ id: 1, code: 'TENOFF', discount: '10.00', discount_tax: '2.00' } as WcCouponLine],
    shippingForeign: 10,
    pricesIncludeVat: false,
  })
  // 90 net goods + 10 net shipping = 100 net, + 20% = 120.00 = wcOrder.total.
  assert.equal(xeroDocumentTotal(payload, RATE), 120)
})

test('coupon money Woo left off the lines still reaches the document, on the same net basis', async () => {
  // The unmodelled shape (o3d-y14): the residual is kept as an order-level negative line, and it
  // must be net like everything else — 100 net goods − 10 net residual = 90 net, +20% = 108.00.
  const payload = await buildInvoiceForWcOrder({
    line_items: [wcLine({ quantity: 1, subtotal: '100.00', total: '100.00', total_tax: '20.00' })],
    coupon_lines: [{ id: 1, code: 'ODD', discount: '10.00', discount_tax: '2.00' } as WcCouponLine],
    shippingForeign: 0,
    pricesIncludeVat: true,
  })
  const orderDiscount = (payload.LineItems as XeroLine[]).find((l) => l.Description === 'Order discount')
  assert.equal(orderDiscount?.UnitAmount, -10)
  assert.equal(xeroDocumentTotal(payload, RATE), 108)
})

// --- the stored sales order ------------------------------------------------------------------

test('an inclusive order stores subtotal + shipping + tax == the order total', async () => {
  const { computeWcOrderForeignTotals } = await orderImport()
  // Net 100 goods + 20 VAT + net 10 shipping + 2 VAT = 132.00. The subtotal must be the 100 Woo
  // reported, not 100/1.2 = 83.33 — which left the stored order unable to reconcile to its total.
  const totals = computeWcOrderForeignTotals({
    lines: [{ qty: 1, unitPriceForeign: '100.00', discountAmount: '0', taxForeign: '20.00' }],
    shippingTaxForeign: ['2.00'],
    orderTotal: '132.00',
  })
  assert.equal(totals.subtotalForeign.toFixed(2), '100.00')
  assert.equal(totals.taxForeign.toFixed(2), '22.00')
  assert.equal(
    totals.subtotalForeign.add(10).add(totals.taxForeign).toFixed(2),
    totals.totalForeign.toFixed(2),
    'subtotal + shipping + tax must reconcile to the Woo order total',
  )
})

// --- the payment gate: what it now allows, and what it must still refuse ----------------------

test('a paid tax-INCLUSIVE order now settles for its gross total (o3d-c0n gate removed)', async () => {
  const { resolveWcInvoicePaymentAmount } = await orderImport()
  assert.equal(
    resolveWcInvoicePaymentAmount({ date_paid_gmt: '2026-08-20T10:00:00', total: '132.00' }, { totalsToTheOrder: true }),
    132,
    'the invoice is now built at 132.00 too, so the gross payment no longer exceeds it',
  )
})

test('an UNPAID order still registers no payment, on either convention', async () => {
  const { resolveWcInvoicePaymentAmount } = await orderImport()
  assert.equal(resolveWcInvoicePaymentAmount({ date_paid_gmt: null, total: '132.00' }, { totalsToTheOrder: true }), undefined)
})

test('a zero / missing / non-numeric total still registers no payment', async () => {
  const { resolveWcInvoicePaymentAmount } = await orderImport()
  const paid = { date_paid_gmt: '2026-08-20T10:00:00' }
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '0' }, { totalsToTheOrder: true }), undefined)
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: '' }, { totalsToTheOrder: true }), undefined)
  assert.equal(resolveWcInvoicePaymentAmount({ ...paid, total: 'n/a' }, { totalsToTheOrder: true }), undefined)
})
