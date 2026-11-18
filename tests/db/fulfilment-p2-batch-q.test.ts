import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import { updateSalesOrderStatusUnderLock } from '../../lib/domain/sales/allocation-service'
import { applyStockAdjustment } from '../../lib/domain/inventory/stock-adjustment-apply'

/**
 * P2 batch Q against a real database, every test inside a transaction that is ROLLED BACK, ALWAYS.
 *   o3d-hqvrp.79: closing an order as SHIPPED gives back the unshipped allocation.
 *   o3d-hqvrp.80: a removal into reserved stock releases the newest order's allocation first (flagged).
 * Gated on RUN_DB_RETENTION_TESTS (npm run test:db). No network: nothing here reaches a connector.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/fulfilment-p2-batch-q.test.ts would have been skipped. Fix the invocation (npm run test:db).')
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

const D = (value: string) => new Prisma.Decimal(value)

async function seed(tx: Tx, status: string) {
  const suffix = randomUUID().slice(0, 8)
  const a = await tx.product.create({ data: { sku: `QA-${suffix}`, name: 'a', type: 'SIMPLE' }, select: { id: true } })
  const wh = await tx.warehouse.create({ data: { code: `Q${suffix}`, name: `q ${suffix}` }, select: { id: true } })
  const order = await tx.salesOrder.create({
    data: {
      orderNumber: `Q-${suffix}`, status, currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D('100'), totalForeign: D('100'), subtotalBase: D('100'), taxBase: D('0'), totalBase: D('100'),
      lines: { create: [{
        productId: a.id, description: 'l', qty: D('10'), unitPriceForeign: D('10'), unitPriceBase: D('10'),
        taxForeign: D('0'), taxBase: D('0'), totalForeign: D('10'), totalBase: D('10'),
      }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { orderId: order.id, a: a.id, wh: wh.id, lineA: order.lines[0].id }
}

const reserved = async (tx: Tx, productId: string, warehouseId: string) =>
  (await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } })).reservedQty.toFixed(4)
const rowQty = async (tx: Tx, orderId: string) =>
  (await tx.orderAllocation.findFirst({ where: { orderId } }))?.qty.toFixed(4) ?? null

test('[db] closing a part-shipped order as SHIPPED releases the unshipped allocation, keeps the shipped row (o3d-hqvrp.79)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, 'PACKING')
    // Allocated 10; 6 shipped (reservation for those already given back); 4 still reserved.
    await tx.orderAllocation.create({ data: { orderId: fx.orderId, lineId: fx.lineA, productId: fx.a, warehouseId: fx.wh, qty: D('10') } })
    await tx.stockLevel.create({ data: { productId: fx.a, warehouseId: fx.wh, quantity: D('20'), reservedQty: D('4') } })
    await tx.shipment.create({ data: { orderId: fx.orderId, warehouseId: fx.wh, status: 'SHIPPED', lines: { create: [{ lineId: fx.lineA, productId: fx.a, qty: D('6') }] } } })

    const moved = await updateSalesOrderStatusUnderLock(tx, { orderId: fx.orderId, targetStatus: 'SHIPPED' })

    assert.equal((await tx.salesOrder.findUnique({ where: { id: fx.orderId } })).status, 'SHIPPED')
    assert.equal(await rowQty(tx, fx.orderId), '6.0000', 'the row keeps what shipped')
    assert.equal(await reserved(tx, fx.a, fx.wh), '0.0000', 'the 4 unshipped units are no longer reserved')
    assert.deepEqual(moved.releasedProductIds, [fx.a])
  })
})

test('[db] a fully-shipped order closed as SHIPPED releases nothing (o3d-hqvrp.79 control)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, 'PACKING')
    await tx.orderAllocation.create({ data: { orderId: fx.orderId, lineId: fx.lineA, productId: fx.a, warehouseId: fx.wh, qty: D('10') } })
    await tx.stockLevel.create({ data: { productId: fx.a, warehouseId: fx.wh, quantity: D('20'), reservedQty: D('0') } })
    await tx.shipment.create({ data: { orderId: fx.orderId, warehouseId: fx.wh, status: 'SHIPPED', lines: { create: [{ lineId: fx.lineA, productId: fx.a, qty: D('10') }] } } })

    const moved = await updateSalesOrderStatusUnderLock(tx, { orderId: fx.orderId, targetStatus: 'SHIPPED' })

    assert.equal(await rowQty(tx, fx.orderId), '10.0000')
    assert.deepEqual(moved.releasedProductIds, [])
  })
})

async function seedReservedStock(tx: Tx) {
  const fx = await seed(tx, 'ALLOCATED')
  await tx.orderAllocation.create({ data: { orderId: fx.orderId, lineId: fx.lineA, productId: fx.a, warehouseId: fx.wh, qty: D('10') } })
  // 10 on hand, all 10 reserved for the order.
  await tx.stockLevel.create({ data: { productId: fx.a, warehouseId: fx.wh, quantity: D('10'), reservedQty: D('10') } })
  await tx.costLayer.create({ data: { productId: fx.a, warehouseId: fx.wh, receivedQty: D('10'), remainingQty: D('10'), unitCostBase: D('3'), isOpeningStock: true } })
  return fx
}

test('[db] a loss of reserved stock is refused without the flag, as before (o3d-hqvrp.80 control)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seedReservedStock(tx)
    await assert.rejects(
      () => applyStockAdjustment({ tx, productId: fx.a, warehouseId: fx.wh, qty: -4, note: 'damaged' }),
      /Insufficient stock/,
    )
  })
})

test('[db] with the flag, a loss of reserved stock releases the order\'s allocation in the same transaction (o3d-hqvrp.80)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seedReservedStock(tx)

    await applyStockAdjustment({ tx, productId: fx.a, warehouseId: fx.wh, qty: -4, note: 'damaged', releaseReservedForRemoval: true })

    const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: fx.a, warehouseId: fx.wh } } })
    assert.equal(level.quantity.toFixed(4), '6.0000')
    assert.equal(level.reservedQty.toFixed(4), '6.0000', 'reserved fell with the allocation, never above on-hand')
    assert.equal(await rowQty(tx, fx.orderId), '6.0000')
    const logged = await tx.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'allocation_released' } })
    assert.ok(logged, 'the release is audited on the order')
  })
})

test('[db] with the flag, a removal that free stock already covers releases nothing (o3d-hqvrp.80)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seedReservedStock(tx)
    await tx.stockLevel.update({ where: { productId_warehouseId: { productId: fx.a, warehouseId: fx.wh } }, data: { quantity: D('15') } })
    await tx.costLayer.updateMany({ where: { productId: fx.a }, data: { receivedQty: D('15'), remainingQty: D('15') } })

    await applyStockAdjustment({ tx, productId: fx.a, warehouseId: fx.wh, qty: -4, releaseReservedForRemoval: true })

    assert.equal(await rowQty(tx, fx.orderId), '10.0000')
    assert.equal(await reserved(tx, fx.a, fx.wh), '10.0000')
  })
})
