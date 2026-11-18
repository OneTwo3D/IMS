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
