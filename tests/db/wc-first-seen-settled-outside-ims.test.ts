import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { purge } from '../helpers/purge-rows'

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
  const warehouse = await db.warehouse.create({ data: { code: `F92${suffix}`, name: `f92 ${suffix}`, active: true, syncToStore: true, isDefault: false }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `F92-${suffix}`, name: `f92 ${suffix}`, type: 'SIMPLE' }, select: { id: true, sku: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: D(onHand), reservedQty: D(0) } })
  await db.costLayer.create({ data: { productId: product.id, warehouseId: warehouse.id, receivedQty: D(onHand), remainingQty: D(onHand), unitCostBase: D(3), receivedAt: new Date(Date.now() - 40 * 86_400_000) } })
  const wcId = 800_000_000 + Math.floor(Math.random() * 90_000_000)
  return { suffix, warehouseId: warehouse.id as string, productId: product.id as string, sku: product.sku as string, wcId }
}

/** Record (or, with null, leave absent) the instant the opening stock was taken, the way the first-load apply does. Removed after the test. */
async function withCutoff(env: Awaited<ReturnType<typeof load>>, t: { after: (fn: () => Promise<void>) => void }, iso: string | null) {
  const { db } = env
  if (iso === null) return
  await db.firstLoadApplyRun.deleteMany({ where: { manifestDigest: { startsWith: 'f92-' } } })
  await db.firstLoadApplyRun.create({ data: { version: 1, manifestDigest: `f92-${randomUUID()}`, runId: `f92-${randomUUID()}`, status: 'APPLIED', facts: { openingStockCutoffAt: iso } } })
  t.after(async () => { await db.firstLoadApplyRun.deleteMany({ where: { manifestDigest: { startsWith: 'f92-' } } }) })
}

const CUTOFF = '2026-11-05T00:00:00.000Z'
const BEFORE_CUTOFF = '2026-11-01T09:00:00'
const AFTER_CUTOFF = '2026-11-10T11:00:00'

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
  const links: Array<{ orderId: string }> = await db.shoppingOrderLink.findMany({ where: { connector: 'woocommerce', externalOrderId: String(fx.wcId) }, select: { orderId: true } })
  const orderIds = links.map((row) => row.orderId)
  if (orderIds.length > 0) {
    await db.activityLog.deleteMany({ where: { entityId: { in: orderIds } } })
    await db.shoppingSyncLog.deleteMany({ where: { OR: [{ entityId: { in: orderIds } }, { externalId: String(fx.wcId) }] } })
    await purge(db, 'sales_orders', 'id', orderIds)
  }
  const customers: Array<{ id: string }> = await db.customer.findMany({ where: { email: `f92-${fx.suffix}@example.invalid` }, select: { id: true } })
  await purge(db, 'customers', 'id', customers.map((row) => row.id))
  await purge(db, 'products', 'id', [fx.productId])
  await purge(db, 'warehouses', 'id', [fx.warehouseId])
}

test('[db] a completed first-seen order consumes on-hand, books COGS, is never a WMS candidate, and the stock push level is the reduced one (o3d-hqvrp.92)', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder, wmsCreateEligibleOrderWhere } = env
  const fx = await seed(env, 10)
  t.after(() => cleanup(env, fx))
  await withCutoff(env, t, CUTOFF)

  const result = await importWcOrder(wcOrder(fx, 'completed', 2, { date_completed_gmt: AFTER_CUTOFF }), ADMITTED)
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

  // Replaying the delivery is idempotent: no second consumption.
  const again = await importWcOrder(wcOrder(fx, 'completed', 2, { date_completed_gmt: '2026-11-10T11:00:00' }), ADMITTED)
  assert.equal(again.success, true, JSON.stringify(again))
  assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 8)
  assert.equal(await db.stockMovement.count({ where: { productId: fx.productId, type: 'SALE_DISPATCH' } }), 1)

  const logs = await db.activityLog.findMany({ where: { entityId: orderId, action: { startsWith: 'wc_import_first_seen' } }, select: { action: true, level: true } })
  assert.ok(logs.some((l: { action: string; level: string }) => l.action === 'wc_import_first_seen_despatched' && l.level === 'INFO'), 'logged at INFO on the order')
})

