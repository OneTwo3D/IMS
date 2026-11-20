import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import { transitionShipmentStatus } from '../../lib/domain/sales/shipment-service'
import { findDespatchQuantityMismatch } from '../../lib/fulfillment/despatch-quantity-check'

/**
 * A WAREHOUSE DESPATCH IS DATED BY WHEN THE GOODS LEFT, AND ITS UNITS ARE COMPARED, against a real database. Every test runs inside a transaction
 * that is ROLLED BACK, ALWAYS. Gated on RUN_DB_RETENTION_TESTS (npm run test:db). No network.
 *   o3d-hqvrp.114: the shipment, its SALE_DISPATCH movement, the COGS entries and the order flip all carry the despatch instant, bounded by
 *                  the accounting lock, the latest inventory snapshot, the allocation and the order's own creation.
 *   o3d-hqvrp.115: SO-5001 (4 ordered, 1 refunded with no restock, shipment holds 3, warehouse sent 4) is a mismatch.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/warehouse-despatch-dating.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

const D = (value: string | number) => new Prisma.Decimal(String(value))
const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY)

/** An order of `ordered` units, `shipQty` of them on one PACKED shipment, allocated 10 days ago, the order itself created 20 days ago. */
async function seed(tx: Tx, opts: { ordered?: number; shipQty?: number; sku?: string } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const ordered = opts.ordered ?? 3
  const shipQty = opts.shipQty ?? ordered
  const product = await tx.product.create({ data: { sku: opts.sku ?? `WD-${suffix}`, name: `wd ${suffix}`, type: 'SIMPLE' }, select: { id: true, sku: true } })
  const wh = await tx.warehouse.create({ data: { code: `WD${suffix}`, name: `wd ${suffix}` }, select: { id: true } })
  await tx.stockLevel.create({ data: { productId: product.id, warehouseId: wh.id, quantity: D(10), reservedQty: D(shipQty) } })
  await tx.costLayer.create({ data: { productId: product.id, warehouseId: wh.id, receivedQty: D(10), remainingQty: D(10), unitCostBase: D(3), receivedAt: daysAgo(40) } })
  const order = await tx.salesOrder.create({
    data: {
      orderNumber: `WD-${suffix}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: D(1), createdAt: daysAgo(20),
      subtotalForeign: D(ordered * 10), totalForeign: D(ordered * 10), subtotalBase: D(ordered * 10), taxBase: D(0), totalBase: D(ordered * 10),
      shipFromWarehouseId: wh.id,
      lines: { create: [{ productId: product.id, sku: product.sku, description: 'l', qty: D(ordered), unitPriceForeign: D(10), unitPriceBase: D(10), taxForeign: D(0), taxBase: D(0), totalForeign: D(ordered * 10), totalBase: D(ordered * 10) }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await tx.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: wh.id, qty: D(shipQty), createdAt: daysAgo(10) } })
  const shipment = await tx.shipment.create({ data: { orderId: order.id, warehouseId: wh.id, status: 'PACKED', lines: { create: [{ lineId, productId: product.id, qty: D(shipQty) }] } }, select: { id: true } })
  return { orderId: order.id, productId: product.id, warehouseId: wh.id, lineId, shipmentId: shipment.id, sku: product.sku }
}

async function dispatch(tx: Tx, fx: Awaited<ReturnType<typeof seed>>, despatchedAt: Date | null) {
  const result = await transitionShipmentStatus(tx, {
    shipmentId: fx.shipmentId,
    targetStatus: 'SHIPPED',
    completion: { completionAuthority: 'EXTERNAL', storefrontCompletion: false },
    allowRecordWhenNotReady: true,
    ...(despatchedAt ? { despatchedAt } : {}),
  })
  assert.equal(result.success, true, JSON.stringify(result))
  return result as Extract<typeof result, { success: true }>
}

async function booked(tx: Tx, fx: Awaited<ReturnType<typeof seed>>) {
  const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: fx.shipmentId }, select: { shippedAt: true } })
  const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId }, select: { shippedAt: true, status: true } })
  const movements = await tx.stockMovement.findMany({ where: { productId: fx.productId, type: 'SALE_DISPATCH' }, select: { id: true, createdAt: true } })
  const cogs = await tx.cogsEntry.findMany({ where: { movementId: { in: movements.map((m: { id: string }) => m.id) } }, select: { createdAt: true } })
  return { shipmentAt: shipment.shippedAt as Date, orderAt: order.shippedAt as Date, orderStatus: order.status as string, movementAt: movements.map((m: { createdAt: Date }) => m.createdAt), cogsAt: cogs.map((c: { createdAt: Date }) => c.createdAt) }
}

test('[db] a despatch is booked at the warehouse time on the shipment, the stock movement, its COGS entries and the order flip (o3d-hqvrp.114)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const left = daysAgo(2)
    const result = await dispatch(tx, fx, left)
    const b = await booked(tx, fx)
    assert.equal(b.shipmentAt.getTime(), left.getTime(), 'shipment.shippedAt is the despatch time, not the apply time')
    assert.equal(b.orderAt.getTime(), left.getTime(), 'the order flip is dated the same')
    assert.equal(b.orderStatus, 'SHIPPED')
    assert.deepEqual(b.movementAt.map((d: Date) => d.getTime()), [left.getTime()], 'the movement every ledger and snapshot replay windows by')
    assert.deepEqual(b.cogsAt.map((d: Date) => d.getTime()), [left.getTime()])
    assert.equal(result.despatchInstant?.adjustedFor, null)
  })
})

test('[db] with no warehouse time the dispatch is booked now, exactly as before', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const before = Date.now()
    await dispatch(tx, fx, null)
    const b = await booked(tx, fx)
    assert.ok(b.shipmentAt.getTime() >= before - 1000 && b.shipmentAt.getTime() <= Date.now() + 1000)
    assert.equal(b.movementAt[0].getTime() >= before - 1000, true)
  })
})

test('[db] a future despatch time is clamped to now, and named', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const before = Date.now()
    const result = await dispatch(tx, fx, new Date(Date.now() + 3 * DAY))
    const b = await booked(tx, fx)
    assert.ok(b.shipmentAt.getTime() >= before - 1000 && b.shipmentAt.getTime() <= Date.now() + 1000)
    assert.equal(result.despatchInstant?.adjustedFor, 'FUTURE')
  })
})

test('[db] an implausibly old despatch time is not backdated', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const result = await dispatch(tx, fx, daysAgo(200))
    assert.equal(result.despatchInstant?.adjustedFor, 'TOO_OLD')
    assert.ok(Date.now() - (await booked(tx, fx)).shipmentAt.getTime() < 60_000)
  })
})

test('[db] a day that already has an inventory snapshot is not rewritten: the despatch moves to the first instant after the snapshot', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const cutoff = daysAgo(1)
    await tx.inventorySnapshotRun.create({ data: { snapshotDate: new Date(Date.UTC(2099, 0, 1)), stockLevelCount: 0, snapshotCount: 0, cutoffAt: cutoff } })
    // The run above is dated far in the future ONLY so it is the latest run whatever else the scratch database holds; clear it again below.
    const latest = await tx.inventorySnapshotRun.findFirstOrThrow({ orderBy: { snapshotDate: 'desc' } })
    assert.equal(latest.cutoffAt.getTime(), cutoff.getTime())
    const result = await dispatch(tx, fx, daysAgo(3))
    const b = await booked(tx, fx)
    assert.equal(result.despatchInstant?.adjustedFor, 'SNAPSHOTTED_DAY')
    assert.equal(b.shipmentAt.getTime(), cutoff.getTime())
    assert.deepEqual(b.movementAt.map((d: Date) => d.getTime()), [cutoff.getTime()], 'the movement moves with the shipment: never a movement inside a snapshotted day')
    assert.equal(b.orderAt.getTime(), cutoff.getTime())
  })
})

test('[db] a locked accounting period is not re-opened: the despatch moves to the first instant after the lock', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const lockDay = new Date(daysAgo(3)).toISOString().slice(0, 10)
    await tx.setting.upsert({ where: { key: 'xero_books_lock_date' }, create: { key: 'xero_books_lock_date', value: lockDay }, update: { value: lockDay } })
    const result = await dispatch(tx, fx, daysAgo(5))
    const b = await booked(tx, fx)
    assert.equal(result.despatchInstant?.adjustedFor, 'LOCKED_PERIOD')
    assert.ok(b.shipmentAt.getTime() > new Date(`${lockDay}T00:00:00Z`).getTime(), 'after the locked day')
    assert.ok(b.shipmentAt.getTime() < daysAgo(1.9).getTime(), 'and still in the recent past, not now')
    assert.equal(b.movementAt[0].getTime(), b.shipmentAt.getTime())
  })
})

test('[db] never dated before the stock was allocated (Group B must not precede Group A2)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const allocatedAt = daysAgo(1)
    await tx.orderAllocation.updateMany({ where: { orderId: fx.orderId }, data: { createdAt: allocatedAt } })
    const result = await dispatch(tx, fx, daysAgo(4))
    assert.equal(result.despatchInstant?.adjustedFor, 'BEFORE_ALLOCATION')
    assert.equal((await booked(tx, fx)).shipmentAt.getTime(), allocatedAt.getTime())
  })
})

test('[db] SO-5001: 4 x SKU-C, 1 refunded with no restock (the shipment holds 3), Mintsoft despatched 4: a MISMATCH, not a silent apply of 3 (o3d-hqvrp.115)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { ordered: 4, shipQty: 3, sku: `SKU-C-${randomUUID().slice(0, 6)}` })
    const verdict = await findDespatchQuantityMismatch({ orderId: fx.orderId, wmsWarehouseId: fx.warehouseId, wmsQuantities: [{ sku: fx.sku, qty: 4 }] }, tx)
    assert.deepEqual(verdict, { status: 'MISMATCH', mismatches: [{ sku: fx.sku, wmsQty: 4, imsQty: 3 }] })
    assert.deepEqual(await findDespatchQuantityMismatch({ orderId: fx.orderId, wmsWarehouseId: fx.warehouseId, wmsQuantities: [{ sku: fx.sku, qty: 3 }] }, tx), { status: 'MATCH' })
    // Another warehouse's shipments are never counted: asked about a different warehouse there is nothing to compare.
    assert.equal((await findDespatchQuantityMismatch({ orderId: fx.orderId, wmsWarehouseId: 'no-such-warehouse', wmsQuantities: [{ sku: fx.sku, qty: 4 }] }, tx)).status, 'NOT_COMPARABLE')
  })
})

test('[db] a kit order is not comparable (the warehouse and IMS list kits in different terms): no false mismatch', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { ordered: 2, shipQty: 2 })
    await tx.product.update({ where: { id: fx.productId }, data: { type: 'KIT' } })
    const verdict = await findDespatchQuantityMismatch({ orderId: fx.orderId, wmsWarehouseId: fx.warehouseId, wmsQuantities: [{ sku: 'COMPONENT-X', qty: 4 }] }, tx)
    assert.equal(verdict.status, 'NOT_COMPARABLE')
  })
})
