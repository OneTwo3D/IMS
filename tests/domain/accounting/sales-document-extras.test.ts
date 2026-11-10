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

// ---- the Xero builder uses the same decision
import { buildSalesInvoicePayload } from '@/lib/connectors/xero/invoices'

const build = (extra: Record<string, unknown>) => buildSalesInvoicePayload(
  { invoiceNumber: 'X-1', date: '2026-11-01', lines: [{ description: 'W', quantity: 1, unitAmount: 100, accountCode: '200', taxType: 'OUTPUT2' }], ...extra } as unknown as Parameters<typeof buildSalesInvoicePayload>[0],
  'AUTHORISED', 'contact-1', new Set<string>(), 'GBP',
)
const descriptions = (p: Record<string, unknown>) => (p.LineItems as Array<{ Description?: string }>).map((l) => l.Description)

// [mutation: the builder emits shipping / the discount regardless of the account code]
test('the Xero builder sends shipping and the discount exactly when the shared decision says so', () => {
  assert.deepEqual(descriptions(build({ shippingAmount: 10, shippingAccountCode: '210', shippingTaxType: 'OUTPUT2' })), ['W', 'Shipping'])
  assert.deepEqual(descriptions(build({ shippingAmount: 10, shippingTaxType: 'OUTPUT2' })), ['W'], 'no account code: the shipping line is dropped')
  assert.deepEqual(descriptions(build({ discountAmount: 5, discountAccountCode: '220', discountTaxType: 'OUTPUT2' })), ['W', 'Order discount'])
  assert.deepEqual(descriptions(build({ discountAmount: 5, discountTaxType: 'OUTPUT2' })), ['W'], 'no account code: the discount line is dropped')
})
