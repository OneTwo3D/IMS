import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * MIXED-WAREHOUSE SCOPE AGAINST A REAL DATABASE: the scope loader over real order, line, allocation and shipment rows (kits included), the dirty marker, the
 * scope record (version, snapshot lines, dirty-compare-and-clear), and the queries that keep a settled link out of the polling, hold and cancel passes and
 * put a dirty link into the amend pass only while the feature is on. No network: nothing here talks to a warehouse.
 *
 * Committing, with its own cleanup, so it lives in the SERIAL concurrency tier. GATED on RUN_DB_CONCURRENCY_TESTS (npm run test:concurrency).
 */
const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, loader, record, dirty, pushSweep, dispatchSweep] = await Promise.all([
    import('../../lib/db'),
    import('../../lib/domain/wms/mixed-scope-loader'),
    import('../../lib/domain/wms/mixed-scope-record'),
    import('../../lib/domain/wms/scope-dirty'),
    import('../../lib/domain/wms/order-push-sweep'),
    import('../../lib/domain/wms/dispatch-sweep'),
  ])
  return { db, loader, record, dirty, pushSweep, dispatchSweep }
}
type Deps = Awaited<ReturnType<typeof setup>>
const D = (value: string | number) => new Prisma.Decimal(String(value))

type Fixture = { orderId: string; linkId: string; wmsId: string; ownId: string; lineA: string; lineKit: string; productIds: string[]; warehouseIds: string[]; connector: string }