test('[db] with no stock the first-seen completed order does NOT hold the sweep cursor: the import succeeds, the owed despatch is on the exceptions list, and the bounded retry books it once stock arrives', { skip }, async (t) => {
  const env = await load()
  const { db, Prisma, importWcOrder, wmsCreateEligibleOrderWhere } = env
  const fx = await seed(env, 0)
  t.after(() => cleanup(env, fx))
  await withCutoff(env, t, CUTOFF)
  const payload = wcOrder(fx, 'completed', 3, { date_completed_gmt: AFTER_CUTOFF })

  const first = await importWcOrder(payload, ADMITTED)
  assert.equal(first.success, true, 'acknowledged: an owed despatch must not hold the cursor')
  const orderId = first.orderId as string
  assert.ok(orderId)
  assert.notEqual((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status, 'SHIPPED')
  assert.equal(await db.salesOrder.count({ where: { id: orderId, ...wmsCreateEligibleOrderWhere([fx.warehouseId]) } }), 0, 'never a WMS candidate')
  const { openWcCompletionRefusalWhere } = await import('../../lib/domain/sales/wc-sync-row-families')
  const rows = await db.shoppingSyncLog.findMany({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId }, select: { payload: true } })
  assert.equal(rows.length, 1, 'one open Sync > Exceptions entry')
  assert.equal(rows[0].payload.refusal, 'insufficient_physical_stock')

  // Redelivery does not re-run the booking or stack rows: the retry job owns it.
  await importWcOrder(payload, ADMITTED)
  assert.equal(await db.shoppingSyncLog.count({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId } }), 1)
  assert.equal((await db.shoppingSyncLog.findFirstOrThrow({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId }, select: { payload: true } })).payload.occurrences, 1)

  // Still no stock: the retry counts an attempt and leaves it owed.
  const { retryOwedOutsideImsDespatches } = await import('../../lib/connectors/woocommerce/sync/outside-ims-despatch')
  const live = async () => ({ order: payload })
  const stillNone = await retryOwedOutsideImsDespatches(20, live)
  assert.equal(stillNone.stillOwed >= 1, true, JSON.stringify(stillNone))

  // Stock arrives: the next pass books it.
  await db.stockLevel.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { quantity: new Prisma.Decimal('10') } })
  await db.costLayer.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { remainingQty: new Prisma.Decimal('10'), receivedQty: new Prisma.Decimal('10') } })
  const booked = await retryOwedOutsideImsDespatches(20, live)
  assert.equal(booked.booked >= 1, true, JSON.stringify(booked))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status, 'SHIPPED')
  assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 7)
  assert.equal(await db.shoppingSyncLog.count({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId } }), 0, 'the exceptions entry closed itself')
})

test('[db] an owed despatch that never gets stock ends in a visible terminal state after the attempt cap', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder } = env
  const fx = await seed(env, 0)
  t.after(() => cleanup(env, fx))
  await withCutoff(env, t, CUTOFF)
  const payload = wcOrder(fx, 'completed', 1, { date_completed_gmt: AFTER_CUTOFF })
  const first = await importWcOrder(payload, ADMITTED)
  const orderId = first.orderId as string
  const { openWcCompletionRefusalWhere } = await import('../../lib/domain/sales/wc-sync-row-families')
  const { retryOwedOutsideImsDespatches, OUTSIDE_IMS_DESPATCH_MAX_ATTEMPTS } = await import('../../lib/connectors/woocommerce/sync/outside-ims-despatch')
  const row = await db.shoppingSyncLog.findFirstOrThrow({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId }, select: { id: true, payload: true } })
  await db.shoppingSyncLog.update({ where: { id: row.id }, data: { payload: { ...row.payload, occurrences: OUTSIDE_IMS_DESPATCH_MAX_ATTEMPTS } } })
  const out = await retryOwedOutsideImsDespatches(20, async () => ({ order: payload }))
  assert.equal(out.terminal >= 1, true, JSON.stringify(out))
  const after = await db.shoppingSyncLog.findFirstOrThrow({ where: { id: row.id }, select: { payload: true, errorMessage: true } })
  assert.equal(after.payload.terminal, true)
  assert.match(after.errorMessage, /Gave up retrying/)
  // No longer retried.
  const again = await retryOwedOutsideImsDespatches(20, async () => ({ order: payload }))
  assert.equal(again.scanned, 0)
})

