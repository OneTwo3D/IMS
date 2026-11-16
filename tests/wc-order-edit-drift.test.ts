import assert from 'node:assert/strict'
import test from 'node:test'

import { detectWcOrderEditDrift } from '@/lib/connectors/woocommerce/sync/order-edit-drift'

/** o3d-hqvrp.84: the comparison that surfaces an edit made in WooCommerce after import. */
const stored = { currency: 'GBP', totalForeign: '24.0000', lines: [{ externalLineItemId: 11, qty: '2.0000', sku: 'RED-M' }, { externalLineItemId: null, qty: '1.0000', sku: null }] }
const wc = (lines: Array<{ id: number; quantity: number; sku?: string }>, total = '24.00') => ({ line_items: lines, total }) as never

test('an unchanged order (fee lines carry no WooCommerce id and are ignored) has no differences', () => {
  assert.deepEqual(detectWcOrderEditDrift(wc([{ id: 11, quantity: 2, sku: 'RED-M' }]), stored), [])
})
test('a swapped variation is a removed line plus an added one', () => {
  const d = detectWcOrderEditDrift(wc([{ id: 12, quantity: 2, sku: 'RED-L' }]), stored)
  assert.equal(d.length, 2)
  assert.match(d[0], /line 12 \(RED-L\) x 2 is not on the IMS order/)
  assert.match(d[1], /IMS line 11 \(RED-M\) x 2 is no longer/)
})
test('a changed quantity and a changed total are each reported', () => {
  const d = detectWcOrderEditDrift(wc([{ id: 11, quantity: 3, sku: 'RED-M' }], '36.00'), stored)
  assert.equal(d.length, 2)
  assert.match(d[0], /is x 3; IMS holds x 2/)
  assert.match(d[1], /total is 36\.00; IMS holds 24\.00/)
})
test('a total that differs only below the minor unit is not an edit', () => {
  assert.deepEqual(detectWcOrderEditDrift(wc([{ id: 11, quantity: 2 }], '24.004'), stored), [])
})
test('a payload that states no lines or total is compared on nothing', () => {
  assert.deepEqual(detectWcOrderEditDrift({} as never, stored), [])
})

test('the same WooCommerce line id with a different SKU is an edit even when quantity and total are unchanged', () => {
  const d = detectWcOrderEditDrift(wc([{ id: 11, quantity: 2, sku: 'RED-L' }]), stored)
  assert.equal(d.length, 1)
  assert.match(d[0], /line 11 is now RED-L; IMS holds RED-M/)
})
test('SKU comparison ignores case and padding, and a line with no SKU on either side is not compared on it', () => {
  assert.deepEqual(detectWcOrderEditDrift(wc([{ id: 11, quantity: 2, sku: ' red-m ' }]), stored), [])
  assert.deepEqual(detectWcOrderEditDrift(wc([{ id: 11, quantity: 2 }]), stored), [])
})

test('ignoreTotal drops only the total difference (a paid delivery whose total disagrees already has its own obligation row)', () => {
  const d = detectWcOrderEditDrift(wc([{ id: 11, quantity: 3, sku: 'RED-M' }], '36.00'), stored, { ignoreTotal: true })
  assert.equal(d.length, 1)
  assert.match(d[0], /is x 3; IMS holds x 2/)
  assert.deepEqual(detectWcOrderEditDrift(wc([{ id: 11, quantity: 2, sku: 'RED-M' }], '36.00'), stored, { ignoreTotal: true }), [])
})
