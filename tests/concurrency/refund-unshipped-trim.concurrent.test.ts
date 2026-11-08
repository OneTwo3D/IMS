import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * A refund of UNSHIPPED units on a part-shipped order gives back exactly their reservation, once, against a real
 * Postgres, while other writers of the same order are running.
 *
 *   arm 1  two releases (the immediate one and the outbox drain) race on one refund -> the reservation falls once.
 *   arm 2  a shipment dispatches while the release waits on the order lock -> the release reads the shipped quantity
 *          AFTER the dispatch committed and never takes a shipped unit's row or reservation.
 *
 * Both arms run the real allocator entry point with the real flags the refund paths use, not the trim function alone.
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, { allocateSalesOrder, lockSalesOrder }] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
    import('@/lib/domain/sales/allocation-service'),
  ])
  const poolConfig = { connectionString: databaseUrl, max: 6 }
  const pool = new pg.Pool(poolConfig)
  const db = new PrismaClient({ adapter: new PrismaPg(poolConfig) })
  return { Prisma, db, pool, allocateSalesOrder, lockSalesOrder }
}
type Rig = Awaited<ReturnType<typeof openRig>>

async function seed(rig: Rig, suffix: string) {
  const { Prisma, db } = rig
  const D = (v: string) => new Prisma.Decimal(v)
  const product = await db.product.create({ data: { sku: `ZV26-${suffix}`, name: `zvec26 ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const wh = await db.warehouse.create({ data: { code: `Z6${suffix.slice(0, 8)}`, name: `zvec26 ${suffix}` }, select: { id: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `ZV26-${suffix.slice(0, 8)}`, status: 'PACKING', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D('100'), totalForeign: D('100'), subtotalBase: D('100'), taxBase: D('0'), totalBase: D('100'),
      lines: { create: [{ productId: product.id, description: 'l', qty: D('5'), unitPriceForeign: D('20'), unitPriceBase: D('20'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('100'), totalBase: D('100') }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await db.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: wh.id, qty: D('5') } })
  // 5 reserved; the first shipment (3 units) has dispatched: 2 reserved remain. A second shipment of 1 is packed.
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: wh.id, quantity: D('7'), reservedQty: D('2') } })
  await db.shipment.create({ data: { orderId: order.id, warehouseId: wh.id, status: 'SHIPPED', lines: { create: [{ lineId, productId: product.id, qty: D('3') }] } } })
  const packed = await db.shipment.create({ data: { orderId: order.id, warehouseId: wh.id, status: 'PACKED', lines: { create: [{ lineId, productId: product.id, qty: D('1') }] } }, select: { id: true } })
  // The refund of 1 unit (the unshipped-first rule: 1 of the 2 not yet shipped).
  await db.salesOrderRefund.create({ data: { orderId: order.id, totalForeign: D('20'), totalBase: D('20'), lines: { create: [{ salesOrderLineId: lineId, productId: product.id, description: 'r', qty: D('1'), unitPriceBase: D('20'), totalBase: D('20') }] } } })
  return { productId: product.id, whId: wh.id, orderId: order.id, lineId, packedId: packed.id }
}

async function cleanup(rig: Rig, fx: Awaited<ReturnType<typeof seed>> | undefined) {
  if (!fx) return
  const { db } = rig
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
  await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.shipmentLine.deleteMany({ where: { shipment: { orderId: fx.orderId } } }).catch(() => {})
  await db.shipment.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.orderAllocation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.activityLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
  await db.salesOrder.delete({ where: { id: fx.orderId } }).catch(() => {})
  await db.stockLevel.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
  await db.warehouse.delete({ where: { id: fx.whId } }).catch(() => {})
  await db.product.delete({ where: { id: fx.productId } }).catch(() => {})
}

let resolved = 0
const release = (rig: Rig, orderId: string) =>
  rig.allocateSalesOrder(rig.db, {
    orderId,
    refuseIfShipmentsExist: true,
    trimUnshippedWhenShipmentsExist: true,
    // The durable backstop is resolved inside the same transaction on the trimmed path too.
    onReconciledInTx: async () => { resolved += 1 },
  })

async function state(rig: Rig, fx: Awaited<ReturnType<typeof seed>>) {
  const [row, level] = await Promise.all([
    rig.db.orderAllocation.findFirst({ where: { orderId: fx.orderId, lineId: fx.lineId }, select: { qty: true } }),
    rig.db.stockLevel.findFirst({ where: { productId: fx.productId, warehouseId: fx.whId }, select: { reservedQty: true } }),
  ])
  return { rowQty: Number(row?.qty ?? 0), reserved: Number(level?.reservedQty ?? 0) }
}

test('o3d-zvec.26 arm 1: two concurrent releases for one refund release the unshipped unit once', { skip }, async () => {
  const rig = await openRig()
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, randomUUID().replace(/-/g, '').slice(0, 12))
    const [a, b] = await Promise.all([release(rig, fx.orderId), release(rig, fx.orderId)])
    assert.notEqual(a.refused, true)
    assert.notEqual(b.refused, true)
    assert.equal(a.success && b.success, true)
    assert.equal(resolved, 2, 'the backstop is resolved in the transaction by each pass')
    // 5 allocated, 3 shipped + 1 packed committed, 1 refunded of the 2 unshipped -> keep 4, release exactly 1.
    assert.deepEqual(await state(rig, fx), { rowQty: 4, reserved: 1 })
    // A third pass changes nothing.
    await release(rig, fx.orderId)
    assert.deepEqual(await state(rig, fx), { rowQty: 4, reserved: 1 })
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('o3d-zvec.26 arm 2: a release waiting on the order lock while another unit ships never takes the shipped unit', { skip }, async () => {
  const rig = await openRig()
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, randomUUID().replace(/-/g, '').slice(0, 12))
    const seeded = fx
    let letGo!: () => void
    const gate = new Promise<void>((resolve) => { letGo = resolve })
    let holding!: () => void
    const held = new Promise<void>((resolve) => { holding = resolve })
    let shipperPid = 0
    const shipper = rig.db.$transaction(async (tx) => {
      await rig.lockSalesOrder(tx, seeded.orderId)
      shipperPid = Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid)
      // The packed unit dispatches: SHIPPED, and the dispatch gives its reservation back.
      await tx.shipment.update({ where: { id: seeded.packedId }, data: { status: 'SHIPPED', shippedAt: new Date() } })
      await tx.stockLevel.updateMany({ where: { productId: seeded.productId, warehouseId: seeded.whId }, data: { reservedQty: { decrement: 1 } } })
      holding()
      await gate
    }, { timeout: 60000, maxWait: 15000 })
    await held
    const pending = release(rig, seeded.orderId)
    const deadline = Date.now() + 15000
    let blocked = false
    while (Date.now() < deadline && !blocked) {
      const { rows } = await rig.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY (pg_blocking_pids(pid))`,
        [shipperPid],
      )
      blocked = rows[0].n > 0
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(blocked, true, 'PRECONDITION: the release is parked on the shipper\'s order lock')
    letGo()
    await shipper
    const result = await pending
    assert.notEqual(result.refused, true)
    // 4 shipped now, 1 refunded of the remaining 1 unshipped unit: keep 4, release the last unit; reserved 1 -> 0.
    assert.deepEqual(await state(rig, seeded), { rowQty: 4, reserved: 0 })
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})