test('[db] a completed order dated BEFORE the opening-stock instant has no stock effect; one with no instant on record has none either (fail closed)', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder, wmsCreateEligibleOrderWhere } = env
  for (const scenario of [{ name: 'before the instant', cutoff: CUTOFF as string | null, completed: BEFORE_CUTOFF }, { name: 'no instant recorded', cutoff: null, completed: AFTER_CUTOFF }]) {
    const fx = await seed(env, 10)
    const cleanupLater = () => cleanup(env, fx)
    try {
      const cut = await db.firstLoadApplyRun.count()
      assert.equal(cut, 0, 'precondition: no run record')
      if (scenario.cutoff) await db.firstLoadApplyRun.create({ data: { version: 1, manifestDigest: `f92-${randomUUID()}`, runId: `f92-${randomUUID()}`, status: 'APPLIED', facts: { openingStockCutoffAt: scenario.cutoff } } })
      const result = await importWcOrder(wcOrder(fx, 'completed', 2, { date_completed_gmt: scenario.completed, date_paid_gmt: scenario.completed, date_created_gmt: scenario.completed }), ADMITTED)
      assert.ok(result.success && result.orderId, `${scenario.name}: ${JSON.stringify(result)}`)
      const orderId = result.orderId as string
      const order = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, outsideImsFulfilmentAt: true } })
      assert.equal(order.status, 'COMPLETED', `${scenario.name}: recorded with its own status`)
      assert.ok(order.outsideImsFulfilmentAt)
      const level = await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })
      assert.equal(Number(level.quantity), 10, `${scenario.name}: on-hand untouched`)
      assert.equal(Number(level.reservedQty), 0, `${scenario.name}: nothing reserved`)
      assert.equal(await db.orderAllocation.count({ where: { orderId } }), 0)
      assert.equal(await db.stockMovement.count({ where: { productId: fx.productId } }), 0, `${scenario.name}: no movement`)
      assert.equal(await db.shipment.count({ where: { orderId } }), 0)
      assert.equal(Number((await db.costLayer.findFirstOrThrow({ where: { productId: fx.productId } })).remainingQty), 10, `${scenario.name}: FIFO untouched`)
      assert.equal(await db.salesOrder.count({ where: { id: orderId, ...wmsCreateEligibleOrderWhere([fx.warehouseId]) } }), 0)
      // And a replay does not consume either.
      await importWcOrder(wcOrder(fx, 'completed', 2, { date_completed_gmt: scenario.completed, date_paid_gmt: scenario.completed, date_created_gmt: scenario.completed }), ADMITTED)
      assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 10)
    } finally {
      await cleanupLater()
      await db.firstLoadApplyRun.deleteMany({ where: { manifestDigest: { startsWith: 'f92-' } } })
    }
  }
  void t
})