/** An order of: line A (2 x £10 net, £2 VAT each... line VAT £4), a kit of 2 (components K1 x1, K2 x2 per unit), allocated across a WMS and an own warehouse. */
async function seed(d: Deps): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8)
  const { db } = d
  const a = await db.product.create({ data: { sku: `MS-A-${suffix}`, name: 'A', type: 'SIMPLE' }, select: { id: true } })
  const k1 = await db.product.create({ data: { sku: `MS-K1-${suffix}`, name: 'K1', type: 'SIMPLE' }, select: { id: true } })
  const k2 = await db.product.create({ data: { sku: `MS-K2-${suffix}`, name: 'K2', type: 'SIMPLE' }, select: { id: true } })
  const kit = await db.product.create({ data: { sku: `MS-KIT-${suffix}`, name: 'Kit', type: 'KIT' }, select: { id: true } })
  await db.productComponent.createMany({ data: [{ productId: kit.id, componentId: k1.id, qty: D(1) }, { productId: kit.id, componentId: k2.id, qty: D(2) }] })
  const wms = await db.warehouse.create({ data: { code: `MW${suffix}`, name: `ms wms ${suffix}` }, select: { id: true } })
  const own = await db.warehouse.create({ data: { code: `MO${suffix}`, name: `ms own ${suffix}` }, select: { id: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `MS-${suffix}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: D(1), shipFromWarehouseId: wms.id,
      subtotalForeign: D(40), taxForeign: D(9), shippingForeign: D(5), discountAmount: D(3), totalForeign: D(51), subtotalBase: D(40), taxBase: D(9), totalBase: D(51),
      lines: {
        create: [
          { productId: a.id, sku: `MS-A-${suffix}`, description: 'A', qty: D(2), unitPriceForeign: D(10), unitPriceBase: D(10), taxForeign: D(4), taxBase: D(4), totalForeign: D(20), totalBase: D(20) },
          { productId: kit.id, sku: `MS-KIT-${suffix}`, description: 'Kit', qty: D(2), unitPriceForeign: D(10), unitPriceBase: D(10), taxForeign: D(4), taxBase: D(4), totalForeign: D(20), totalBase: D(20) },
        ],
      },
    },
    select: { id: true, lines: { select: { id: true, sku: true }, orderBy: { sku: 'asc' } } },
  })
  const lineA = order.lines.find((line) => line.sku?.startsWith('MS-A-'))!.id
  const lineKit = order.lines.find((line) => line.sku?.startsWith('MS-KIT-'))!.id
  // A: 1 in the WMS warehouse, 1 in the own warehouse. Kit: 1 whole unit in each (K1 x1, K2 x2 per unit).
  await db.orderAllocation.createMany({
    data: [
      { orderId: order.id, lineId: lineA, productId: a.id, warehouseId: wms.id, qty: D(1) },
      { orderId: order.id, lineId: lineA, productId: a.id, warehouseId: own.id, qty: D(1) },
      { orderId: order.id, lineId: lineKit, productId: k1.id, warehouseId: wms.id, qty: D(1) },
      { orderId: order.id, lineId: lineKit, productId: k2.id, warehouseId: wms.id, qty: D(2) },
      { orderId: order.id, lineId: lineKit, productId: k1.id, warehouseId: own.id, qty: D(1) },
      { orderId: order.id, lineId: lineKit, productId: k2.id, warehouseId: own.id, qty: D(2) },
    ],
  })
  const connector = `ms-test-${suffix}`
  const link = await db.wmsOrderPushLink.create({
    data: { orderId: order.id, connector, state: 'SYNCED', externalOrderId: `W-${suffix}`, externalOrderNumber: `MS-${suffix}`, pushedAt: new Date(Date.now() - 3_600_000), pushWarehouseId: wms.id },
    select: { id: true },
  })
  return { orderId: order.id, linkId: link.id, wmsId: wms.id, ownId: own.id, lineA, lineKit, productIds: [a.id, k1.id, k2.id, kit.id], warehouseIds: [wms.id, own.id], connector }
}

async function clean(d: Deps, fx: Fixture) {
  const { db } = d
  await db.setting.deleteMany({ where: { key: 'wms_mixed_warehouse_push_enabled' } }).catch(() => {})
  await db.wmsOrderPushLink.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.shipmentLine.deleteMany({ where: { shipment: { orderId: fx.orderId } } }).catch(() => {})
  await db.shipment.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.orderAllocation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrder.delete({ where: { id: fx.orderId } }).catch(() => {})
  await db.productComponent.deleteMany({ where: { productId: { in: fx.productIds } } }).catch(() => {})
  await db.product.deleteMany({ where: { id: { in: fx.productIds } } }).catch(() => {})
  await db.warehouse.deleteMany({ where: { id: { in: fx.warehouseIds } } }).catch(() => {})
}

test('the scope loader reads real rows: the WMS part, a kit in whole units, money apportioned in pence (shipping with the first part to ship)', { skip }, async () => {
  const d = await setup()
  const fx = await seed(d)
  try {
    const scope = await d.loader.loadMixedScopeForOrder(d.db, fx.orderId, fx.wmsId)
    assert.equal(scope?.mode, 'MIXED')
    if (scope?.mode !== 'MIXED') return
    assert.deepEqual(scope.lines.map((line) => [line.lineId, line.quantity]).sort(), [[fx.lineA, 1], [fx.lineKit, 1]].sort())
    assert.equal(scope.shippingCarried, true)
    assert.equal(scope.shippingMinor, 500)
    // discount £3 over equal halves of £40: 150p each (the WMS part is index 0)
    assert.equal(scope.discountMinor, 150)
    // goods VAT: half of (400 + 400) = 400, plus the residual (900 - 800 = 100) because shipping is carried
    assert.equal(scope.vatMinor, 500)
    // The own warehouse ships first: the WMS part carries no shipping, and no residual VAT
    const shipment = await d.db.shipment.create({ data: { orderId: fx.orderId, warehouseId: fx.ownId, status: 'SHIPPED', shippedAt: new Date() }, select: { id: true } })
    void shipment
    const after = await d.loader.loadMixedScopeForOrder(d.db, fx.orderId, fx.wmsId)
    assert.equal(after?.mode === 'MIXED' && after.shippingMinor, 0)
    assert.equal(after?.mode === 'MIXED' && after.vatMinor, 400)
  } finally { await clean(d, fx) }
})

test('a kit allocated across warehouses inside one unit is refused; an unallocated unit holds', { skip }, async () => {
  const d = await setup()
  const fx = await seed(d)
  try {
    // Rebuild the kit allocation as a split unit: all K1 in the WMS warehouse, all K2 in the own warehouse.
    await d.db.orderAllocation.deleteMany({ where: { orderId: fx.orderId, lineId: fx.lineKit } })
    const [k1, k2] = fx.productIds.slice(1, 3)
    await d.db.orderAllocation.createMany({ data: [
      { orderId: fx.orderId, lineId: fx.lineKit, productId: k1, warehouseId: fx.wmsId, qty: D(2) },
      { orderId: fx.orderId, lineId: fx.lineKit, productId: k2, warehouseId: fx.ownId, qty: D(4) },
    ] })
    const split = await d.loader.loadMixedScopeForOrder(d.db, fx.orderId, fx.wmsId)
    assert.equal(split?.mode, 'REFUSED')
    await d.db.orderAllocation.deleteMany({ where: { orderId: fx.orderId, lineId: fx.lineKit } })
    const hold = await d.loader.loadMixedScopeForOrder(d.db, fx.orderId, fx.wmsId)
    assert.equal(hold?.mode, 'HOLD')
  } finally { await clean(d, fx) }
})

test('a single-warehouse order has the FULL scope (no part is cut)', { skip }, async () => {
  const d = await setup()
  const fx = await seed(d)
  try {
    await d.db.orderAllocation.deleteMany({ where: { orderId: fx.orderId, warehouseId: fx.ownId } })
    assert.deepEqual(await d.loader.loadMixedScopeForOrder(d.db, fx.orderId, fx.wmsId), { mode: 'FULL' })
  } finally { await clean(d, fx) }
})

test('markWmsScopeDirtyInTx flags the order\'s link; recordMixedScopeOutcome versions the scope and clears only a mark set before the read', { skip }, async () => {
  const d = await setup()
  const fx = await seed(d)
  try {
    await d.db.$transaction((tx) => d.dirty.markWmsScopeDirtyInTx(tx, fx.orderId))
    const marked = await d.db.wmsOrderPushLink.findUnique({ where: { id: fx.linkId }, select: { scopeDirtyAt: true } })
    assert.ok(marked?.scopeDirtyAt)
    const scope = await d.loader.loadMixedScopeForOrder(d.db, fx.orderId, fx.wmsId)
    assert.equal(scope?.mode, 'MIXED')
    if (!scope) return
    // A mark made AFTER the read stays dirty.
    const readAt = new Date(Date.now() - 60_000)
    await d.record.recordMixedScopeOutcome(d.db, fx.orderId, scope, readAt)
    assert.ok((await d.db.wmsOrderPushLink.findUnique({ where: { id: fx.linkId }, select: { scopeDirtyAt: true } }))?.scopeDirtyAt, 'a change made after the scope was read is not lost')
    await d.record.recordMixedScopeOutcome(d.db, fx.orderId, scope, new Date())
    const link = await d.db.wmsOrderPushLink.findUnique({ where: { id: fx.linkId }, select: { scopeDirtyAt: true, scopeMode: true, scopeVersion: true, scopeHash: true, scopeShippingMinor: true } })
    assert.equal(link?.scopeDirtyAt, null)
    assert.equal(link?.scopeMode, 'MIXED')
    assert.equal(link?.scopeVersion, 1, 'the first record is version 1, the second identical one did not bump it')
    assert.equal(link?.scopeShippingMinor, 500)
    const lines = await d.db.wmsOrderPushScopeLine.findMany({ where: { linkId: fx.linkId }, orderBy: { sku: 'asc' } })
    assert.equal(lines.length, 2)
    assert.ok(lines.every((line) => line.scopeVersion === 1 && Number(line.quantity) === 1))
    // A different part is the next version.
    await d.db.orderAllocation.deleteMany({ where: { orderId: fx.orderId, lineId: fx.lineA } })
    await d.db.orderAllocation.create({ data: { orderId: fx.orderId, lineId: fx.lineA, productId: fx.productIds[0], warehouseId: fx.wmsId, qty: D(2) } })
    const next = await d.loader.loadMixedScopeForOrder(d.db, fx.orderId, fx.wmsId)
    assert.equal(next?.mode, 'MIXED')
    if (next) await d.record.recordMixedScopeOutcome(d.db, fx.orderId, next, new Date())
    const bumped = await d.db.wmsOrderPushLink.findUnique({ where: { id: fx.linkId }, select: { scopeVersion: true } })
    assert.equal(bumped?.scopeVersion, 2)
  } finally { await clean(d, fx) }
})

test('a settled link leaves the polling, hold and cancel passes; a dirty link enters the amend pass only while the feature is on', { skip }, async () => {
  const d = await setup()
  const fx = await seed(d)
  try {
    const port = d.pushSweep.createPrismaWmsOrderPushPort()
    const where = d.dispatchSweep.dispatchCandidateWhere(fx.connector)
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { externalOrderNumber: 'MS-X', dispatchReconcileCheckedAt: null } })
    // Polling
    const polled = async () => (await d.db.wmsOrderPushLink.findMany({ where, select: { id: true } })).some((row) => row.id === fx.linkId)
    const wasPolled = await polled()
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { despatchSettledAt: new Date() } })
    assert.equal(await polled(), false, 'a settled link is not polled')
    if (wasPolled) await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { despatchSettledAt: null } })
    assert.equal(await polled(), wasPolled)
    // Cancel / hold guards
    await d.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'CANCELLED' } })
    const cancellable = async () => (await port.cancellableLinks(fx.connector, 50)).some((row) => row.id === fx.linkId)
    assert.equal(await cancellable(), true)
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { despatchSettledAt: new Date() } })
    assert.equal(await cancellable(), false, 'a settled warehouse part is never cancelled there')
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { despatchSettledAt: null } })
    await d.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'ON_HOLD' } })
    const holdable = async () => (await port.holdableLinks(fx.connector, 50)).some((row) => row.id === fx.linkId)
    assert.equal(await holdable(), true)
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { despatchSettledAt: new Date() } })
    assert.equal(await holdable(), false)
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { despatchSettledAt: null } })
    // Amend pass: a dirty link, order untouched since the push
    await d.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'ALLOCATED' } })
    await d.db.$executeRaw`UPDATE sales_orders SET "updatedAt" = ${new Date(Date.now() - 7_200_000)} WHERE id = ${fx.orderId}`
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { scopeDirtyAt: new Date() } })
    const due = async () => (await port.updatableLinks(fx.connector, 50)).some((row) => row.id === fx.linkId)
    assert.equal(await due(), false, 'feature off: a dirty mark is not read')
    await d.db.setting.upsert({ where: { key: 'wms_mixed_warehouse_push_enabled' }, create: { key: 'wms_mixed_warehouse_push_enabled', value: 'true' }, update: { value: 'true' } })
    assert.equal(await due(), true, 'feature on: a dirty link is due')
    await d.db.wmsOrderPushLink.update({ where: { id: fx.linkId }, data: { scopeFrozenReason: 'NOT_NEW', scopeFrozenAt: new Date() } })
    assert.equal(await due(), false, 'a change the warehouse refused as past NEW is not re-selected')
  } finally { await clean(d, fx) }
})
