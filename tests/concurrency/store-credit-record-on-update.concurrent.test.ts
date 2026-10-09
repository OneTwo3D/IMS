import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * Store credit is never recorded after creation. A later delivery that shows credit the stored row does not
 * account for puts the order in REVIEW_REQUIRED. Two deliveries of the same WooCommerce order (a webhook and a
 * poll, or two webhooks), carrying DIFFERENT credit amounts, reach `updateExistingWcOrderFromPayload` together
 * for an order IMS holds with no assessment: exactly one may flag and log, the credit column must stay 0, and
 * the order must end in REVIEW_REQUIRED. Repeated, because a race that passes once proves little.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}

function payload(externalId: number, creditNet: string) {
  const address = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB', email: 'a@b.c', phone: '' }
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    customer_note: '', date_paid_gmt: null, date_created: '2026-08-01T09:00:00', date_created_gmt: '2026-08-01T09:00:00',
    billing: address, shipping: address, meta_data: [],
    coupon_lines: [{ id: 1, code: 'sc', discount: creditNet, discount_tax: '0.00', meta_data: [{ id: 9, key: 'coupon_info', value: '[1,"sc","smart_coupon","50"]' }] }],
    line_items: [], tax_lines: [], shipping_lines: [], fee_lines: [], refunds: [],
  }
}

test(
  '[store credit] two concurrent deliveries with different credit amounts: one flags the order for review, one entry, no credit written',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
    const ROUNDS = 15
    const seen = new Set<string>()
    for (let round = 0; round < ROUNDS; round++) {
      const id = `SCR-${process.pid}-${randomUUID()}`
      const externalId = Math.floor(Math.random() * 2_000_000_000)
      t.after(async () => {
        await db.activityLog.deleteMany({ where: { entityId: id } })
        await db.salesOrder.deleteMany({ where: { id } })
      })
      await db.salesOrder.create({
        data: {
          id, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100,
          shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: String(externalId), externalOrderNumber: String(externalId) } },
        },
      })
      const a = payload(externalId, '5.00')
      const b = payload(externalId, '9.00')
      await Promise.all(round % 2 ? [updateExistingWcOrderFromPayload(id, a as never), updateExistingWcOrderFromPayload(id, b as never)]
        : [updateExistingWcOrderFromPayload(id, b as never), updateExistingWcOrderFromPayload(id, a as never)])
      const row = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { storeCreditForeign: true, storeCreditAssessment: true } })
      const entries = await db.activityLog.count({ where: { entityId: id, action: 'wc_store_credit_review_required' } })
      assert.equal(row.storeCreditAssessment, 'REVIEW_REQUIRED', `round ${round}: the order ends in review`)
      assert.equal(row.storeCreditForeign.toString(), '0', `round ${round}: no credit is ever written after creation`)
      assert.equal(entries, 1, `round ${round}: exactly one delivery logged`)
      seen.add(`${round % 2}`)
    }
    // eslint-disable-next-line no-console
    console.log(`PRECONDITION store-credit race: ${ROUNDS} rounds, delivery orders seen: ${[...seen].join(',')}`)
  },
)
