import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareWcOrderWithIms,
  describeDivergence,
  divergenceFingerprint,
  type RefundFactsForDivergence,
  type StoredOrderForDivergence,
} from '@/lib/connectors/woocommerce/sync/order-divergence'

/**
 * The pure comparison behind the WooCommerce-vs-IMS divergence report: what counts as a difference, the rounding tolerance, and the refund netting
 * (a refund is never reported as an edit). No database and no network.
 */

const NO_REFUNDS: RefundFactsForDivergence = { recordedExternalRefundIds: [], refundedQtyByLineId: new Map() }

// IMS: RED-M x2 at 10.00 (net 20.00, tax 4.00) and BLU-L x1 at 30.00 less a 5.00 discount (net 25.00, tax 5.00), shipping 5.00 (tax 1.00).
// Tax 10.00, discount 5.00, total 20 + 25 + 5 + 10 = 60.00.
function stored(over: Partial<StoredOrderForDivergence> = {}): StoredOrderForDivergence {
  return {
    currency: 'GBP', status: 'PROCESSING', erasedAt: null, shippingForeign: '5.00', taxForeign: '10.00', totalForeign: '60.00', discountAmount: '0', discountModel: 'LINE_ALLOCATED', storeCreditForeign: '0',
    lines: [
      { id: 'L1', externalLineItemId: 11, sku: 'RED-M', qty: '2', unitPriceForeign: '10', discountAmount: '0', taxForeign: '4.00', totalForeign: '20.00' },
      { id: 'L2', externalLineItemId: 12, sku: 'BLU-L', qty: '1', unitPriceForeign: '30', discountAmount: '5.00', taxForeign: '5.00', totalForeign: '25.00' },
    ],
    ...over,
  }
}
function payload(over: Record<string, unknown> = {}) {
  return {
    currency: 'GBP', total: '60.00', total_tax: '10.00', shipping_total: '5.00', discount_total: '5.00', refunds: [],
    line_items: [
      { id: 11, quantity: 2, sku: 'RED-M', subtotal: '20.00', total: '20.00' },
      { id: 12, quantity: 1, sku: 'BLU-L', subtotal: '30.00', total: '25.00' },
    ],
    ...over,
  } as never
}
function fields(v: ReturnType<typeof compareWcOrderWithIms>): string[] {
  assert.equal(v.kind, 'compared')
  return v.kind === 'compared' ? v.differences.map((d) => d.field) : []
}

test('an order that matches reports nothing', () => {
  assert.deepEqual(fields(compareWcOrderWithIms(payload(), stored(), NO_REFUNDS)), [])
})

test('a changed quantity is reported with both quantities and the SKU, and moves the money figures too', () => {
  const v = compareWcOrderWithIms(payload({ line_items: [{ id: 11, quantity: 3, sku: 'RED-M', subtotal: '30.00', total: '30.00' }, { id: 12, quantity: 1, sku: 'BLU-L', subtotal: '30.00', total: '25.00' }], total: '71.00', total_tax: '11.20' }), stored(), NO_REFUNDS)
  assert.deepEqual(fields(v), ['LINE_QUANTITY', 'TAX', 'TOTAL'])
  if (v.kind === 'compared') {
    assert.equal(v.differences[0].woocommerce, '3')
    assert.equal(v.differences[0].ims, '2')
    assert.match(v.differences[0].label, /RED-M/)
  }
})

test('a changed unit price (ex-tax) is reported, not mistaken for a quantity change', () => {
  const v = compareWcOrderWithIms(payload({ line_items: [{ id: 11, quantity: 2, sku: 'RED-M', subtotal: '24.00', total: '24.00' }, { id: 12, quantity: 1, sku: 'BLU-L', subtotal: '30.00', total: '25.00' }] }), stored(), NO_REFUNDS)
  assert.deepEqual(fields(v), ['LINE_PRICE'])
  if (v.kind === 'compared') {
    assert.equal(v.differences[0].woocommerce, '12.00')
    assert.equal(v.differences[0].ims, '10.00')
  }
})

