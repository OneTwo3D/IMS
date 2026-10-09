import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

/**
 * Store credit is NEVER recorded after an order is created. `storeCreditForeign` and the discount are set once, by
 * the credit-aware import. A later delivery (webhook redelivery, poll) is re-classified and compared with the row:
 * credit, or a conflict about credit, that the row does not account for puts the order in REVIEW_REQUIRED, which
 * every posting boundary and the warehouse push refuse. Nothing is restated and no credit is written.
 */

type Stored = { storeCreditForeign: string; storeCreditAssessment: 'ASSESSED' | 'REVIEW_REQUIRED' | null }
const state = {
  stored: { storeCreditForeign: '0.0000', storeCreditAssessment: null } as Stored | null,
  reads: 0,
  writes: [] as Array<Record<string, unknown>>,
  statements: [] as string[],
  activity: [] as Array<Record<string, unknown>>,
}

const tx = {
  $queryRaw: async (sql: { sql?: string; strings?: string[] }) => { state.statements.push(`LOCK ${(sql.sql ?? sql.strings?.join('?') ?? '').replace(/\s+/g, ' ').trim()}`); return [] },
  shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
  salesOrder: {
    findUnique: async () => { state.reads += 1; return state.stored ? { ...state.stored } : null },
    // Honours the OR on the current assessment, like the database: REVIEW_REQUIRED never matches again.
    updateMany: async ({ where, data }: { where: { OR: Array<{ storeCreditAssessment: string | null }> }; data: Record<string, unknown> }) => {
      state.statements.push('CONDITIONAL review write')
      const current = state.stored?.storeCreditAssessment ?? null
      if (!where.OR.some((c) => c.storeCreditAssessment === current)) return { count: 0 }
      state.writes.push(data)
      if (state.stored) state.stored.storeCreditAssessment = data.storeCreditAssessment as Stored['storeCreditAssessment']
      return { count: 1 }
    },
    update: async ({ data }: { data: Record<string, unknown> }) => { state.writes.push(data); return {} },
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
const info = (type: string) => [{ id: 9, key: 'coupon_info', value: `[1,"sc","${type}","50"]` }]
const credit = (net = '10.00', tax = '2.00') => [{ id: 1, code: 'sc', discount: net, discount_tax: tax, meta_data: info('smart_coupon') }] as unknown as WcFullOrder['coupon_lines']
const percent = [{ id: 1, code: 'p', discount: '10.00', discount_tax: '2.00', meta_data: info('percent') }] as unknown as WcFullOrder['coupon_lines']
const conflict = [{ id: 1, code: 'sc', discount: '10.00', discount_tax: '0.00', meta_data: [...info('smart_coupon'), { id: 10, key: 'coupon_data', value: { discount_type: 'fixed_cart' } }] }] as unknown as WcFullOrder['coupon_lines']

test.beforeEach(() => {
  state.stored = { storeCreditForeign: '0.0000', storeCreditAssessment: null }
  state.reads = 0
  state.writes = []
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
const reviewEntries = () => state.activity.filter((a) => a.action === 'wc_store_credit_review_required')
const creditWrites = () => state.writes.filter((w) => 'storeCreditForeign' in w || 'discountAmount' in w)

test('credit appears on an order the row does not account for (not assessed): REVIEW_REQUIRED, credit is NOT recorded, one ERROR entry', async () => {
  await run(order(credit()))
  precondition('unassessed order, credit in payload', { stored: state.stored, writes: state.writes.length, entries: reviewEntries().length })
  assert.equal(state.stored!.storeCreditAssessment, 'REVIEW_REQUIRED')
  assert.equal(state.stored!.storeCreditForeign, '0.0000', 'the credit is never written after creation')
  assert.equal(creditWrites().length, 0, 'and neither is the discount')
  assert.match(state.statements[0], /^LOCK SELECT id FROM "sales_orders"/, 'the order row lock is taken first')
  assert.equal(reviewEntries().length, 1)
  assert.equal(reviewEntries()[0].level, 'ERROR')
  assert.match(String(reviewEntries()[0].description), /HELD for store-credit review/)
})

test('an ASSESSED order whose credit is unchanged is left alone', async () => {
  state.stored = { storeCreditForeign: '12.0000', storeCreditAssessment: 'ASSESSED' }
  await run(order(credit()))
  precondition('assessed, same credit', { reads: state.reads })
  assert.equal(state.reads, 1, 'precondition: the row was compared')
  assert.equal(state.stored!.storeCreditAssessment, 'ASSESSED')
  assert.equal(reviewEntries().length, 0)
})

test('an ASSESSED order whose credit CHANGED in WooCommerce is held for review', async () => {
  state.stored = { storeCreditForeign: '12.0000', storeCreditAssessment: 'ASSESSED' }
  await run(order(credit('20.00', '4.00')))
  precondition('assessed, credit changed', { stored: 12, payload: 24 })
  assert.equal(state.stored!.storeCreditAssessment, 'REVIEW_REQUIRED')
  assert.equal(state.stored!.storeCreditForeign, '12.0000')
})

test('a CONFLICT about credit on a later delivery holds the order, even with no credit amount', async () => {
  state.stored = { storeCreditForeign: '0.0000', storeCreditAssessment: 'ASSESSED' }
  await run(order(conflict))
  precondition('conflict on update', { stored: state.stored })
  assert.equal(state.stored!.storeCreditAssessment, 'REVIEW_REQUIRED')
})

test('no credit and no conflict: nothing is read, nothing is written', async () => {
  await run(order(percent))
  await run(order([]))
  precondition('no credit', { reads: state.reads, reviewWrites: state.statements.filter((s) => s.startsWith('CONDITIONAL')).length })
  assert.equal(state.writes.length, 2, 'precondition: both order updates ran')
  assert.equal(state.reads, 0)
  assert.equal(state.stored!.storeCreditAssessment, null)
})

test('the credit is also found from the order-level contribution record', async () => {
  const lines = [{ id: 1, code: 'x', discount: '5.00', discount_tax: '0.00', meta_data: [] }] as unknown as WcFullOrder['coupon_lines']
  await run(order(lines, [{ id: 3, key: 'smart_coupons_contribution', value: { x: 5 } }] as unknown as WcFullOrder['meta_data']))
  assert.equal(state.stored!.storeCreditAssessment, 'REVIEW_REQUIRED')
})

test('an order already in review is not written or logged again; two concurrent deliveries log once (repeated)', async () => {
  state.stored = { storeCreditForeign: '0.0000', storeCreditAssessment: 'REVIEW_REQUIRED' }
  await run(order(credit()))
  assert.equal(reviewEntries().length, 0, 'already in review: nothing to say again')
  for (let round = 0; round < 40; round++) {
    state.stored = { storeCreditForeign: '0.0000', storeCreditAssessment: null }
    state.activity = []
    await Promise.all([run(order(credit())), run(order(credit('9.00', '1.00')))])
    assert.equal(reviewEntries().length, 1, `round ${round}: exactly one delivery flagged and logged`)
    assert.equal(state.stored!.storeCreditAssessment, 'REVIEW_REQUIRED')
    assert.equal(state.stored!.storeCreditForeign, '0.0000')
  }
  precondition('race', { rounds: 40 })
})
