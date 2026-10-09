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
  statements: [] as string[],
  activity: [] as Array<Record<string, unknown>>,
}

const tx = {
  $queryRaw: async (sql: { sql?: string; strings?: string[] }) => { state.statements.push(`LOCK ${(sql.sql ?? sql.strings?.join('?') ?? '').replace(/\s+/g, ' ').trim()}`); return [] },
  shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
  salesOrder: {
    // The conditional write: honours `storeCreditForeign: 0`, like the database would.
    updateMany: async ({ where, data }: { where: { storeCreditForeign?: number }; data: Record<string, unknown> }) => {
      state.statements.push('CONDITIONAL credit write')
      state.reads += 1
      const stored = Number(state.stored?.storeCreditForeign ?? 0)
      if (where.storeCreditForeign !== undefined && stored !== where.storeCreditForeign) return { count: 0 }
      state.updates.push(data)
      if (state.stored) state.stored.storeCreditForeign = String(data.storeCreditForeign)
      return { count: 1 }
    },
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
  state.statements = []
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
  assert.equal(state.updates.length, 2, 'precondition: the credit write and the order update both ran')
  assert.equal(String(state.updates[0].storeCreditForeign), '12')
  assert.ok(state.updates.every((u) => !('discountAmount' in u)), 'the discount is NOT restated')
  assert.match(state.statements[0], /^LOCK SELECT id FROM "sales_orders"/, 'the order row lock is the FIRST statement')
  assert.equal(state.statements[1], 'CONDITIONAL credit write')
  const entry = state.activity.find((a) => a.action === 'wc_store_credit_recorded_on_update')
  assert.ok(entry, 'an ERROR entry names it')
  assert.equal(entry!.level, 'ERROR')
  assert.match(String(entry!.description), /was NOT restated/)
})

test('an order whose credit is already recorded is left alone (the stored credit is never overwritten)', async () => {
  state.stored = { storeCreditForeign: '12.0000' }
  await run(order(credit))
  precondition('already recorded', { stored: 12 })
  assert.equal(state.reads, 1, 'precondition: the conditional write was attempted')
  assert.ok(state.updates.every((u) => !('storeCreditForeign' in u)), 'and it matched nothing')
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

test('TWO deliveries with different amounts: the first credit wins, the second writes nothing and logs nothing (repeated)', async () => {
  for (let round = 0; round < 40; round++) {
    state.stored = { storeCreditForeign: '0.0000' }
    state.updates = []
    state.activity = []
    const small = [{ id: 1, code: 'sc', discount: '5.00', discount_tax: '0.00', meta_data: [{ id: 9, key: 'coupon_info', value: '[1,"sc","smart_coupon","50"]' }] }] as unknown as WcFullOrder['coupon_lines']
    const deliveries = round % 2 ? [order(credit), order(small)] : [order(small), order(credit)]
    await Promise.all(deliveries.map((d) => run(d)))
    const creditWrites = state.updates.filter((u) => 'storeCreditForeign' in u)
    assert.equal(creditWrites.length, 1, `round ${round}: exactly one delivery wrote the credit`)
    assert.equal(state.activity.filter((a) => a.action === 'wc_store_credit_recorded_on_update').length, 1, `round ${round}: and only that one logged`)
    assert.equal(String(state.stored!.storeCreditForeign), String(creditWrites[0].storeCreditForeign))
  }
  precondition('race', { rounds: 40 })
})
