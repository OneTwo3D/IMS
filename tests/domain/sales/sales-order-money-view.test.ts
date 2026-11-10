import assert from 'node:assert/strict'
import test from 'node:test'

import { documentVatRows } from '@/lib/pdf'
import {
  buildRefundRequest,
  creditNoteAmounts,
  documentTotalsRows,
  salesOrderMoneyView,
  type MoneyViewOrder,
} from '@/lib/domain/sales/sales-order-money-view'

/**
 * The audit's order: Widget A 3 x 28.80 and Widget B 1 x 27.00 at a 20% default rate, an order discount of 5.67, shipping of 4.95 and a stored
 * total of 112.68 (inclusive) -- built three ways, exactly as the stored columns are written by createSalesOrder / the WooCommerce importer.
 */
const r2 = (n: number) => Math.round(n * 100) / 100
const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 0.005, `${what}: ${actual} vs ${expected}`)

type Fixture = MoneyViewOrder & {
  id?: string
  fxRateToBase: number
  lines: (MoneyViewOrder['lines'][number] & { id: string; productId: string | null; description: string })[]
}

const line = (id: string, description: string, qty: number, unit: number, net: number, tax: number, rate: number) => ({
  id, productId: `p-${id}`, description, qty, unitPriceForeign: unit, discountAmount: 0, totalForeign: net, taxForeign: tax, taxRatePercent: rate,
})

/** Manual order, prices INCLUDE VAT, both lines resolve to the 20% rate. */
const manualInclusive20: Fixture = {
  pricesIncludeVat: true, shoppingLinks: [], taxRatePercent: 0.2, fxRateToBase: 1,
  subtotalForeign: 94.5, discountAmount: 5.67, shippingForeign: 4.125, taxForeign: 18.78, totalForeign: 112.68,
  lines: [line('a', 'Widget A', 3, 28.8, 72, 14.4, 0.2), line('b', 'Widget B', 1, 27, 22.5, 4.5, 0.2)],
}

/** The audit's observed order: prices include VAT, header rate 20%, but both lines resolved to a 0% rate (net = gross = what was typed). */
const manualInclusiveZeroRatedLines: Fixture = {
  pricesIncludeVat: true, shoppingLinks: [], taxRatePercent: 0.2, fxRateToBase: 1,
  subtotalForeign: 113.4, discountAmount: 5.67, shippingForeign: 4.125, taxForeign: -0.12, totalForeign: 112.68,
  lines: [line('a', 'Widget A', 3, 28.8, 86.4, 0, 0), line('b', 'Widget B', 1, 27, 27, 0, 0)],
}

/** Manual order, prices EXCLUDE VAT: everything typed and stored net, VAT added on top. */
const manualExclusive20: Fixture = {
  pricesIncludeVat: false, shoppingLinks: [], taxRatePercent: 0.2, fxRateToBase: 1,
  subtotalForeign: 113.4, discountAmount: 5.67, shippingForeign: 4.95, taxForeign: 22.536, totalForeign: 135.216,
  lines: [line('a', 'Widget A', 3, 28.8, 86.4, 17.28, 0.2), line('b', 'Widget B', 1, 27, 27, 5.4, 0.2)],
}

/** WooCommerce order: stored NET whatever the storefront displays -- its display flag says "prices include VAT". */
const wooNetStored20: Fixture = {
  ...manualExclusive20,
  pricesIncludeVat: true, shoppingLinks: [{ connector: 'woocommerce' }],
}

const FIXTURES: [string, Fixture, 'GROSS' | 'NET'][] = [
  ['manual, prices include VAT, lines at 20%', manualInclusive20, 'GROSS'],
  ['manual, prices include VAT, lines resolved at 0% (the audit order)', manualInclusiveZeroRatedLines, 'GROSS'],
  ['manual, prices exclude VAT', manualExclusive20, 'NET'],
  ['WooCommerce, net-stored under a "prices include VAT" display flag', wooNetStored20, 'NET'],
]

