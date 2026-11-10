import assert from 'node:assert/strict'
import test from 'node:test'

import { connectorEmitsDiscount, connectorEmitsShipping, droppedExtraMapping } from '@/lib/domain/accounting/sales-document-tax-types'

// [mutation: drop the account-code requirement, or the positive-amount requirement]
test('shipping and the discount are emitted only with a positive amount AND an account code', () => {
  assert.equal(connectorEmitsShipping({ shippingAmount: 10, shippingAccountCode: '210' }), true)
  assert.equal(connectorEmitsShipping({ shippingAmount: 10, shippingAccountCode: '' }), false)
  assert.equal(connectorEmitsShipping({ shippingAmount: 10, shippingAccountCode: '  ' }), false)
  assert.equal(connectorEmitsShipping({ shippingAmount: 10 }), false)
  assert.equal(connectorEmitsShipping({ shippingAmount: 0, shippingAccountCode: '210' }), false)
  assert.equal(connectorEmitsShipping({ shippingAmount: -1, shippingAccountCode: '210' }), false)
  assert.equal(connectorEmitsDiscount({ discountAmount: 5, discountAccountCode: '220' }), true)
  assert.equal(connectorEmitsDiscount({ discountAmount: 5 }), false)
  assert.equal(connectorEmitsDiscount({ discountAmount: undefined, discountAccountCode: '220' }), false)
})

test('a positive amount the connector would drop names its missing mapping; nothing to drop names none', () => {
  assert.equal(droppedExtraMapping({ shippingAmount: 10 }), 'shipping')
  assert.equal(droppedExtraMapping({ discountAmount: 5, discountAccountCode: '' }), 'discount')
  assert.equal(droppedExtraMapping({ shippingAmount: 10, shippingAccountCode: '210', discountAmount: 5 }), 'discount')
  assert.equal(droppedExtraMapping({ shippingAmount: 0 }), null)
  assert.equal(droppedExtraMapping({}), null)
  assert.equal(droppedExtraMapping({ shippingAmount: 10, shippingAccountCode: '210', discountAmount: 5, discountAccountCode: '220' }), null)
})
