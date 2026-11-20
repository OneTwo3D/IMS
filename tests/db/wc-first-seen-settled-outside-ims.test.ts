import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-hqvrp.92, on a real database: an order IMS first sees AFTER its sale was settled outside IMS.
 *
 *   completed / shipped-mapped  the goods already left through the incumbent. IMS consumes the stock and posts the cost as an out-of-band
 *                               despatch (on-hand down, FIFO layer consumed, SALE_DISPATCH movement, COGS), and never asks a warehouse to
 *                               pick it. The stock level WooCommerce is pushed (quantity - reservedQty) is therefore the REDUCED one.
 *   refunded                    stays refundable (PROCESSING, not CANCELLED), holds no allocation and is fenced from the warehouse; the
 *                               refund sweep's writer records its refund, so the sale/refund pair can reach the ledger.
 *
 * Gated on RUN_DB_RETENTION_TESTS (npm run test:db). Needs a scratch database; no network. Rows are committed (the import opens its own
 * transactions) and removed in `after`.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })

/** The store's status selection is not what is under test: the order is admitted as the by-status backfill query admits it. */
const ADMITTED = { createAdmission: 'preauthorised-by-status-query' } as const

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/wc-first-seen-settled-outside-ims.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { importWcOrder } = await import('../../lib/connectors/woocommerce/sync/order-import')
  const { wmsCreateEligibleOrderWhere } = await import('../../lib/domain/wms/create-eligibility')
  return { db: db as Any, Prisma, importWcOrder, wmsCreateEligibleOrderWhere }
}

type Fixture = Awaited<ReturnType<typeof seed>>

async function seed(env: Awaited<ReturnType<typeof load>>, onHand = 10) {
  const { db, Prisma } = env
  const D = (v: number | string) => new Prisma.Decimal(String(v))
  const suffix = randomUUID().slice(0, 8)
  // Only this test's warehouse may be the store's default, so the import ships from it.
  const warehouse = await db.warehouse.create({ data: { code: `F92${suffix}`, name: `f92 ${suffix}`, active: true, syncToStore: true, isDefault: true }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `F92-${suffix}`, name: `f92 ${suffix}`, type: 'SIMPLE' }, select: { id: true, sku: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: D(onHand), reservedQty: D(0) } })
  await db.costLayer.create({ data: { productId: product.id, warehouseId: warehouse.id, receivedQty: D(onHand), remainingQty: D(onHand), unitCostBase: D(3), receivedAt: new Date(Date.now() - 40 * 86_400_000) } })
  const wcId = 800_000_000 + Math.floor(Math.random() * 90_000_000)
  return { suffix, warehouseId: warehouse.id as string, productId: product.id as string, sku: product.sku as string, wcId }
}

function wcOrder(fx: Fixture, status: string, qty = 2, extra: Record<string, unknown> = {}): Any {
  const stamp = '2026-11-10T10:00:00'
  return {
    id: fx.wcId, number: String(fx.wcId), status, currency: 'GBP', total: String(qty * 10), total_tax: '0', discount_total: '0', shipping_total: '0', shipping_tax: '0', cart_tax: '0', prices_include_tax: false,
    date_created_gmt: stamp, date_modified_gmt: stamp, date_paid_gmt: stamp, date_completed_gmt: null, customer_id: 0,
    billing: { first_name: 'Ada', last_name: 'Test', email: `f92-${fx.suffix}@example.invalid`, country: 'GB' }, shipping: { country: 'GB' },
    payment_method: 'bacs', payment_method_title: 'BACS',
    meta_data: [], tax_lines: [], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [],
    line_items: [{ id: fx.wcId + 1, name: 'f92', product_id: 1, variation_id: 0, quantity: qty, subtotal: String(qty * 10), subtotal_tax: '0', total: String(qty * 10), total_tax: '0', sku: fx.sku, price: 10, taxes: [], meta_data: [] }],
    ...extra,
  }
}

async function cleanup(env: Awaited<ReturnType<typeof load>>, fx: Fixture) {
  const { db } = env
  const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(fx.wcId) }, select: { orderId: true } })
  if (link) {
    const id = link.orderId as string
    // Best effort: a scratch database, and every id here is this test's own.
    await db.$executeRawUnsafe(`DELETE FROM cogs_entries WHERE movement_id IN (SELECT id FROM stock_movements WHERE product_id = '${fx.productId}')`).catch(() => {})
    await db.$executeRawUnsafe(`DELETE FROM stock_movements WHERE product_id = '${fx.productId}'`).catch(() => {})
    await db.salesOrder.delete({ where: { id } }).catch(() => {})
  }
}

