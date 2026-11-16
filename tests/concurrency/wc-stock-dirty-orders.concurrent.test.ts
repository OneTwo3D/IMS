import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * The WooCommerce stock guard's dirty-order record against a real Postgres (o3d-hqvrp.385):
 *   - a release of an allocated, Woo-linked order records the WooCommerce order id in the same transaction;
 *   - a delete captures that id BEFORE the order and its link disappear, and the record survives the delete;
 *   - a release during a guard run replaces the token, so the guard's compare-and-set clear does not remove it;
 *   - a reservation, or an order with no WooCommerce link, records nothing.
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, allocation, dirtyModule] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
    import('@/lib/domain/sales/allocation-service'),
    import('@/lib/connectors/woocommerce/sync/stock-dirty-orders'),
  ])
  const poolConfig = { connectionString: databaseUrl, max: 4 }
  const pool = new pg.Pool(poolConfig)
  const db = new PrismaClient({ adapter: new PrismaPg(poolConfig) })
  return { Prisma, db, pool, ...allocation, ...dirtyModule }
}
type Rig = Awaited<ReturnType<typeof openRig>>

async function seed(rig: Rig, suffix: string, woo: boolean) {
  const { Prisma, db } = rig
  const D = (v: string) => new Prisma.Decimal(v)
  const product = await db.product.create({ data: { sku: `DO-${suffix}`, name: `dirty ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const wh = await db.warehouse.create({ data: { code: `D${suffix.slice(0, 8)}`, name: `dirty ${suffix}` }, select: { id: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `DO-${suffix.slice(0, 8)}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D('100'), totalForeign: D('100'), subtotalBase: D('100'), taxBase: D('0'), totalBase: D('100'),
      lines: { create: [{ productId: product.id, description: 'l', qty: D('5'), unitPriceForeign: D('20'), unitPriceBase: D('20'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('100'), totalBase: D('100') }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  const wcOrderId = `9${Math.floor(Math.random() * 1e9)}`
  if (woo) await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: wcOrderId } })
  await db.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: wh.id, qty: D('5') } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: wh.id, quantity: D('9'), reservedQty: D('5') } })
  return { productId: product.id, whId: wh.id, orderId: order.id, lineId, wcOrderId }
}

async function cleanup(rig: Rig, fx: Awaited<ReturnType<typeof seed>> | undefined) {
  if (!fx) return
  const { db } = rig
  await db.wcStockDirtyOrder.deleteMany({ where: { wcOrderId: fx.wcOrderId } }).catch(() => {})
  await db.shoppingOrderLink.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.orderAllocation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrder.delete({ where: { id: fx.orderId } }).catch(() => {})
  await db.stockLevel.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
  await db.warehouse.delete({ where: { id: fx.whId } }).catch(() => {})
  await db.product.delete({ where: { id: fx.productId } }).catch(() => {})
}

async function withVersion(rig: Rig, version: string, fn: () => Promise<void>) {
  const before = await rig.db.setting.findUnique({ where: { key: 'wc_settings_version' } })
  await rig.db.setting.upsert({ where: { key: 'wc_settings_version' }, create: { key: 'wc_settings_version', value: version }, update: { value: version } })
  try { await fn() } finally {
    if (before) await rig.db.setting.update({ where: { key: 'wc_settings_version' }, data: { value: before.value } })
    else await rig.db.setting.delete({ where: { key: 'wc_settings_version' } }).catch(() => {})
  }
}

const suffix = () => randomUUID().replace(/-/g, '').slice(0, 12)