test('an added line and a removed line are reported by SKU', () => {
  const added = compareWcOrderWithIms(payload({ line_items: [...((payload() as unknown as { line_items: unknown[] }).line_items), { id: 13, quantity: 1, sku: 'NEW-1', subtotal: '8.00', total: '8.00' }] }), stored(), NO_REFUNDS)
  assert.ok(fields(added).includes('LINE_ADDED'))
  if (added.kind === 'compared') assert.equal(added.differences.find((d) => d.field === 'LINE_ADDED')?.woocommerce, '1 x NEW-1 at 8.00 each')
  const removed = compareWcOrderWithIms(payload({ line_items: [{ id: 11, quantity: 2, sku: 'RED-M', subtotal: '20.00', total: '20.00' }] }), stored(), NO_REFUNDS)
  assert.ok(fields(removed).includes('LINE_REMOVED'))
  if (removed.kind === 'compared') assert.equal(removed.differences.find((d) => d.field === 'LINE_REMOVED')?.ims, '1 x BLU-L')
})

test('a removed line that IMS has also refunded is one event: not reported, and its money is taken out of the IMS side', () => {
  // WooCommerce no longer shows BLU-L (net 25.00 + tax 5.00 = 30.00 off the total, 5.00 off the tax, 5.00 off the discount).
  const wc = payload({ line_items: [{ id: 11, quantity: 2, sku: 'RED-M', subtotal: '20.00', total: '20.00' }], total: '30.00', total_tax: '5.00', discount_total: '0.00' })
  const refunded: RefundFactsForDivergence = { recordedExternalRefundIds: [], refundedQtyByLineId: new Map([['L2', '1']]) }
  assert.deepEqual(fields(compareWcOrderWithIms(wc, stored(), refunded)), [])
  // the same payload with NO refund recorded is a real divergence on the line and on the money
  assert.deepEqual(fields(compareWcOrderWithIms(wc, stored(), NO_REFUNDS)), ['LINE_REMOVED', 'DISCOUNT', 'TAX', 'TOTAL'])
})

test('a quantity WooCommerce shows lower is explained only when the refund recorded accounts for the whole gap', () => {
  const wc = payload({ line_items: [{ id: 11, quantity: 1, sku: 'RED-M', subtotal: '10.00', total: '10.00' }, { id: 12, quantity: 1, sku: 'BLU-L', subtotal: '30.00', total: '25.00' }], total: '48.00', total_tax: '8.00' })
  assert.deepEqual(fields(compareWcOrderWithIms(wc, stored(), { recordedExternalRefundIds: [], refundedQtyByLineId: new Map([['L1', '1']]) })), [])
  assert.ok(fields(compareWcOrderWithIms(wc, stored(), { recordedExternalRefundIds: [], refundedQtyByLineId: new Map([['L1', '2']]) })).includes('LINE_QUANTITY'), 'a refund of 2 does not explain a gap of 1')
  assert.ok(fields(compareWcOrderWithIms(wc, stored(), NO_REFUNDS)).includes('LINE_QUANTITY'))
})

test('a refund on its own moves nothing: gross figures on both sides are unchanged by it', () => {
  const refunded: RefundFactsForDivergence = { recordedExternalRefundIds: [701], refundedQtyByLineId: new Map([['L1', '1']]) }
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ refunds: [{ id: 701, reason: '', total: '-12.00' }] }), stored(), refunded)), [])
})

test('a refund the payload names that IMS has not recorded yet defers the comparison (the refund sync runs after the import)', () => {
  const v = compareWcOrderWithIms(payload({ refunds: [{ id: 702, reason: '', total: '-12.00' }], total: '1.00' }), stored(), NO_REFUNDS)
  assert.equal(v.kind, 'deferred')
})

test('shipping, discount and tax changes are each reported, naming the field', () => {
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ shipping_total: '7.50' }), stored(), NO_REFUNDS)), ['SHIPPING'])
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ discount_total: '8.00' }), stored(), NO_REFUNDS)), ['DISCOUNT'])
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ total_tax: '12.00' }), stored(), NO_REFUNDS)), ['TAX'])
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ total: '65.00' }), stored(), NO_REFUNDS)), ['TOTAL'])
})