test('[db] a completed first-seen order consumes on-hand, books COGS, is never a WMS candidate, and the stock push level is the reduced one (o3d-hqvrp.92)', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder, wmsCreateEligibleOrderWhere } = env
  const fx = await seed(env, 10)
  t.after(() => cleanup(env, fx))

  const result = await importWcOrder(wcOrder(fx, 'completed', 2, { date_completed_gmt: '2026-11-10T11:00:00' }), ADMITTED)
  assert.ok(result.success && result.orderId, JSON.stringify(result))
  const orderId = result.orderId as string

  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, outsideImsFulfilmentAt: true, refundStatus: true } })
  assert.equal(order.status, 'SHIPPED', 'promoted through the shipment, not written as a post-dispatch status')
  assert.ok(order.outsideImsFulfilmentAt, 'marked as settled outside IMS')

  // On-hand consumed, nothing left reserved: the level the stock push writes (quantity - reservedQty) is 8, not 10.
  const level = await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })
  assert.equal(Number(level.quantity), 8, 'on-hand went down by the despatched quantity')
  assert.equal(Number(level.reservedQty), 0, 'nothing is left reserved for goods that already left')
  assert.equal(Number(level.quantity) - Number(level.reservedQty), 8, 'the stock push level (quantity - reservedQty) is the reduced one')

  // FIFO consumed and the cost of sales posted.
  const layer = await db.costLayer.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })
  assert.equal(Number(layer.remainingQty), 8, 'the FIFO layer was consumed')
  const movements = await db.stockMovement.findMany({ where: { productId: fx.productId, type: 'SALE_DISPATCH' }, select: { id: true } })
  assert.equal(movements.length, 1, 'one SALE_DISPATCH movement')
  assert.equal(await db.cogsEntry.count({ where: { movementId: { in: movements.map((m: { id: string }) => m.id) } } }), 1, 'COGS was posted')

  // Never a warehouse create candidate, and nothing was sent.
  assert.equal(await db.wmsOrderPushLink.count({ where: { orderId } }), 0, 'no warehouse push link')
  assert.equal(await db.salesOrder.count({ where: { id: orderId, ...wmsCreateEligibleOrderWhere([fx.warehouseId]) } }), 0, 'not selected by the create predicate')
  // The fence is the column: the same order WITHOUT it would be a candidate were it still PROCESSING.
  assert.equal(await db.salesOrder.count({ where: { id: orderId, ...wmsCreateEligibleOrderWhere([fx.warehouseId]), outsideImsFulfilmentAt: undefined, status: 'SHIPPED' } }), 0)

  // Replaying the delivery is idempotent: no second consumption.
  const again = await importWcOrder(wcOrder(fx, 'completed', 2, { date_completed_gmt: '2026-11-10T11:00:00' }), ADMITTED)
  assert.equal(again.success, true, JSON.stringify(again))
  assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 8)
  assert.equal(await db.stockMovement.count({ where: { productId: fx.productId, type: 'SALE_DISPATCH' } }), 1)

  const logs = await db.activityLog.findMany({ where: { entityId: orderId, action: { startsWith: 'wc_import_first_seen' } }, select: { action: true, level: true } })
  assert.ok(logs.some((l: { action: string; level: string }) => l.action === 'wc_import_first_seen_despatched' && l.level === 'INFO'), 'logged at INFO on the order')
})

test('[db] with too little stock the first-seen completed order is NOT silently skipped: the import fails retryably, the order stays fenced, and a later delivery books it once stock exists', { skip }, async (t) => {
  const env = await load()
  const { db, Prisma, importWcOrder, wmsCreateEligibleOrderWhere } = env
  const fx = await seed(env, 0)
  t.after(() => cleanup(env, fx))

  const first = await importWcOrder(wcOrder(fx, 'completed', 3, { date_completed_gmt: '2026-11-10T11:00:00' }), ADMITTED)
  assert.equal(first.success, false, 'refused, not acknowledged')
  assert.match(String(first.error), /despatch could not be booked/)
  const orderId = first.orderId as string
  assert.ok(orderId, 'the order exists')
  const held = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, outsideImsFulfilmentAt: true } })
  assert.notEqual(held.status, 'SHIPPED')
  assert.equal(await db.salesOrder.count({ where: { id: orderId, ...wmsCreateEligibleOrderWhere([fx.warehouseId]) } }), 0, 'unshipped but still never a WMS candidate (without the fence it would be pushed to the warehouse)')

  // Stock arrives; the next delivery of the same order books the despatch.
  await db.stockLevel.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { quantity: new Prisma.Decimal('10') } })
  await db.costLayer.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { remainingQty: new Prisma.Decimal('10'), receivedQty: new Prisma.Decimal('10') } })
  // A receipt re-runs allocation for the backorder in production; here the same effect, directly.
  const { autoAllocateOrder } = await import('../../app/actions/allocation')
  const { INTERNAL_ACTION_BYPASS } = await import('../../lib/internal-action-bypass')
  await autoAllocateOrder(orderId, { internalBypassToken: INTERNAL_ACTION_BYPASS })
  const second = await importWcOrder(wcOrder(fx, 'completed', 3, { date_completed_gmt: '2026-11-10T11:00:00' }), ADMITTED)
  assert.equal(second.success, true, JSON.stringify(second))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status, 'SHIPPED')
  assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 7)
})

