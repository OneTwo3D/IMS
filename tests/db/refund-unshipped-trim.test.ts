import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import { trimUnshippedAllocationsForRefundTx } from '../../lib/domain/sales/allocation-service'

/**
 * THE SHIPMENT-SAFE TRIM AGAINST A REAL DATABASE: a refund of unshipped units on a part-shipped order gives back exactly
 * the unshipped reservation, leaves the shipped rows, the shipments and the cost records alone, and a replay trims nothing.
 * Every test runs inside a transaction that is ROLLED BACK, ALWAYS. Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/refund-unshipped-trim.test.ts would have been skipped. Fix the invocation (npm run test:db).')
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

async function seed(tx: Tx) {
  const suffix = randomUUID().slice(0, 8)
  const a = await tx.product.create({ data: { sku: `TA-${suffix}`, name: 'a', type: 'SIMPLE' }, select: { id: true } })
  const b = await tx.product.create({ data: { sku: `TB-${suffix}`, name: 'b', type: 'SIMPLE' }, select: { id: true } })
  const wh = await tx.warehouse.create({ data: { code: `T${suffix}`, name: `t ${suffix}` }, select: { id: true } })
  const line = (productId: string, qty: string) => ({
    productId, description: 'l', qty: D(qty), unitPriceForeign: D('10'), unitPriceBase: D('10'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('10'), totalBase: D('10'),
  })
  const order = await tx.salesOrder.create({
    data: {
      orderNumber: `T-${suffix}`, status: 'PACKING', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D('100'), totalForeign: D('100'), subtotalBase: D('100'), taxBase: D('0'), totalBase: D('100'),
      allocationBatchAmount: D('55.5'),
      lines: { create: [line(a.id, '5'), line(b.id, '2')] },
    },
    select: { id: true, lines: { select: { id: true, productId: true }, orderBy: { id: 'asc' } } },
  })
  const lineA = order.lines.find((l: { productId: string }) => l.productId === a.id).id
  const lineB = order.lines.find((l: { productId: string }) => l.productId === b.id).id
  const snapshot = [{ costLayerId: 'cl-1', qty: '5', unitCostBase: '4' }]
  await tx.orderAllocation.create({ data: { orderId: order.id, lineId: lineA, productId: a.id, warehouseId: wh.id, qty: D('5'), costLayerSnapshot: snapshot } })
  await tx.orderAllocation.create({ data: { orderId: order.id, lineId: lineB, productId: b.id, warehouseId: wh.id, qty: D('2') } })
  // Dispatch of 3 of line A retained its row and gave 3 units of reservation back: 2 left for A, 2 for B.
  await tx.stockLevel.create({ data: { productId: a.id, warehouseId: wh.id, quantity: D('7'), reservedQty: D('2') } })
  await tx.stockLevel.create({ data: { productId: b.id, warehouseId: wh.id, quantity: D('7'), reservedQty: D('2') } })
  const shipment = await tx.shipment.create({
    data: { orderId: order.id, warehouseId: wh.id, status: 'SHIPPED', lines: { create: [{ lineId: lineA, productId: a.id, qty: D('3') }] } },
    select: { id: true },
  })
  return { orderId: order.id, a: a.id, b: b.id, wh: wh.id, lineA, lineB, shipmentId: shipment.id }
}

async function refund(tx: Tx, fx: { orderId: string }, lineId: string, productId: string, qty: string) {
  await tx.salesOrderRefund.create({
    data: {
      orderId: fx.orderId, totalForeign: D('10'), totalBase: D('10'),
      lines: { create: [{ salesOrderLineId: lineId, productId, description: 'r', qty: D(qty), unitPriceBase: D('10'), totalBase: D('10') }] },
    },
  })
}

const rowQty = async (tx: Tx, orderId: string, lineId: string) => (await tx.orderAllocation.findFirst({ where: { orderId, lineId } }))?.qty.toFixed(4) ?? null
const reserved = async (tx: Tx, productId: string, warehouseId: string) => (await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } })).reservedQty.toFixed(4)
const run = (tx: Tx, orderId: string, noDemand = false) => trimUnshippedAllocationsForRefundTx(tx, { orderId, noDemand, userId: null })

test('[db] refund of 2 on a line with 5 allocated and 3 shipped releases exactly 2; the other line and the shipment are untouched; a replay releases nothing', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    await refund(tx, fx, fx.lineA, fx.a, '2')
    const first = await run(tx, fx.orderId)
    assert.equal(first.trimmed, 1)
    assert.equal(await rowQty(tx, fx.orderId, fx.lineA), '3.0000', 'only the unshipped part came off; the 3 shipped stay on the retained row')
    assert.equal(await reserved(tx, fx.a, fx.wh), '0.0000')
    assert.equal(await rowQty(tx, fx.orderId, fx.lineB), '2.0000')
    assert.equal(await reserved(tx, fx.b, fx.wh), '2.0000')
    assert.equal((await tx.shipment.findUnique({ where: { id: fx.shipmentId } })).status, 'SHIPPED')
    assert.equal((await tx.shipmentLine.findFirst({ where: { shipmentId: fx.shipmentId } })).qty.toFixed(4), '3.0000')

    const replay = await run(tx, fx.orderId)
    assert.equal(replay.trimmed, 0)
    assert.equal(await reserved(tx, fx.a, fx.wh), '0.0000', 'a replay does not release twice')
  })
})

test('[db] the cost records are NOT adjusted by the trim (the refund already consumed them): snapshot and posted allocation amount are identical after', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    await refund(tx, fx, fx.lineA, fx.a, '2')
    await run(tx, fx.orderId)
    const row = await tx.orderAllocation.findFirst({ where: { orderId: fx.orderId, lineId: fx.lineA } })
    assert.deepEqual(row.costLayerSnapshot, [{ costLayerId: 'cl-1', qty: '5', unitCostBase: '4' }])
    assert.equal((await tx.salesOrder.findUnique({ where: { id: fx.orderId } })).allocationBatchAmount.toFixed(2), '55.50')
  })
})

test('[db] a refund larger than the unshipped part is clamped at what shipped, never taking shipped rows', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    await refund(tx, fx, fx.lineA, fx.a, '4')
    await run(tx, fx.orderId)
    assert.equal(await rowQty(tx, fx.orderId, fx.lineA), '3.0000')
    assert.equal(await reserved(tx, fx.a, fx.wh), '0.0000')
  })
})

test('[db] a picked/packed shipment keeps the rows it needs; only the uncommitted surplus is released', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    await tx.shipment.create({ data: { orderId: fx.orderId, warehouseId: fx.wh, status: 'PACKED', lines: { create: [{ lineId: fx.lineA, productId: fx.a, qty: D('1') }] } } })
    await refund(tx, fx, fx.lineA, fx.a, '2')
    await run(tx, fx.orderId)
    // 5 allocated, 3 shipped + 1 packed committed -> floor 4; refund wants 3, so only 1 can come off.
    assert.equal(await rowQty(tx, fx.orderId, fx.lineA), '4.0000')
    assert.equal(await reserved(tx, fx.a, fx.wh), '1.0000')
  })
})

test('[db] a cancelled or fully refunded order releases every unshipped unit, keeping only what shipped', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    await run(tx, fx.orderId, true)
    assert.equal(await rowQty(tx, fx.orderId, fx.lineA), '3.0000')
    assert.equal(await rowQty(tx, fx.orderId, fx.lineB), null, 'a row with nothing shipped and nothing committed is removed')
    assert.equal(await reserved(tx, fx.a, fx.wh), '0.0000')
    assert.equal(await reserved(tx, fx.b, fx.wh), '0.0000')
  })
})

test('[db] a reserved quantity too low to release refuses and rolls the trim back, never robbing another order', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    await tx.stockLevel.update({ where: { productId_warehouseId: { productId: fx.a, warehouseId: fx.wh } }, data: { reservedQty: D('1') } })
    await refund(tx, fx, fx.lineA, fx.a, '2')
    await tx.$executeRaw`SAVEPOINT trim`
    await assert.rejects(() => run(tx, fx.orderId), /Cannot release/)
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT trim`
    assert.equal(await rowQty(tx, fx.orderId, fx.lineA), '5.0000')
    assert.equal(await reserved(tx, fx.a, fx.wh), '1.0000')
  })
})

test('[db] a pending draft that the shrunken rows no longer back is retired by the trim; the shipped shipment stays', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    // A draft for the 2 unshipped units of line A: backed while the row holds 5, unbacked once it holds 3.
    const draft = await tx.shipment.create({ data: { orderId: fx.orderId, warehouseId: fx.wh, status: 'PENDING', lines: { create: [{ lineId: fx.lineA, productId: fx.a, qty: D('2') }] } }, select: { id: true } })
    await refund(tx, fx, fx.lineA, fx.a, '2')
    await run(tx, fx.orderId)
    assert.equal(await tx.shipment.count({ where: { id: draft.id } }), 0, 'the unbacked draft is retired')
    assert.equal((await tx.shipment.findUnique({ where: { id: fx.shipmentId } })).status, 'SHIPPED')
  })
})
