import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-hqvrp.84 against a real database: an order edited in WooCommerce after import is recorded as ONE open row
 * (own recordKind) that the exception inbox reads, replaced when the difference changes, refreshed (not duplicated)
 * on a redelivery, and cleared when the orders agree again. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/wc-order-edit-drift.test.ts would have been skipped')
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { Prisma } = await import('@/app/generated/prisma/client')
  return { db, D: (v: string) => new Prisma.Decimal(v) }
}

const payload = (id: number, lines: Array<{ id: number; quantity: number; sku: string }>, total: string) => ({ id, number: String(id), total, line_items: lines }) as never

test('edit drift: recorded once, replaced on change, refreshed on redelivery, cleared on agreement', { skip }, async (t) => {
  const { db, D } = await setup()
  const { surfaceWcOrderEditDrift, wcOrderEditDriftWhere } = await import('@/lib/connectors/woocommerce/sync/order-edit-drift')
  const suffix = randomUUID().slice(0, 8)
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `ED-${suffix}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D('20'), totalForeign: D('24'), subtotalBase: D('20'), taxBase: D('4'), totalBase: D('24'),
      lines: { create: [{ description: 'Red M', sku: 'RED-M', externalLineItemId: 11, qty: D('2'), unitPriceForeign: D('10'), unitPriceBase: D('10'), taxForeign: D('4'), taxBase: D('4'), totalForeign: D('24'), totalBase: D('24') }] },
    },
    select: { id: true },
  })
  t.after(async () => {
    await db.shoppingSyncLog.deleteMany({ where: { entityId: order.id } })
    await db.activityLog.deleteMany({ where: { entityId: order.id } })
    await db.salesOrderLine.deleteMany({ where: { orderId: order.id } })
    await db.salesOrder.delete({ where: { id: order.id } })
  })
  const open = () => db.shoppingSyncLog.findMany({ where: { ...wcOrderEditDriftWhere(), entityId: order.id } })
  const wcId = 900000 + Math.floor(Math.random() * 90000)

  await surfaceWcOrderEditDrift(order.id, payload(wcId, [{ id: 11, quantity: 2, sku: 'RED-M' }], '24.00'))
  assert.equal((await open()).length, 0, 'an unedited order records nothing')

  await surfaceWcOrderEditDrift(order.id, payload(wcId, [{ id: 12, quantity: 2, sku: 'RED-L' }], '24.00'))
  const first = await open()
  assert.equal(first.length, 1)
  assert.match(String(first[0].errorMessage), /line 12 \(RED-L\) x 2 is not on the IMS order/)
  assert.match(String(first[0].errorMessage), /line 11 \(RED-M\) x 2 is no longer on the WooCommerce order/)
  assert.equal(await db.activityLog.count({ where: { entityId: order.id, action: 'wc_order_edited_after_import' } }), 1)

  await surfaceWcOrderEditDrift(order.id, payload(wcId, [{ id: 12, quantity: 2, sku: 'RED-L' }], '24.00'))
  const again = await open()
  assert.equal(again.length, 1, 'a redelivery does not duplicate the row')
  assert.equal(again[0].id, first[0].id)
  assert.equal(await db.activityLog.count({ where: { entityId: order.id, action: 'wc_order_edited_after_import' } }), 1, 'nor repeat the notice')

  await surfaceWcOrderEditDrift(order.id, payload(wcId, [{ id: 11, quantity: 3, sku: 'RED-M' }], '30.00'))
  const changed = await open()
  assert.equal(changed.length, 1)
  assert.match(String(changed[0].errorMessage), /x 3; IMS holds x 2/)
  assert.match(String(changed[0].errorMessage), /total is 30\.00; IMS holds 24\.00/)

  await surfaceWcOrderEditDrift(order.id, payload(wcId, [{ id: 11, quantity: 2, sku: 'RED-M' }], '24.00'))
  assert.equal((await open()).length, 0, 'edited back: the row clears itself')
})
