import assert from 'node:assert/strict'
import test from 'node:test'

import { planQuotedShipping, SUPPLIER_QUOTED_SHIPPING_DESCRIPTION } from '@/lib/domain/purchasing/quote-shipping'

test('RFQ with no cost lines: the supplier shipping becomes a landed, billable cost line and the aggregate', () => {
  const plan = planQuotedShipping({ shippingForeign: 40, fxRateToBase: 1, vatRate: 0.2, costLines: [] })
  assert.equal(plan.create?.amountForeign.toString(), '40')
  assert.equal(plan.create?.description, SUPPLIER_QUOTED_SHIPPING_DESCRIPTION)
  assert.equal(plan.create?.vatable, false)
  assert.equal(plan.directFreightForeign.toString(), '40')
  assert.equal(plan.costLineVatForeign.toString(), '0')
})

test('buyer vatable freight stays, keeps its VAT, and sits beside the supplier shipping', () => {
  const plan = planQuotedShipping({
    shippingForeign: 80, fxRateToBase: 2, vatRate: 0.2,
    costLines: [{ id: 'c1', description: 'Freight', amountForeign: 50, vatable: true }],
  })
  assert.equal(plan.directFreightForeign.toString(), '130')
  assert.equal(plan.directFreightBase.toString(), '65')
  assert.equal(plan.costLineVatForeign.toString(), '10')
  assert.equal(plan.costLineVatBase.toString(), '5')
  assert.deepEqual(plan.deleteIds, [])
})

test('a requote replaces the previous requote line instead of stacking, and a zero quote removes it', () => {
  const lines = [
    { id: 'c1', description: 'Freight', amountForeign: 50, vatable: false },
    { id: 'q1', description: SUPPLIER_QUOTED_SHIPPING_DESCRIPTION, amountForeign: 80, vatable: false },
  ]
  const again = planQuotedShipping({ shippingForeign: 60, fxRateToBase: 1, vatRate: 0, costLines: lines })
  assert.deepEqual(again.deleteIds, ['q1'])
  assert.equal(again.directFreightForeign.toString(), '110')
  const none = planQuotedShipping({ shippingForeign: 0, fxRateToBase: 1, vatRate: 0, costLines: lines })
  assert.equal(none.create, null)
  assert.equal(none.directFreightForeign.toString(), '50')
})

// ---- Owner ruling 2026-11-18: the supplier's shipping REPLACES the buyer's SHIPPING-tagged estimate ----

const buyerShipping = { id: 'b1', description: 'Estimated carriage', amountForeign: 30, vatable: false, kind: 'SHIPPING' as const }
const buyerDuty = { id: 'd1', description: 'Shipping duty', amountForeign: 20, vatable: true, kind: null }

test('an unbilled, unlanded SHIPPING-tagged buyer estimate is replaced, so shipping is counted once', () => {
  const plan = planQuotedShipping({ shippingForeign: 80, fxRateToBase: 1, vatRate: 0.2, costLines: [buyerShipping, buyerDuty] })
  assert.deepEqual(plan.deleteIds, ['b1'])
  assert.equal(plan.refusedReplace, null)
  assert.equal(plan.create?.kind, 'SHIPPING')
  assert.equal(plan.create?.amountForeign.toString(), '80')
  assert.equal(plan.directFreightForeign.toString(), '100') // 20 duty + 80 quote, not 130
  assert.equal(plan.costLineVatForeign.toString(), '4')
})

test('a billed SHIPPING line is NOT replaced: both lines stay and the refusal says why', () => {
  const plan = planQuotedShipping({ shippingForeign: 80, fxRateToBase: 1, vatRate: 0, costLines: [{ ...buyerShipping, billed: true }] })
  assert.deepEqual(plan.deleteIds, [])
  assert.equal(plan.refusedReplace?.reason, 'billed')
  assert.deepEqual(plan.refusedReplace?.lineIds, ['b1'])
  assert.ok(plan.create)
  assert.equal(plan.directFreightForeign.toString(), '110')
})

test('a SHIPPING line on an order whose goods have landed is NOT replaced', () => {
  const plan = planQuotedShipping({ shippingForeign: 80, fxRateToBase: 1, vatRate: 0, costLines: [buyerShipping], landed: true })
  assert.deepEqual(plan.deleteIds, [])
  assert.equal(plan.refusedReplace?.reason, 'landed')
  assert.equal(plan.directFreightForeign.toString(), '110')
})

test('untagged lines are never replaced, whatever their description says', () => {
  const plan = planQuotedShipping({ shippingForeign: 80, fxRateToBase: 1, vatRate: 0, costLines: [buyerDuty, { id: 'u', description: 'Shipping', amountForeign: 10, vatable: false }], landed: true })
  assert.deepEqual(plan.deleteIds, [])
  assert.equal(plan.refusedReplace, null)
  assert.equal(plan.directFreightForeign.toString(), '110')
})

test('a requote replaces the previous supplier line (itself tagged SHIPPING) and does not refuse', () => {
  const prev = { id: 'q1', description: SUPPLIER_QUOTED_SHIPPING_DESCRIPTION, amountForeign: 80, vatable: false, kind: 'SHIPPING' as const }
  const plan = planQuotedShipping({ shippingForeign: 60, fxRateToBase: 1, vatRate: 0, costLines: [prev], landed: true })
  assert.deepEqual(plan.deleteIds, ['q1'])
  assert.equal(plan.refusedReplace, null)
  assert.equal(plan.create?.amountForeign.toString(), '60')
})

test('a quote with no shipping leaves the buyer estimate alone', () => {
  const plan = planQuotedShipping({ shippingForeign: 0, fxRateToBase: 1, vatRate: 0, costLines: [buyerShipping] })
  assert.deepEqual(plan.deleteIds, [])
  assert.equal(plan.create, null)
  assert.equal(plan.directFreightForeign.toString(), '30')
})

test('flag OFF: the requote path never reads, plans, deletes or creates a cost line (wiring is inside the flag branch)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('app/actions/supplier-portal.ts', 'utf8')
  const gate = src.indexOf('if (landQuotedShipping) {')
  assert.ok(gate > 0)
  assert.equal(src.indexOf('landQuotedShipping = ') < gate, true)
  for (const needle of ['freightCostLine.', 'planQuotedShipping(', 'readPoEditFacts(', 'supplier_quote_shipping_replace_refused']) {
    const first = src.indexOf(needle, src.indexOf("import { readPoEditFacts"))
    assert.ok(first >= gate, `${needle} must not run before the flag check`)
  }
  assert.match(src, /let shippingForeign = toDecimal\(safeData\.shippingCost\)/) // OFF keeps the supplier figure as the whole freight aggregate
  assert.match(src, /if \(refusedShippingReplace\) \{/) // null whenever the flag is off, so nothing is logged
})
