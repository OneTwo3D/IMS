/**
 * Mirrored WooCommerce FEE lines (the wclc EU Import Duty / EU Customs Fee) and the warehouse push.
 *
 * The woo-mintsoft plugin (wc_mintsoft_orders.py) builds OrderItems from line_items only and sends TotalVat as the order's
 * total tax; fees only enter its own gross validation. IMS must do the same: skip fee lines instead of failing the order for
 * "no SKU", keep their VAT in TotalVat, and keep the push-total guard balanced by withholding their NET. Nothing here calls
 * Mintsoft: these are pure builders.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLines, buildPushInput, payloadTotalMismatchPence } from '../lib/domain/wms/order-push-sweep.ts'
import { buildPushPayload } from '../lib/connectors/mintsoft/api/order-push.ts'
import { isMirroredFeeLine } from '../lib/domain/wms/mirrored-fee-line.ts'
import { reconcilePushTotals } from '../lib/domain/wms/push-total-guard.ts'

const goods = { id: 'g1', sku: 'SKU-A', qty: 2, taxForeign: 4.2, totalForeign: 20, description: 'Widget', productId: 'p1', externalLineItemId: 11, wclcFeeKind: null }
// Persisted marker (new imports) ...
const duty = { id: 'f1', sku: '', qty: 1, taxForeign: 1.26, totalForeign: 6, description: 'EU Import Duty', productId: null, externalLineItemId: null, wclcFeeKind: 'duty_flat' }
const uhf = { id: 'f2', sku: '', qty: 1, taxForeign: 0.84, totalForeign: 4, description: 'EU Customs Fee', productId: null, externalLineItemId: null, wclcFeeKind: 'uhf' }
// ... and a fee imported before the marker existed: recognised by its shape.
const legacyFee = { id: 'f3', sku: null, qty: 1, taxForeign: 0, totalForeign: 3, description: 'EU Duty', productId: null, externalLineItemId: null, wclcFeeKind: null }

function order(lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: '1001', currency: 'EUR',
    customerName: 'A B', customerEmail: null, customerVatNumber: null,
    shippingAddress: { address1: '1 St', firstName: 'A', lastName: 'B', country: 'NL' }, shippingService: null,
    subtotalForeign: 30, shippingForeign: 5, taxForeign: 7.35, taxRatePercent: null,
    pricesIncludeVat: false, discountAmount: 0, totalForeign: 42.35,
    lines, refunds: [],
    ...over,
  } as unknown as Parameters<typeof buildPushInput>[0]
}

test('an order with EU Import Duty + EU Customs Fee pushes the goods item only', () => {
  const input = buildPushInput(order([goods, duty, uhf]), '301')
  assert.deepEqual(input.lines.map((l) => l.sku), ['SKU-A'])
  assert.deepEqual(buildPushPayload(input, { kind: 'name' }).OrderItems, [
    { SKU: 'SKU-A', Quantity: 2, UnitPrice: 10, UnitPriceVat: 2.1, Details: 'Widget' },
  ])
  // The fees' VAT stays in the order's total VAT, as the plugin's TotalVat (WooCommerce total_tax) does.
  assert.equal(input.totalVat, 7.35)
})

test('the push-total guard balances: fee NET is withheld, fee VAT is already in TotalVat', () => {
  const o = order([goods, duty, uhf])
  assert.equal(payloadTotalMismatchPence(o, buildPushInput(o, '301')), null)
  const verdict = reconcilePushTotals({
    currency: 'EUR', orderTotal: 42.35, withheldGoodsGross: 10, withheldNetOnlyLineCount: 2,
    payload: buildPushInput(o, '301'),
  })
  assert.equal(verdict.status, 'RECONCILED')
  assert.equal(verdict.expectedGross, '32.35')
})

test('the guard CAN fail: without withholding the fee net the same payload is a 10.00 mismatch', () => {
  const o = order([goods, duty, uhf])
  const blind = reconcilePushTotals({ currency: 'EUR', orderTotal: 42.35, payload: buildPushInput(o, '301') })
  assert.equal(blind.status, 'MISMATCH')
  assert.equal(blind.driftMinorUnits, 1000)
})

test('a fee imported before the marker existed is recognised by its shape and skipped too', () => {
  const o = order([goods, legacyFee], { subtotalForeign: 23, taxForeign: 5.25, totalForeign: 33.45 - 0 })
  assert.deepEqual(buildLines(o.lines).map((l) => l.sku), ['SKU-A'])
  assert.equal(isMirroredFeeLine(legacyFee), true)
})

test('an unknown SKU-less NON-fee line still fails the order, as before', () => {
  // A WooCommerce goods line IMS holds no product for: no SKU, no product, but it HAS a WooCommerce line-item id.
  const unknownGoods = { id: 'u1', sku: '', qty: 1, taxForeign: 0, totalForeign: 5, description: 'Mystery', productId: null, externalLineItemId: 77, wclcFeeKind: null }
  assert.equal(isMirroredFeeLine(unknownGoods), false)
  assert.throws(() => buildLines([goods, unknownGoods]), /no SKU/)
  // And a SKU-less line that is tied to a product.
  assert.throws(() => buildLines([{ ...goods, sku: null }]), /no SKU/)
})

test('goods are never mistaken for fees: a line with a SKU is never skipped, whatever else it lacks', () => {
  assert.equal(isMirroredFeeLine({ sku: 'X', productId: null, externalLineItemId: null, wclcFeeKind: null }), false)
  assert.equal(isMirroredFeeLine(goods), false)
  assert.equal(buildLines([goods]).length, 1)
})

test('an order of fee lines alone yields no items (nothing to fulfil) rather than a SKU error', () => {
  assert.deepEqual(buildLines([duty, uhf]), [])
})

test('a SKU-less line whose product / line-item columns were not read is not assumed to be a fee', () => {
  assert.equal(isMirroredFeeLine({ sku: '' }), false)
  assert.throws(() => buildLines([{ sku: '', qty: 1, taxForeign: 0, totalForeign: 5, description: 'x' }]), /no SKU/)
})