test('[db] the reallocation sweep and the backorder allocator never select an order settled outside IMS (refunded, historical or awaiting its booking)', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder } = env
  const fx = await seed(env, 10)
  t.after(() => cleanup(env, fx))
  const result = await importWcOrder(wcOrder(fx, 'refunded', 2), ADMITTED)
  const orderId = result.orderId as string
  const { REALLOCATION_SWEEP_SELECTION } = await import('../../lib/fulfillment/reallocation-sweep-selection')
  assert.equal(await db.salesOrder.count({ where: { id: orderId, ...REALLOCATION_SWEEP_SELECTION } }), 0, 'not selected by the reallocation sweep')
  // CONTROL: the same order without the marker is selected, so the exclusion is what the test measures.
  await db.salesOrder.update({ where: { id: orderId }, data: { outsideImsFulfilmentAt: null } })
  assert.equal(await db.salesOrder.count({ where: { id: orderId, ...REALLOCATION_SWEEP_SELECTION } }), 1, 'CONTROL: selected without the marker')
  await db.salesOrder.update({ where: { id: orderId }, data: { outsideImsFulfilmentAt: new Date() } })
  // The backorder allocator: replenishing the product allocates nothing to it.
  const { allocateBackordersForProducts } = await import('../../lib/fulfillment/backorder-allocator')
  await allocateBackordersForProducts([fx.productId], { source: 'purchase_receipt' })
  assert.equal(await db.orderAllocation.count({ where: { orderId } }), 0, 'the backorder allocator left it alone')
  // CONTROL: without the marker the allocator does allocate it.
  await db.salesOrder.update({ where: { id: orderId }, data: { outsideImsFulfilmentAt: null } })
  await allocateBackordersForProducts([fx.productId], { source: 'purchase_receipt' })
  assert.ok(await db.orderAllocation.count({ where: { orderId } }) > 0, 'CONTROL: allocated without the marker')
})

test('[db] partial stock is owed, not permanent: the reservation is released, the row stays retryable, and a first partial receipt does not abandon the order', { skip }, async (t) => {
  const env = await load()
  const { db, Prisma, importWcOrder } = env
  const fx = await seed(env, 1)
  t.after(() => cleanup(env, fx))
  await withCutoff(env, t, CUTOFF)
  const payload = wcOrder(fx, 'completed', 3, { date_completed_gmt: AFTER_CUTOFF })
  const result = await importWcOrder(payload, ADMITTED)
  assert.equal(result.success, true, JSON.stringify(result))
  const orderId = result.orderId as string
  assert.equal(await db.orderAllocation.count({ where: { orderId } }), 0, 'no allocation left')
  assert.equal(await db.shipment.count({ where: { orderId } }), 0, 'no pending shipment left')
  const level = async () => db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })
  assert.equal(Number((await level()).reservedQty), 0, 'nothing reserved for goods that already left')
  assert.equal(Number((await level()).quantity), 1, 'on-hand untouched')
  const { openWcCompletionRefusalWhere } = await import('../../lib/domain/sales/wc-sync-row-families')
  const row = await db.shoppingSyncLog.findFirstOrThrow({ where: { ...openWcCompletionRefusalWhere(), entityId: orderId }, select: { payload: true } })
  assert.equal(row.payload.refusal, 'insufficient_physical_stock', 'owed (retryable), not a permanent coverage refusal')
  const { retryOwedOutsideImsDespatches } = await import('../../lib/connectors/woocommerce/sync/outside-ims-despatch')
  const live = async () => ({ order: payload })
  // A first PARTIAL receipt (2 of 3 units): still owed.
  await db.stockLevel.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { quantity: new Prisma.Decimal('2') } })
  await db.costLayer.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { remainingQty: new Prisma.Decimal('2'), receivedQty: new Prisma.Decimal('2') } })
  const partial = await retryOwedOutsideImsDespatches(20, live)
  assert.equal(partial.stillOwed >= 1, true, JSON.stringify(partial))
  assert.equal(Number((await level()).reservedQty), 0)
  // Full stock: booked.
  await db.stockLevel.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { quantity: new Prisma.Decimal('10') } })
  await db.costLayer.updateMany({ where: { productId: fx.productId, warehouseId: fx.warehouseId }, data: { remainingQty: new Prisma.Decimal('10'), receivedQty: new Prisma.Decimal('10') } })
  const full = await retryOwedOutsideImsDespatches(20, live)
  assert.equal(full.booked >= 1, true, JSON.stringify(full))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status, 'SHIPPED')
  assert.equal(Number((await level()).quantity), 7)
})