// [mutation: gross lines/subtotal up by the HEADER rate, or follow the display flag for a WooCommerce order]
test('the order page figures reconcile with the stored total on every basis (3 x 28.80 at 20%)', () => {
  for (const [name, order, basis] of FIXTURES) {
    const v = salesOrderMoneyView(order)
    assert.equal(v.basis, basis, name)
    assert.equal(v.reconciles, true, `${name}: figures add up to ${v.computedTotal}, stored ${order.totalForeign}`)
    near(v.total, order.totalForeign, `${name}: total`)
    near(v.subtotal - v.orderDiscount + v.shipping + (v.vatIsAdditional ? v.vat : 0), order.totalForeign, `${name}: parts add up`)
    // The rows add up to the subtotal shown.
    near(v.lines.reduce((s, l) => s + l.total, 0), v.subtotal, `${name}: lines add up to subtotal`)
    // Widget A is 3 x 28.80 = 86.40 on every one of them -- never grossed up a second time.
    near(v.lines[0].total, 86.4, `${name}: Widget A line`)
    near(v.lines[1].total, 27, `${name}: Widget B line`)
    near(v.subtotal, 113.4, `${name}: subtotal`)
  }
})

// [mutation: show shipping net on a gross basis (the PDF defect), or multiply a discount that is already gross]
test('shipping and the order discount are in the basis of the figures around them', () => {
  const gross = salesOrderMoneyView(manualInclusive20)
  near(gross.shipping, 4.95, 'inclusive shipping is grossed up exactly as the invoice is sent')
  near(gross.orderDiscount, 5.67, 'inclusive discount is stored gross')
  near(gross.vat, 18.78, 'VAT is an "of which"')
  assert.equal(gross.vatIsAdditional, false)
  const net = salesOrderMoneyView(wooNetStored20)
  near(net.shipping, 4.95, 'net shipping')
  near(net.orderDiscount, 5.67, 'net discount')
  near(net.vat, 22.536, 'VAT is added')
  assert.equal(net.vatIsAdditional, true)
  assert.equal(net.basisLabel, 'excl. VAT')
  assert.equal(gross.basisLabel, 'incl. VAT')
})

test('a damaged row is reported, never shown as if it added up', () => {
  const v = salesOrderMoneyView({ ...manualInclusive20, totalForeign: 120 })
  assert.equal(v.reconciles, false)
  near(v.difference, -7.32, 'difference')
})

// [mutation: add VAT rows before the Total on a gross basis, or drop them on a net one]
test('the printed totals block reconciles to the Total on every basis, labelled', () => {
  for (const [name, order, basis] of FIXTURES) {
    const v = salesOrderMoneyView(order)
    const rows = documentTotalsRows(v, documentVatRows({
      taxRateName: 'VAT', taxRatePercent: order.taxRatePercent, taxForeign: order.taxForeign,
      lines: order.lines.map((l) => ({ taxRatePercent: l.taxRatePercent ?? null, taxForeign: l.taxForeign })),
    }))
    const totalIdx = rows.findIndex((r) => r.strong)
    assert.equal(rows[totalIdx].label, 'Total')
    near(rows[totalIdx].amount, order.totalForeign, `${name}: Total`)
    // Everything printed before the Total (VAT rows included only when additional) adds up to it.
    near(rows.slice(0, totalIdx).reduce((s, r) => s + r.amount, 0), order.totalForeign, `${name}: rows before Total`)
    assert.match(rows[0].label, basis === 'GROSS' ? /incl\. VAT/ : /excl\. VAT/, `${name}: subtotal is labelled`)
    const after = rows.slice(totalIdx + 1)
    if (basis === 'GROSS') {
      near(after.reduce((s, r) => s + r.amount, 0), order.taxForeign, `${name}: included VAT rows`)
    } else {
      assert.equal(after.length, 0, `${name}: nothing after the Total`)
      near(rows.filter((r) => /^VAT/.test(r.label)).reduce((s, r) => s + r.amount, 0), order.taxForeign, `${name}: VAT rows`)
    }
  }
})

test('a store credit is its own printed line, so the rows still add up to the Total', () => {
  const credited = { ...manualExclusive20, storeCreditForeign: 10, totalForeign: 125.216 }
  const v = salesOrderMoneyView(credited)
  assert.equal(v.reconciles, true)
  const rows = documentTotalsRows(v, [{ label: 'VAT (20%)', amount: 22.536 }])
  const totalIdx = rows.findIndex((r) => r.strong)
  near(rows.slice(0, totalIdx).reduce((s, r) => s + r.amount, 0), 125.216, 'rows before Total')
})

