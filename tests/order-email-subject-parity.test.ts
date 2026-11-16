import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// The subject stored when an order confirmation is queued must be the subject delivered when it is prepared: both read the order
// reference, so the queue lookup has to select the same fields (orderNumber) the builder reads.
const row: Record<string, unknown> = {
  id: 'cmtest0000000001',
  orderNumber: 'SO-TEST-1',
  externalOrderNumber: '5501',
  customerEmail: 'customer@example.invalid',
  customerName: 'Test Customer',
  currency: 'GBP',
  pricesIncludeVat: false,
  shoppingLinks: [],
  billingAddress: null,
  shippingAddress: null,
  subtotalForeign: 10,
  shippingForeign: 0,
  shippingService: null,
  taxForeign: 2,
  taxRateName: 'VAT',
  taxRatePercent: 0.2,
  totalForeign: 12,
  totalBase: 12,
  taxBase: 2,
  discountAmount: 0,
  storeCreditForeign: 0,
  invoiceNumber: null,
  invoicedAt: null,
  paidAt: null,
  expectedDelivery: null,
  notes: null,
  createdAt: new Date('2026-01-02T00:00:00Z'),
  erasedAt: null,
  customer: null,
  lines: [{ description: 'Widget', sku: 'W-1', qty: 1, unitPriceForeign: 10, discountAmount: 0, totalForeign: 10, taxForeign: 2, taxRate: { rate: 0.2 } }],
}

// Return only the selected scalar fields, like the real client, so a field the lookup forgets to select is undefined here too.
function selected(select: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!select) return row
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findUnique: async (args: { select?: Record<string, unknown> }) => selected(args.select) },
      organisation: { findFirst: async () => null },
      setting: { findUnique: async () => null },
      documentTemplate: { findUnique: async () => null },
      currency: { findUnique: async () => null },
    },
  },
})
mock.module('@/lib/display-timezone', { namedExports: { getDisplayTimeZone: async () => 'Europe/London' } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyDisplay: async () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) } })
mock.module('@/lib/email-template', { namedExports: { renderEmailHtml: async () => '<html></html>' } })

test('the queued order-confirmation subject equals the delivered one when the order has an IMS order number', async () => {
  const { getSalesOrderConfirmationQueueData, prepareQueuedEmail } = await import('@/lib/order-email')
  const queued = await getSalesOrderConfirmationQueueData('cmtest0000000001')
  const delivered = await prepareQueuedEmail('SALES_ORDER_CONFIRMATION', 'SalesOrder', 'cmtest0000000001')
  assert.equal(queued.subject, 'Order Confirmation SO-TEST-1')
  assert.equal(delivered?.subject, queued.subject)
  assert.equal(queued.reference, 'SO-TEST-1')
})