test('a release of a Woo-linked order records it in the same transaction; a re-release replaces the token, so a clear on the old token loses nothing', { skip }, async () => {
  const rig = await openRig()
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix(), true)
    const seeded = fx
    await rig.db.$transaction(async (tx) => {
      await rig.releaseOrderAllocationsInTx(tx, seeded.orderId, { cause: 'test' })
    })
    const first = await rig.db.wcStockDirtyOrder.findUnique({ where: { wcOrderId: fx.wcOrderId } })
    assert.ok(first, 'recorded with the WooCommerce order id')
    assert.equal(first.orderId, fx.orderId)
    // The guard read the entry (token A) and is mid-run; another release lands and replaces the token.
    await rig.db.$transaction(async (tx) => { await rig.markWcOrderDirtyForStockGuard(tx, seeded.orderId) })
    const cleared = await rig.db.wcStockDirtyOrder.deleteMany({ where: { wcOrderId: fx.wcOrderId, token: first.token } })
    assert.equal(cleared.count, 0, 'a release during the run is not lost')
    const second = await rig.db.wcStockDirtyOrder.findUnique({ where: { wcOrderId: fx.wcOrderId } })
    assert.notEqual(second?.token, first.token)
    assert.equal((await rig.db.wcStockDirtyOrder.deleteMany({ where: { wcOrderId: fx.wcOrderId, token: second!.token } })).count, 1, 'an untouched entry clears')
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('a delete captures the WooCommerce order id before the link goes, and the record survives the order', { skip }, async () => {
  const rig = await openRig()
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix(), true)
    const seeded = fx
    await rig.db.$transaction(async (tx) => {
      await rig.markWcOrderDirtyForStockGuard(tx, seeded.orderId)
      await rig.releaseOrderAllocationsInTx(tx, seeded.orderId, { cause: 'deleting the sales order', orderIsBeingDeleted: true })
      await tx.salesOrderLine.deleteMany({ where: { orderId: seeded.orderId } })
      await tx.salesOrder.delete({ where: { id: seeded.orderId } })
    })
    assert.equal(await rig.db.salesOrder.count({ where: { id: fx.orderId } }), 0)
    assert.equal(await rig.db.shoppingOrderLink.count({ where: { orderId: fx.orderId } }), 0, 'the link went with the order')
    const row = await rig.db.wcStockDirtyOrder.findUnique({ where: { wcOrderId: fx.wcOrderId } })
    assert.ok(row, 'the captured WooCommerce id is still there to re-check')
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('a reservation, an order with no WooCommerce link, and a zero release record nothing', { skip }, async () => {
  const rig = await openRig()
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  let plain: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix(), true)
    plain = await seed(rig, suffix(), false)
    const a = fx
    const b = plain
    await rig.db.$transaction(async (tx) => {
      await rig.applyAllocationReservationDelta(tx, [{ productId: a.productId, warehouseId: a.whId, qty: 1 }], 'reserve')
      await rig.applyAllocationReservationDelta(tx, [{ productId: a.productId, warehouseId: a.whId, qty: 0 }], 'release', a.orderId)
      await rig.applyAllocationReservationDelta(tx, [{ productId: b.productId, warehouseId: b.whId, qty: 2 }], 'release', b.orderId)
    })
    assert.equal(await rig.db.wcStockDirtyOrder.count({ where: { orderId: { in: [a.orderId, b.orderId] } } }), 0)
  } finally {
    await cleanup(rig, fx)
    await cleanup(rig, plain)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('entries are bound to the connection generation: a rebind retires the old rows, an old-generation run cannot write, and a reused id is not charged', { skip }, async () => {
  const rig = await openRig()
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix(), true)
    const seeded = fx
    await withVersion(rig, '7', async () => {
      await rig.db.$transaction(async (tx) => { await rig.markWcOrderDirtyForStockGuard(tx, seeded.orderId) })
      const row = await rig.db.wcStockDirtyOrder.findUnique({ where: { wcOrderId: seeded.wcOrderId } })
      assert.equal(row?.syncVersion, '7', 'bound to the generation it was written under')
      const snap = [{ wcOrderId: seeded.wcOrderId, status: 'completed', lines: [{ productId: 1, variationId: 0, sku: 'X', quantity: 2 }] }]
      const tokenOf = new Map([[seeded.wcOrderId, row!.token]])
      // an in-flight run of generation 6 (the old store) cannot write: its compare-and-set includes the generation
      assert.equal(await rig.commitDirtyOrderOutcome(rig.db as never, '6', { tokenOf, settled: [seeded.wcOrderId], refreshed: snap }), false)
      assert.ok(await rig.db.wcStockDirtyOrder.findUnique({ where: { wcOrderId: seeded.wcOrderId } }), 'not cleared by the old run')
      // the current generation's run: a snapshot is written, then read back for the guard
      assert.equal(await rig.commitDirtyOrderOutcome(rig.db as never, '7', { tokenOf, settled: [], refreshed: snap }), true)
      const [loaded] = await rig.loadDirtyOrdersForGuard(rig.db as never, '7')
      assert.deepEqual(rig.parseDirtySnapshot(loaded!.lines, loaded!.lineStatus)?.lines, snap[0]!.lines)
      // a stale token (a release during the run) is neither cleared nor overwritten
      assert.equal(await rig.commitDirtyOrderOutcome(rig.db as never, '7', { tokenOf: new Map([[seeded.wcOrderId, 'stale']]), settled: [seeded.wcOrderId], refreshed: [] }), true)
      assert.ok(await rig.db.wcStockDirtyOrder.findUnique({ where: { wcOrderId: seeded.wcOrderId } }))
    })
    // REBIND: the generation moves to 8 (the rebind transaction deletes the rows; here a row of 7 is left behind as a racing release could)
    await withVersion(rig, '8', async () => {
      assert.deepEqual(await rig.loadDirtyOrdersForGuard(rig.db as never, '8'), [], 'the old generation\'s rows are ignored, so positives are not held by them')
      // the same numeric id on the NEW store: re-bound by the new release, with the old snapshot dropped, never charged as the old order
      await rig.db.$transaction(async (tx) => { await rig.markWcOrderDirtyForStockGuard(tx, seeded.orderId) })
      const [rebound] = await rig.loadDirtyOrdersForGuard(rig.db as never, '8')
      assert.equal(rebound?.wcOrderId, seeded.wcOrderId)
      assert.equal(rebound?.lines, null)
      assert.equal(rebound?.checkedAt, null)
      // and an old-run commit leaves nothing but the current generation
      await rig.db.wcStockDirtyOrder.create({ data: { wcOrderId: `stale-${seeded.wcOrderId}`, orderId: 'x', token: 't', syncVersion: '7' } })
      assert.equal(await rig.commitDirtyOrderOutcome(rig.db as never, '8', { tokenOf: new Map(), settled: [], refreshed: [] }), true)
      assert.equal(await rig.db.wcStockDirtyOrder.count({ where: { wcOrderId: `stale-${seeded.wcOrderId}` } }), 0, 'leftovers of an older generation are retired')
    })
  } finally {
    await rig.db.wcStockDirtyOrder.deleteMany({ where: { wcOrderId: { startsWith: 'stale-' } } }).catch(() => {})
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('a product-id cache reset re-binds the entries to the new generation with their snapshots; an in-flight write from before it is refused', { skip }, async () => {
  const rig = await openRig()
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix(), true)
    const seeded = fx
    await withVersion(rig, '20', async () => {
      await rig.db.$transaction(async (tx) => { await rig.markWcOrderDirtyForStockGuard(tx, seeded.orderId) })
      const row = await rig.db.wcStockDirtyOrder.findUnique({ where: { wcOrderId: seeded.wcOrderId } })
      const snap = [{ wcOrderId: seeded.wcOrderId, status: 'completed', lines: [{ productId: 1, variationId: 0, sku: 'X', quantity: 2 }] }]
      assert.equal(await rig.commitDirtyOrderOutcome(rig.db as never, '20', { tokenOf: new Map([[seeded.wcOrderId, row!.token]]), settled: [], refreshed: snap }), true)
      // the reset transaction, as resetWcProductIdCache runs it: bump under the lock, re-bind the entries
      await rig.db.$transaction(async (tx) => {
        await tx.setting.update({ where: { key: 'wc_settings_version' }, data: { value: '21' } })
        await tx.wcStockDirtyOrder.updateMany({ data: { syncVersion: '21' } })
      })
      // a run that began under generation 20 writes nothing afterwards
      assert.equal(await rig.commitDirtyOrderOutcome(rig.db as never, '20', { tokenOf: new Map([[seeded.wcOrderId, row!.token]]), settled: [seeded.wcOrderId], refreshed: [] }), false)
      assert.deepEqual(await rig.loadDirtyOrdersForGuard(rig.db as never, '20'), [])
      // the guard on the new generation still has the order, with its snapshot: it is charged although the order-sync cursors are intact
      const [kept] = await rig.loadDirtyOrdersForGuard(rig.db as never, '21')
      assert.equal(kept?.wcOrderId, seeded.wcOrderId)
      assert.deepEqual(rig.parseDirtySnapshot(kept!.lines, kept!.lineStatus)?.lines, snap[0]!.lines)
    })
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})