test('[db] terminal and unrelated open rows never starve a newer owed despatch; a store order that is no longer a despatch is closed, not booked', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder } = env
  const first = await seed(env, 0)
  t.after(() => cleanup(env, first))
  await withCutoff(env, t, CUTOFF)
  const p1 = wcOrder(first, 'completed', 1, { date_completed_gmt: AFTER_CUTOFF })
  const r1 = await importWcOrder(p1, ADMITTED)
  const { openWcCompletionRefusalWhere } = await import('../../lib/domain/sales/wc-sync-row-families')
  const row1 = await db.shoppingSyncLog.findFirstOrThrow({ where: { ...openWcCompletionRefusalWhere(), entityId: r1.orderId as string }, select: { id: true, payload: true } })
  await db.shoppingSyncLog.update({ where: { id: row1.id }, data: { payload: { ...row1.payload, terminal: true } } })
  const second = await seed(env, 0)
  t.after(() => cleanup(env, second))
  const p2 = wcOrder(second, 'completed', 1, { date_completed_gmt: AFTER_CUTOFF })
  const r2 = await importWcOrder(p2, ADMITTED)
  const { retryOwedOutsideImsDespatches } = await import('../../lib/connectors/woocommerce/sync/outside-ims-despatch')
  const seen: string[] = []
  const out = await retryOwedOutsideImsDespatches(1, async (id) => { seen.push(id); return { order: id === String(second.wcId) ? { ...p2, status: 'processing', date_completed_gmt: null } : p1 } })
  assert.deepEqual(seen, [String(second.wcId)], 'the newer owed row is reached although a terminal row is older')
  assert.equal(out.resolved, 1, JSON.stringify(out))
  assert.equal(await db.shoppingSyncLog.count({ where: { ...openWcCompletionRefusalWhere(), entityId: r2.orderId as string } }), 0, 'closed without booking')
  assert.equal(await db.stockMovement.count({ where: { productId: second.productId } }), 0)
})

test('[db] an order completed between the stock extract and the apply consumes stock; the reader fails on a read error or a malformed instant and is null only when absent', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder } = env
  const fx = await seed(env, 10)
  t.after(() => cleanup(env, fx))
  // Extract two days ago, apply an hour ago: the order was completed yesterday, between the two.
  const extracted = new Date(Date.now() - 2 * 86_400_000)
  await withCutoff(env, t, extracted.toISOString())
  const completed = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, '')
  const result = await importWcOrder(wcOrder(fx, 'completed', 2, { date_completed_gmt: completed, date_paid_gmt: completed, date_created_gmt: completed }), ADMITTED)
  assert.ok(result.success && result.orderId, JSON.stringify(result))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: result.orderId as string }, select: { status: true } })).status, 'SHIPPED')
  assert.equal(Number((await db.stockLevel.findFirstOrThrow({ where: { productId: fx.productId, warehouseId: fx.warehouseId } })).quantity), 8)

  const { readOpeningStockCutoff } = await import('../../lib/connectors/woocommerce/sync/opening-stock-cutoff')
  assert.equal((await readOpeningStockCutoff())?.toISOString(), extracted.toISOString())
  await db.firstLoadApplyRun.updateMany({ where: { manifestDigest: { startsWith: 'f92-' } }, data: { facts: { openingStockCutoffAt: 'not a date' } } })
  await assert.rejects(readOpeningStockCutoff(), /not a readable date/)
  await db.firstLoadApplyRun.updateMany({ where: { manifestDigest: { startsWith: 'f92-' } }, data: { facts: {} } })
  assert.equal(await readOpeningStockCutoff(), null, 'absent: null')
})

test('[db] a SHIPPED-mapped first-seen order is despatched the same way, and the later WooCommerce completion does not refuse it', { skip }, async (t) => {
  const env = await load()
  const { db, importWcOrder } = env
  const fx = await seed(env, 10)
  t.after(async () => { await db.shoppingStatusMapping.deleteMany({ where: { connector: 'woocommerce', externalStatus: `shipped-f92-${fx.suffix}` } }); await cleanup(env, fx) })
  const slug = `shipped-f92-${fx.suffix}`
  await withCutoff(env, t, CUTOFF)
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
