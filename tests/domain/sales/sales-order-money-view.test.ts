import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
    lines: request.lines.map((l) => ({
      salesOrderLineId: l.lineId, qty: l.qty, totalForeign: l.totalForeign, unitPriceForeign: l.totalForeign / l.qty,
      // as getSalesOrder resolves them from what is persisted: the posted column and the rate of the snapshotted code
      postedNet: l.totalForeign, vatRate: order.lines.find((o) => o.id === l.lineId)!.taxRatePercent ?? null,
    })),
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
  const cn = creditNoteAmounts(manualExclusive20, { lines: [{ salesOrderLineId: null, postedNet: 4.95, vatRate: null }] })
  near(cn.total.vat, 0.99, 'VAT')
  near(cn.total.gross, 5.94, 'gross')
})

// [mutation: price the credit note at the order line's rate instead of its persisted code, or read the foreign column on a base-currency order]
test('a credit note line is shown at the rate of its persisted tax code, on the column that posts', () => {
  // The order line says 20%, the snapshot the credit note posts under says 5%: the displayed VAT is the posted one.
  const cn = creditNoteAmounts(manualExclusive20, { lines: [{ salesOrderLineId: 'a', postedNet: 100, vatRate: 0.05 }] })
  near(cn.total.vat, 5, 'VAT at the snapshot rate')
  near(cn.total.gross, 105, 'gross')
  // An unpriceable code falls back to the refunded order line's own rate.
  near(creditNoteAmounts(manualExclusive20, { lines: [{ salesOrderLineId: 'a', postedNet: 100, vatRate: null }] }).total.vat, 20, 'fallback to the order line rate')
})

// [mutation: the 100th partial refund of a line takes its pro-rata share instead of the remainder; the preview ignores earlier refunds]
test('the dialog preview is cut from what the line has left, so 100 single-unit refunds of a 0.50 line add up to exactly 0.50', () => {
  const order: Fixture = {
    ...manualExclusive20, taxRatePercent: 0, taxForeign: 0, totalForeign: 0.5, subtotalForeign: 0.5, discountAmount: 0, shippingForeign: 0,
    lines: [line('x', 'Tiny', 100, 0.005, 0.5, 0, 0)],
  }
  const prior: { salesOrderLineId: string; qty: number; totalForeign: number; totalBase: number }[] = []
  let credited = 0
  for (let i = 0; i < 100; i += 1) {
    const r = buildRefundRequest({ ...order, priorRefundLines: prior }, [{ lineId: 'x', qty: 1 }])
    const net = r.lines[0].totalForeign
    credited = Math.round((credited + net) * 10000) / 10000
    prior.push({ salesOrderLineId: 'x', qty: 1, totalForeign: net, totalBase: net })
  }
  assert.equal(credited, 0.5)
  assert.equal(buildRefundRequest({ ...order, priorRefundLines: prior }, [{ lineId: 'x', qty: 1 }]).lines[0].totalForeign, 0, 'nothing left to refund')
})

// [mutation: clamp the shipping/fees residue at zero, drop the zero guard, or collapse a mixed-rate order to one row]
test('printed VAT rows add up to the stored VAT on a mixed-rate order whose discount VAT exceeds its shipping VAT', () => {
  const rows = documentVatRows({
    taxRateName: 'VAT', taxRatePercent: 0.2, taxForeign: 21.9,
    lines: [{ taxRatePercent: 0.2, taxForeign: 20 }, { taxRatePercent: 0.05, taxForeign: 2.5 }],
  })
  assert.ok(rows.length >= 2, 'one row per rate')
  near(rows.reduce((s, r) => s + r.amount, 0), 21.9, 'rows add up to the stored VAT (shipping/fees residue is -0.6)')
  assert.deepEqual(documentVatRows({ taxRateName: 'VAT', taxRatePercent: 0.2, taxForeign: 0, lines: [{ taxRatePercent: 0.2, taxForeign: 0 }] }), [])
  const single = documentVatRows({ taxRateName: 'VAT', taxRatePercent: 0.2, taxForeign: 22.536, lines: [{ taxRatePercent: 0.2, taxForeign: 22.68 }] })
  assert.deepEqual(single, [{ label: 'VAT (20%)', amount: 22.536 }])
})