/**
 * The credit note, as the stored refund and the ledger have it: the refund line is stored with unit = totalForeign / qty (refund-service),
 * the credit note posts `unitAmount` = that stored unit NET with lineAmountsIncludeTax false (app/actions/sales.ts), and the ledger adds the
 * VAT at the rate of the line's tax code, which is the refunded order line's own rate.
 */
function creditNoteAsPosted(order: Fixture, request: ReturnType<typeof buildRefundRequest>) {
  const storedRefund = {
    lines: request.lines.map((l) => ({ salesOrderLineId: l.lineId, qty: l.qty, totalForeign: l.totalForeign, unitPriceForeign: l.totalForeign / l.qty })),
  }
  let ledgerGross = 0
  for (const rl of storedRefund.lines) {
    const orderLine = order.lines.find((l) => l.id === rl.salesOrderLineId)!
    const net = r2(rl.unitPriceForeign * rl.qty)
    ledgerGross += net + r2(net * (orderLine.taxRatePercent ?? 0))
  }
  return { storedRefund, ledgerGross: r2(ledgerGross) }
}

// [mutation: send qty x unit price (as typed, gross on an inclusive order) as the NET refund, or gross the credit note by the header rate]
test('the refund dialog amount, what is sent, the credit note payload and the credit note shown afterwards are the same figure', () => {
  const expected: Record<string, { net: number; vat: number; gross: number }> = {
    'manual, prices include VAT, lines at 20%': { net: 24, vat: 4.8, gross: 28.8 },
    'manual, prices include VAT, lines resolved at 0% (the audit order)': { net: 28.8, vat: 0, gross: 28.8 },
    'manual, prices exclude VAT': { net: 28.8, vat: 5.76, gross: 34.56 },
    'WooCommerce, net-stored under a "prices include VAT" display flag': { net: 28.8, vat: 5.76, gross: 34.56 },
  }
  for (const [name, order] of FIXTURES) {
    const request = buildRefundRequest(order, [{ lineId: 'a', qty: 1 }, { lineId: 'b', qty: 0 }])
    const want = expected[name]
    near(request.total.net, want.net, `${name}: dialog net`)
    near(request.total.vat, want.vat, `${name}: dialog VAT`)
    near(request.total.gross, want.gross, `${name}: dialog credit note total`)
    assert.equal(request.lines.length, 1, `${name}: a line with no quantity is not sent`)
    near(request.lines[0].totalForeign, want.net, `${name}: the line is sent NET`)
    const posted = creditNoteAsPosted(order, request)
    near(posted.ledgerGross, request.total.gross, `${name}: the credit note the ledger posts`)
    near(creditNoteAmounts(order, posted.storedRefund).total.gross, request.total.gross, `${name}: the credit note shown afterwards`)
  }
  // An inclusive order never refunds more than the customer paid for the unit.
  near(buildRefundRequest(manualInclusive20, [{ lineId: 'a', qty: 3 }]).total.gross, 86.4, 'full line')
})

test('a refund line carries the line discount and the base amount, and a quantity beyond the line is capped', () => {
  const discounted: Fixture = {
    ...manualExclusive20, fxRateToBase: 1.25,
    lines: [{ ...line('a', 'Widget A', 2, 10, 18, 3.6, 0.2), discountAmount: 2 }],
  }
  const r = buildRefundRequest(discounted, [{ lineId: 'a', qty: 1 }])
  near(r.lines[0].totalForeign, 9, 'half of the discounted net')
  near(r.lines[0].totalBase, 7.2, 'base amount')
  near(r.total.gross, 10.8, 'credit note incl. VAT')
  near(buildRefundRequest(discounted, [{ lineId: 'a', qty: 9 }]).total.net, 18, 'capped at the line')
})

test('a shipping refund (no order line) is credited at the order default rate', () => {
  const cn = creditNoteAmounts(manualExclusive20, { lines: [{ salesOrderLineId: null, totalForeign: 4.95 }] })
  near(cn.total.vat, 0.99, 'VAT')
  near(cn.total.gross, 5.94, 'gross')
})