test('tolerance is half a minor unit: 0.005 of rounding is not reported, 0.006 and a real penny are', () => {
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ shipping_total: '5.005' }), stored(), NO_REFUNDS)), [], 'exactly half a penny is rounding')
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ shipping_total: '5.0049' }), stored(), NO_REFUNDS)), [])
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ shipping_total: '5.006' }), stored(), NO_REFUNDS)), ['SHIPPING'])
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ shipping_total: '5.01' }), stored(), NO_REFUNDS)), ['SHIPPING'], 'a one-penny change is real')
  // a unit price stored to six decimals (10 / 3) does not look changed against the payload's subtotal
  const third = stored({ lines: [{ id: 'L1', externalLineItemId: 11, sku: 'RED-M', qty: '3', unitPriceForeign: '3.333333', discountAmount: '0', taxForeign: '2.00', totalForeign: '10.00' }], taxForeign: '2.00', totalForeign: '17.00', discountModel: null })
  const wc = payload({ line_items: [{ id: 11, quantity: 3, sku: 'RED-M', subtotal: '10.00', total: '10.00' }], total: '17.00', total_tax: '2.00' })
  assert.deepEqual(fields(compareWcOrderWithIms(wc, third, NO_REFUNDS)), [])
})

test('a zero-decimal currency uses its own tolerance', () => {
  const yen = stored({ currency: 'JPY', shippingForeign: '500', taxForeign: '0', totalForeign: '500', lines: [], discountModel: null })
  const wc = (shipping: string) => payload({ currency: 'JPY', shipping_total: shipping, total_tax: '0', total: '500', line_items: [] })
  assert.deepEqual(fields(compareWcOrderWithIms(wc('500.4'), yen, NO_REFUNDS)), [])
  assert.deepEqual(fields(compareWcOrderWithIms(wc('501'), yen, NO_REFUNDS)), ['SHIPPING'])
})

test('a changed product on the same line id is reported; an unreadable figure compares nothing', () => {
  const v = compareWcOrderWithIms(payload({ line_items: [{ id: 11, quantity: 2, sku: 'RED-XL', subtotal: '20.00', total: '20.00' }, { id: 12, quantity: 1, sku: 'BLU-L', subtotal: '30.00', total: '25.00' }] }), stored(), NO_REFUNDS)
  assert.deepEqual(fields(v), ['LINE_PRODUCT'])
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ shipping_total: 'abc', total_tax: undefined }), stored(), NO_REFUNDS)), [])
})

test('the discount is not compared on an order that holds store credit or does not say its discount was allocated', () => {
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ discount_total: '9.00' }), stored({ storeCreditForeign: '4.00' }), NO_REFUNDS)), [])
  assert.deepEqual(fields(compareWcOrderWithIms(payload({ discount_total: '9.00' }), stored({ discountModel: null }), NO_REFUNDS)), [])
})

test('cancelled, erased and other-currency orders are not compared', () => {
  assert.equal(compareWcOrderWithIms(payload(), stored({ status: 'CANCELLED' }), NO_REFUNDS).kind, 'not-comparable')
  assert.equal(compareWcOrderWithIms(payload(), stored({ erasedAt: new Date() }), NO_REFUNDS).kind, 'not-comparable')
  assert.equal(compareWcOrderWithIms(payload({ currency: 'EUR' }), stored(), NO_REFUNDS).kind, 'not-comparable')
})

test('the wording names the field and the currency, and carries only SKUs, quantities and amounts', () => {
  const v = compareWcOrderWithIms(payload({ shipping_total: '7.50', line_items: [{ id: 11, quantity: 3, sku: 'RED-M', subtotal: '30.00', total: '30.00' }, { id: 12, quantity: 1, sku: 'BLU-L', subtotal: '30.00', total: '25.00' }] }), stored(), NO_REFUNDS)
  assert.equal(v.kind, 'compared')
  if (v.kind !== 'compared') return
  const text = describeDivergence(v.differences, 'GBP')
  assert.match(text, /Quantity of RED-M changed in WooCommerce: WooCommerce 3, IMS 2/)
  assert.match(text, /Shipping \(excluding tax\) changed in WooCommerce: WooCommerce 7\.50 GBP, IMS 5\.00 GBP/)
  assert.equal(divergenceFingerprint(v.differences), divergenceFingerprint(JSON.parse(JSON.stringify(v.differences))), 'stable')
})