// [mutation: a route prints the raw stored line total, or stops using the shared totals block]
test('both customer PDFs print the shared view and totals block', () => {
  for (const file of ['app/api/sales-order/[id]/route.ts', 'app/api/invoice/[id]/route.ts']) {
    const src = readFileSync(file, 'utf8')
    assert.match(src, /view\.lines\[i\]\.total\.toFixed\(2\)/, `${file}: lines come from the view`)
    assert.ok(src.includes('shoppingLinks: so.shoppingLinks,'), `${file}: the basis sees the order's links (WooCommerce is net)`)
    assert.match(src, /documentTotalsRows\(view, documentVatRows\(/, `${file}: totals come from the shared block`)
    assert.match(src, /storeCreditForeign: Number\(so\.storeCreditForeign \?\? 0\)/, `${file}: the credit reaches the view`)
    assert.match(src, /doc\.text\(money\(row\.amount\)/, `${file}: every row's amount is printed`)
    assert.match(src, /Price \$\{view\.basisLabel\}/, `${file}: the price column is labelled`)
    assert.match(src, /Total \$\{view\.basisLabel\}/, `${file}: the total column is labelled`)
  }
})

// [mutation: tolerance of a whole unit; per-line gross without VAT; VAT unrounded; prior refunds of OTHER lines counted; minor units ignored]
test('refund line figures: per-line VAT rounded to the minor unit, prior refunds only count against their own line, zero-decimal currencies', () => {
  const order: Fixture = {
    ...manualExclusive20, taxRatePercent: 0.2, totalForeign: 0,
    lines: [line('p', 'Thirds', 3, 10, 25, 5, 0.2), line('q', 'Other', 1, 1000, 1000, 200, 0.2)],
  }
  const first = buildRefundRequest(order, [{ lineId: 'p', qty: 1 }])
  near(first.perLine.p.net, 8.33, 'net')
  assert.equal(first.perLine.p.vat, 1.67, 'VAT rounded per line (1.666 -> 1.67)')
  near(first.perLine.p.gross, 10, 'per-line gross is net + VAT')
  // An earlier refund of ANOTHER line does not shrink this one.
  const withOther = buildRefundRequest({ ...order, priorRefundLines: [{ salesOrderLineId: 'q', qty: 1, totalForeign: 1000, totalBase: 1000 }] }, [{ lineId: 'p', qty: 1 }])
  near(withOther.perLine.p.net, 8.33, 'prior refund of another line ignored')
  // A zero-decimal currency rounds to the unit.
  const yen = buildRefundRequest({ ...order, currencyMinorUnits: 0, lines: [line('y', 'Yen', 3, 1000, 1000, 200, 0.2)] }, [{ lineId: 'y', qty: 1 }])
  assert.equal(yen.perLine.y.net, 333)
  // A line with no stored rate is credited at what it was actually charged; its own rate wins when it has one.
  const noRate = buildRefundRequest({ ...order, lines: [{ ...line('n', 'NoRate', 1, 100, 100, 10, 0), taxRatePercent: null }] }, [{ lineId: 'n', qty: 1 }])
  near(noRate.perLine.n.vat, 10, 'derived from the line tax')
  const ownRate = buildRefundRequest({ ...order, lines: [{ ...line('o', 'Own', 1, 100, 100, 0, 0.05) }] }, [{ lineId: 'o', qty: 1 }])
  near(ownRate.perLine.o.vat, 5, 'the line\'s own rate wins over its stored tax')
})

test('a credit note line with no priced code falls back to its order line\'s own rate, not the header rate', () => {
  const order: Fixture = { ...manualExclusive20, taxRatePercent: 0.2, lines: [line('a', 'A', 1, 100, 100, 5, 0.05)] }
  near(creditNoteAmounts(order, { lines: [{ salesOrderLineId: 'a', postedNet: 100, vatRate: null }] }).total.vat, 5, 'order line 5%, header 20%')
})

test('a difference of two pence is not "reconciled"', () => {
  assert.equal(salesOrderMoneyView({ ...manualInclusive20, totalForeign: 112.7 }).reconciles, false)
  assert.equal(salesOrderMoneyView({ ...manualInclusive20, totalForeign: 112.683 }).reconciles, true, 'rounding noise is tolerated')
})
