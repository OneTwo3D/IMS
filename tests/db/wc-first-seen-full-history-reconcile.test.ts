import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { purge } from '../helpers/purge-rows'
import { serveWcOrders, type StoreOrder } from '../helpers/wc-order-store'

/**
 * o3d-hqvrp.92: THE FIRST RECONCILE AFTER GO-LIVE WALKS THE STORE'S WHOLE HISTORY, always with `completed` added and no modified-after bound, and every
 * completed order in it is first-seen. Those orders pre-date the opening stock, whose quantities and cost layers already reflect them: none may consume
 * stock, post cost or reserve anything. Real database, the store stubbed at the REST boundary (no network). Gated on RUN_DB_RETENTION_TESTS.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/wc-first-seen-full-history-reconcile.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })

let storeOrders: StoreOrder[] = []
const requests: Array<Record<string, string>> = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

test('[db] a full-history first reconcile walk over pre-cut-off completed orders makes no stock writes', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const realApi = await import('../../lib/connectors/woocommerce/api')
  mock.module('@/lib/connectors/woocommerce/api', {
    namedExports: {
      ...realApi,
      wcFetch: async (path: string, params: Record<string, string> = {}) => {
        requests.push({ path, ...params })
        if (path === '/orders') {
          const rows = serveWcOrders(storeOrders, params)
          return { data: rows, totalPages: 1, totalItems: rows.length, error: null }
        }
        return { data: [], totalPages: 1, totalItems: 0, error: null }
      },
    },
  })
  const { db } = (await import('../../lib/db')) as Any
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  const D = (v: number) => new Prisma.Decimal(String(v))
  const suffix = randomUUID().slice(0, 8)

  const warehouse = await db.warehouse.create({ data: { code: `H92${suffix}`, name: `h92 ${suffix}`, active: true, syncToStore: true, isDefault: false }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `H92-${suffix}`, name: `h92 ${suffix}`, type: 'SIMPLE' }, select: { id: true, sku: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: D(50), reservedQty: D(0) } })
  await db.costLayer.create({ data: { productId: product.id, warehouseId: warehouse.id, receivedQty: D(50), remainingQty: D(50), unitCostBase: D(3), receivedAt: new Date('2026-10-01T00:00:00Z') } })
  await db.firstLoadApplyRun.deleteMany({ where: { manifestDigest: { startsWith: 'h92-' } } })
  await db.firstLoadApplyRun.create({ data: { version: 1, manifestDigest: `h92-${randomUUID()}`, runId: `h92-${randomUUID()}`, status: 'APPLIED', facts: { openingStockCutoffAt: '2026-11-05T00:00:00.000Z' } } })
  const keys = ['wc_initial_import_completed', 'wc_sync_order_statuses', 'last_wc_order_reconcile_at', 'wc_order_sync_reconcile_cursor']
  // Every setting the walk may read or write: the named keys and every cursor (and its fingerprint / outage marker) of the order sweep. Snapshot, clear, and restore afterwards.
  const touched = { OR: [{ key: { in: keys } }, { key: { startsWith: 'last_wc_order_' } }, { key: { startsWith: 'wc_order_sync' } }] }
  const before = await db.setting.findMany({ where: touched })
  await db.setting.deleteMany({ where: touched })
  await db.setting.create({ data: { key: 'wc_initial_import_completed', value: 'true' } })
  await db.setting.create({ data: { key: 'wc_sync_order_statuses', value: '["processing"]' } })

  const base = 910_000_000 + Math.floor(Math.random() * 80_000)
  const history = Array.from({ length: 3 }, (_, i): StoreOrder => ({
    id: base + i, number: String(base + i), status: 'completed', currency: 'GBP', total: '20', total_tax: '0', discount_total: '0', shipping_total: '0', shipping_tax: '0', cart_tax: '0', prices_include_tax: false,
    date_created_gmt: '2026-09-01T10:00:00', date_paid_gmt: '2026-09-01T10:00:00', date_completed_gmt: `2026-09-0${i + 2}T10:00:00`, date_modified_gmt: `2026-09-0${i + 2}T10:00:00`, customer_id: 0,
    billing: { first_name: 'Ada', last_name: 'Hist', email: `h92-${suffix}-${i}@example.invalid`, country: 'GB' }, shipping: { country: 'GB' },
    payment_method: 'bacs', payment_method_title: 'BACS', meta_data: [], tax_lines: [], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [],
    line_items: [{ id: base + 1000 + i, name: 'h92', product_id: 1, variation_id: 0, quantity: 2, subtotal: '20', subtotal_tax: '0', total: '20', total_tax: '0', sku: product.sku, price: 10, taxes: [], meta_data: [] }],
  }))
  storeOrders = history
  t.after(async () => {
    const links = await db.shoppingOrderLink.findMany({ where: { connector: 'woocommerce', externalOrderId: { in: history.map((o) => String(o.id)) } }, select: { orderId: true } })
    const orderIds = links.map((l: { orderId: string }) => l.orderId)
    await db.activityLog.deleteMany({ where: { entityId: { in: orderIds } } })
    await db.shoppingSyncLog.deleteMany({ where: { OR: [{ entityId: { in: orderIds } }, { externalId: { in: history.map((o) => String(o.id)) } }] } })
    await purge(db, 'sales_orders', 'id', orderIds)
    const customers = await db.customer.findMany({ where: { email: { startsWith: `h92-${suffix}` } }, select: { id: true } })
    await purge(db, 'customers', 'id', customers.map((c: { id: string }) => c.id))
    await purge(db, 'products', 'id', [product.id])
    await purge(db, 'warehouses', 'id', [warehouse.id])
    await db.firstLoadApplyRun.deleteMany({ where: { manifestDigest: { startsWith: 'h92-' } } })
    await db.setting.deleteMany({ where: touched })
    for (const row of before) await db.setting.create({ data: { key: row.key, value: row.value } })
  })

  const result = await syncNewWcOrders({ mode: 'reconcile' })
  assert.deepEqual(result.errors, [], JSON.stringify(result))
  assert.ok(requests.some((r) => r.path === '/orders' && String(r.status).includes('completed')), 'the walk asked for completed orders')
  assert.ok(!requests.find((r) => r.path === '/orders' && String(r.status).includes('completed'))?.modified_after, 'the first read has no modified-after bound: the whole history')
  const links = await db.shoppingOrderLink.findMany({ where: { connector: 'woocommerce', externalOrderId: { in: history.map((o) => String(o.id)) } }, select: { orderId: true } })
  assert.equal(links.length, 3, 'every historical order was recorded')
  const orderIds = links.map((l: { orderId: string }) => l.orderId)

  const level = await db.stockLevel.findFirstOrThrow({ where: { productId: product.id, warehouseId: warehouse.id } })
  assert.equal(Number(level.quantity), 50, 'opening stock untouched')
  assert.equal(Number(level.reservedQty), 0)
  assert.equal(Number((await db.costLayer.findFirstOrThrow({ where: { productId: product.id } })).remainingQty), 50, 'FIFO untouched')
  assert.equal(await db.stockMovement.count({ where: { productId: product.id } }), 0, 'no movement')
  assert.equal(await db.cogsEntry.count({ where: { movement: { productId: product.id } } }), 0, 'no cost posted')
  assert.equal(await db.orderAllocation.count({ where: { orderId: { in: orderIds } } }), 0)
  assert.equal(await db.shipment.count({ where: { orderId: { in: orderIds } } }), 0)
})
