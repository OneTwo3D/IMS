import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

/**
 * An order IMS already holds is re-read on every webhook redelivery and poll, and `updateExistingWcOrderFromPayload`
 * used to return before any coupon was classified. An order imported before store credit was recorded separately
 * (credit stored as a discount, `storeCreditForeign` 0) would therefore sail through the invoice refusal.
 *
 * Owner ruling: no retrospective data fixes. So the update path only RECORDS the credit while the stored credit is
 * zero (which makes the poster refuse the invoice / credit note / payment) and says so; it never restates the discount.
 */

const state = {
  stored: { storeCreditForeign: '0.0000' } as { storeCreditForeign: unknown } | null,
  reads: 0,
  updates: [] as Array<Record<string, unknown>>,
  activity: [] as Array<Record<string, unknown>>,
}

const tx = {
  shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
  salesOrder: {
    findUnique: async () => { state.reads += 1; return state.stored },
    update: async ({ data }: { data: Record<string, unknown> }) => { state.updates.push(data); return {} },
  },
}
mock.module('@/lib/db', { namedExports: { db: { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: Record<string, unknown>) => { state.activity.push(e) } } })

function order(coupons: WcFullOrder['coupon_lines'], meta: WcFullOrder['meta_data'] = []): WcFullOrder {
  return {
    id: 501, number: '1501', order_key: 'wc_order_x', customer_note: '', date_paid_gmt: null,
    billing: { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB', email: 'a@b.c', phone: '' },
    shipping: { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB' },
    meta_data: meta, coupon_lines: coupons, line_items: [], shipping_lines: [], fee_lines: [],
  } as unknown as WcFullOrder
}
const credit = [{ id: 1, code: 'sc', discount: '10.00', discount_tax: '2.00', meta_data: [{ id: 9, key: 'coupon_info', value: '[1,"sc","smart_coupon","50"]' }] }] as unknown as WcFullOrder['coupon_lines']
const percent = [{ id: 1, code: 'p', discount: '10.00', discount_tax: '2.00', meta_data: [{ id: 9, key: 'coupon_info', value: '[1,"p","percent","10"]' }] }] as unknown as WcFullOrder['coupon_lines']

test.beforeEach(() => {
  state.stored = { storeCreditForeign: '0.0000' }
  state.reads = 0
  state.updates = []
  state.activity = []
})

async function run(wc: WcFullOrder) {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  await updateExistingWcOrderFromPayload('so-1', wc)
}
function precondition(name: string, facts: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION ${name}: ${JSON.stringify(facts)}`)
}

test('a re-read order with store credit and a stored credit of 0 RECORDS the credit (gross) and says it was not restated', async () => {
  await run(order(credit))
  precondition('legacy credit order', { payloadCredit: 12, stored: 0, updates: state.updates.length })
  assert.equal(state.updates.length, 1, 'precondition: the order update ran')
  assert.equal(String(state.updates[0].storeCreditForeign), '12')
  assert.ok(!('discountAmount' in state.updates[0]), 'the discount is NOT restated')
  const entry = state.activity.find((a) => a.action === 'wc_store_credit_recorded_on_update')
  assert.ok(entry, 'an ERROR entry names it')
  assert.equal(entry!.level, 'ERROR')
  assert.match(String(entry!.description), /was NOT restated/)
})

test('an order whose credit is already recorded is left alone (the stored credit is never overwritten)', async () => {
  state.stored = { storeCreditForeign: '12.0000' }
  await run(order(credit))
  precondition('already recorded', { stored: 12 })
  assert.equal(state.reads, 1, 'precondition: the stored credit was read')
  assert.ok(!('storeCreditForeign' in state.updates[0]))
  assert.equal(state.activity.length, 0)
})

test('an order with only a genuine coupon, or none, reads nothing and records nothing', async () => {
  await run(order(percent))
  await run(order([]))
  precondition('no credit', { reads: state.reads, updates: state.updates.length })
  assert.equal(state.updates.length, 2, 'precondition: both updates ran')
  assert.equal(state.reads, 0)
  assert.ok(state.updates.every((u) => !('storeCreditForeign' in u)))
})

test('the credit is also found from the order-level contribution record', async () => {
  const lines = [{ id: 1, code: 'x', discount: '5.00', discount_tax: '0.00', meta_data: [] }] as unknown as WcFullOrder['coupon_lines']
  await run(order(lines, [{ id: 3, key: 'smart_coupons_contribution', value: { x: 5 } }] as unknown as WcFullOrder['meta_data']))
  precondition('contribution', { updates: state.updates.length })
  assert.equal(String(state.updates[0].storeCreditForeign), '5')
})
