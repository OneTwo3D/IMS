import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * AN ORDER FIRST SEEN AS COMPLETED / REFUNDED, AGAINST A REAL DATABASE (o3d-hqvrp.92).
 *
 * `importWcOrder` used to create an order first seen as `completed` straight in COMPLETED (a status the machine reaches only from a despatch) and then
 * reserve stock for it, and one first seen as `refunded` as a live PROCESSING order with demand. Now:
 *  - completed / shipped / delivered at first sight: recorded in that status, with NO allocation, NO reservation, NO shipment and NO stock movement
 *    (IMS did not despatch it), and never a warehouse push candidate;
 *  - refunded at first sight: created CANCELLED (zero demand), never live, never pushable.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/wc-first-seen-post-dispatch.test.ts would have been skipped. Fix the invocation (npm run test:db).',
  )
}

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const db = (await import('../../lib/db')).db
  const [row] = await db.$queryRaw<Array<{ n: string }>>`SELECT current_database()::text AS n`
  if (/^(postgres|template|pg_)|onetwo3d|onetwoinventory|prod|live/i.test(row!.n) || !/scratch|_ci$|_test$/i.test(row!.n)) {
    throw new Error(`refusing to run against database "${row!.n}": it is not a scratch/CI database`)
  }
  return db
}

function wcOrder(id: number, status: string, sku: string) {
  return {
    id, number: String(id), parent_id: 0, order_key: `wc_order_${id}`, created_via: 'checkout', version: '9.0.0', status, currency: 'GBP',
    date_created: '2026-11-10T09:00:00', date_created_gmt: '2026-11-10T09:00:00', date_modified: '2026-11-10T10:00:00', date_modified_gmt: '2026-11-10T10:00:00',
    discount_total: '0.00', discount_tax: '0.00', shipping_total: '0.00', shipping_tax: '0.00', cart_tax: '0.00', total: '10.00', total_tax: '0.00',
    prices_include_tax: false, customer_id: 0, customer_ip_address: '', customer_note: '',
    billing: { first_name: 'Hist', last_name: 'Order', company: '', address_1: '1 Road', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB', email: `h${id}@example.invalid`, phone: '' },
    shipping: { first_name: 'Hist', last_name: 'Order', company: '', address_1: '1 Road', address_2: '', city: 'Town', state: '', postcode: 'AB1 2CD', country: 'GB' },
    payment_method: 'bacs', payment_method_title: 'BACS', transaction_id: '', date_paid: null, date_paid_gmt: null, date_completed: null, date_completed_gmt: null, cart_hash: '',
    meta_data: [],
    line_items: [{ id: 1, name: sku, product_id: 1, variation_id: 0, quantity: 2, tax_class: '', subtotal: '10.00', subtotal_tax: '0.00', total: '10.00', total_tax: '0.00', taxes: [], meta_data: [], sku, price: 5 }],
    tax_lines: [], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [],
  } as never
}

test('first seen as completed / shipped: recorded with no reservation, shipment or stock movement; first seen as refunded: CANCELLED with no demand', { skip }, async (t) => {
  const db = await getDb()
  const { importWcOrder } = await import('../../lib/connectors/woocommerce/sync/order-import')
  const { wmsCreateEligibleOrderWhere } = await import('../../lib/domain/wms/create-eligibility')
  const RUN = `PD-${process.pid}-${randomUUID().slice(0, 8)}`
  const warehouse = await db.warehouse.create({ data: { code: RUN, name: RUN, type: 'STANDARD', syncToStore: true, isDefault: false }, select: { id: true } })
  const product = await db.product.create({ data: { sku: RUN, name: RUN, type: 'SIMPLE' }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: 10, reservedQty: 0 } })
  const ids: number[] = []
  const importAs = async (status: string, skuOverride?: string) => {
    const id = 800_000_000 + Math.floor(Math.random() * 90_000_000)
    ids.push(id)
    const result = await importWcOrder(wcOrder(id, status, skuOverride ?? RUN), { skipAccounting: true, createAdmission: 'preauthorised-by-status-query' })
    assert.equal(result.success, true, JSON.stringify(result))
    const link = await db.shoppingOrderLink.findUnique({ where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(id) } }, select: { orderId: true } })
    assert.ok(link, 'the order is linked')
    return link.orderId
  }
  t.after(async () => {
    const orders = await db.shoppingOrderLink.findMany({ where: { externalOrderId: { in: ids.map(String) } }, select: { orderId: true } })
    const orderIds = orders.map((o) => o.orderId)
    await db.activityLog.deleteMany({ where: { entityId: { in: [...orderIds, product.id] } } })
    await db.shoppingSyncLog.deleteMany({ where: { entityId: { in: orderIds } } })
    await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    await db.stockLevel.deleteMany({ where: { productId: product.id } })
    await db.product.deleteMany({ where: { id: product.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
  })

  const stockState = async () => {
    const level = await db.stockLevel.findUnique({ where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } } })
    return { onHand: level!.quantity.toString(), reserved: level!.reservedQty.toString() }
  }
  const untouched = async (orderId: string) => {
    assert.equal(await db.orderAllocation.count({ where: { orderId } }), 0, 'no allocation row')
    assert.equal(await db.shipment.count({ where: { orderId } }), 0, 'no shipment')
    assert.equal(await db.stockMovement.count({ where: { productId: product.id } }), 0, 'no stock movement for the product')
    assert.deepEqual(await stockState(), { onHand: '10', reserved: '0' }, 'on-hand and reserved are as they were')
  }
  const pushable = async (orderId: string) => (await db.salesOrder.count({ where: { id: orderId, ...wmsCreateEligibleOrderWhere([warehouse.id]) } })) > 0

  const completedId = await importAs('completed')
  const completed = await db.salesOrder.findUniqueOrThrow({ where: { id: completedId }, select: { status: true, refundStatus: true } })
  assert.equal(completed.status, 'COMPLETED')
  await untouched(completedId)
  assert.equal(await pushable(completedId), false, 'a completed-at-import order is never a warehouse create candidate')
  assert.equal(await db.activityLog.count({ where: { entityId: completedId, action: 'order_imported_post_dispatch_no_stock' } }), 1, 'the choice is recorded on the order')

  const refundedId = await importAs('refunded')
  const refunded = await db.salesOrder.findUniqueOrThrow({ where: { id: refundedId }, select: { status: true, refundStatus: true, salesInvoiceOwedAt: true } })
  assert.equal(refunded.status, 'CANCELLED', 'refunded at first sight is not a live order')
  assert.equal(refunded.salesInvoiceOwedAt, null, 'no invoice is owed for it')
  await untouched(refundedId)
  assert.equal(await pushable(refundedId), false, 'a refunded-at-import order is never a warehouse create candidate')

  // The control: an ordinary processing order still reserves stock (the guard is narrow).
  const liveId = await importAs('processing')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: liveId }, select: { status: true } })).status.length > 0, true)
  assert.ok((await db.orderAllocation.count({ where: { orderId: liveId } })) > 0, 'a processing order is still allocated')
  assert.deepEqual(await stockState(), { onHand: '10', reserved: '2' })
})