test('[db] a SHIPPED-mapped first-seen order is despatched the same way, and the later WooCommerce completion does not refuse it', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder } = env
  const fx = await seed(env, 10)
  t.after(async () => { await db.shoppingStatusMapping.deleteMany({ where: { connector: 'woocommerce', externalStatus: `shipped-f92-${fx.suffix}` } }); await cleanup(env, fx) })
  const slug = `shipped-f92-${fx.suffix}`
  await db.shoppingStatusMapping.create({ data: { connector: 'woocommerce', externalStatus: slug, imsStatus: 'SHIPPED' } })

  const result = await importWcOrder(wcOrder(fx, slug, 1), ADMITTED)
  assert.ok(result.success && result.orderId, JSON.stringify(result))
  const orderId = result.orderId as string
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status, 'SHIPPED')
  assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 9)

  // WooCommerce later moves the order to `completed`: the completion flow runs against the already-shipped order and succeeds, with no second consumption.
  const { processWcCompletion } = await import('../../lib/connectors/woocommerce/sync/completion-flow')
  const completion = await processWcCompletion(orderId, wcOrder(fx, 'completed', 1, { date_completed_gmt: '2026-11-10T12:00:00' }))
  assert.equal(completion.kind, 'fulfilled', JSON.stringify(completion))
  assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 9)
  assert.equal(await db.stockMovement.count({ where: { productId: fx.productId, type: 'SALE_DISPATCH' } }), 1)
})

test('[db] a refunded first-seen order is not cancelled, holds no allocation, is fenced from the warehouse, and the refund sweep records its refund', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder, wmsCreateEligibleOrderWhere } = env
  const fx = await seed(env, 10)
  t.after(() => cleanup(env, fx))

  const result = await importWcOrder(wcOrder(fx, 'refunded', 2), ADMITTED)
  assert.ok(result.success && result.orderId, JSON.stringify(result))
  const orderId = result.orderId as string
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, outsideImsFulfilmentAt: true } })
  assert.equal(order.status, 'PROCESSING', 'a status createRefund accepts (CANCELLED is refused)')
  assert.ok(order.outsideImsFulfilmentAt)
  assert.equal(await db.orderAllocation.count({ where: { orderId } }), 0, 'no allocation: no live demand')
  const level = await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })
  assert.equal(Number(level.reservedQty), 0)
  assert.equal(Number(level.quantity), 10, 'never left the warehouse, so on-hand is untouched')
  assert.equal(await db.wmsOrderPushLink.count({ where: { orderId } }), 0)
  assert.equal(await db.salesOrder.count({ where: { id: orderId, ...wmsCreateEligibleOrderWhere([fx.warehouseId]) } }), 0, 'fenced from the warehouse create pass')

  // The refund sweep's writer accepts the store's refund against it.
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync')
  const refund = {
    id: fx.wcId + 7, parent_id: fx.wcId, date_created: '2026-11-11T10:00:00', date_created_gmt: '2026-11-11T10:00:00', amount: '20.00', reason: 'f92', refunded_by: 1, refunded_payment: true, meta_data: [],
    line_items: [{ id: fx.wcId + 8, name: 'f92', product_id: 1, variation_id: 0, quantity: -2, tax_class: '', subtotal: '-20.00', subtotal_tax: '0', total: '-20.00', total_tax: '0', sku: fx.sku, meta_data: [{ key: '_refunded_item_id', value: String(fx.wcId + 1) }], refund_total: 20, taxes: [] }],
  }
  const synced = await syncWcRefund(fx.wcId, refund as Any)
  assert.ok(['applied', 'already-applied'].includes(synced.outcome), `refund recorded, got ${JSON.stringify(synced)}`)
  const after = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, refundStatus: true } })
  assert.equal(after.refundStatus, 'FULL')
  assert.notEqual(after.status, 'CANCELLED')
  assert.equal(await db.salesOrderRefund.count({ where: { orderId } }), 1)
})
