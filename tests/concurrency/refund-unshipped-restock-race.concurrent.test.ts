import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-zvec.21 — a WooCommerce refund racing the SHIPMENT of the very unit it refunds, proven against
 * a real Postgres.
 *
 * The refund decides, per line, what to restock (only quantity that SHIPPED) and what to leave to the
 * demand/reservation release (quantity that did not). Both answers hang on one fact — "has this unit
 * shipped?" — and the shipper commits that fact under the order's row lock. A refund that reads the
 * shipment BEFORE taking the lock decides on a stale answer: it sees the unit unshipped, skips the
 * restock, and then the shipment commits underneath it, so the unit is refunded, shipped, and in
 * neither the stock count nor the release (the lock serialised the write but did not protect the
 * data used for it).
 *
 * THE RIG. The shipper is a real transaction that takes the order lock the way every shipment
 * transition does (`lockSalesOrder`), flips the shipment to SHIPPED, and then HOLDS. The refund is
 * started while it holds, and we wait until PostgreSQL itself reports a backend blocked on a lock.
 * Only then does the shipper commit. The refund therefore provably reached its decision AFTER the
 * shipment committed.
 *
 *   arm 1 (race)    the unit ships while the refund waits  -> it is restocked, and NOT released.
 *   arm 2 (control) the same rig, but the unit never ships -> it is released, and NOT restocked.
 *
 * The control is what makes arm 1 non-vacuous: the same refund call, on the same fixture, gives the
 * OPPOSITE verdict when the only difference is the shipment — so the assertion in arm 1 can only be
 * met by a refund that read the shipment under the lock.
 *
 * WHY THIS CANNOT BE A UNIT TEST: the in-memory client in tests/domain/sales/refund-service.test.ts
 * runs its "transactions" one after another and its statements never block, so it cannot reproduce a
 * commit landing while another session waits on the order lock.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new Error('This concurrency test requires a Postgres DATABASE_URL')
  }

  const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, { createSalesOrderRefund }, { lockSalesOrder }] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/domain/sales/allocation-service'),
  ])
  // Config form, not `new PrismaPg(pool)` (o3d-4ajo). max: 4 — shipper and refund must hold
  // connections SIMULTANEOUSLY, or the pool would serialise them instead of the database.
  const poolConfig = { connectionString: databaseUrl, max: 4 }
  const pool = new pg.Pool(poolConfig)
  const db = new PrismaClient({ adapter: new PrismaPg(poolConfig) })
  return { Prisma, db, pool, createSalesOrderRefund, lockSalesOrder }
}

type Rig = Awaited<ReturnType<typeof openRig>>

async function seed(rig: Rig, suffix: string) {
  const { Prisma, db } = rig
  const product = await db.product.create({
    data: { sku: `ZV21-${suffix}`, name: `zvec21 ${suffix}`, type: 'SIMPLE' },
    select: { id: true },
  })
  const main = await db.warehouse.create({
    data: { code: `ZM${suffix.slice(0, 8)}`, name: `zvec21 main ${suffix}` },
    select: { id: true },
  })
  const returns = await db.warehouse.create({
    data: { code: `ZR${suffix.slice(0, 8)}`, name: `zvec21 returns ${suffix}` },
    select: { id: true },
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `ZV21-${suffix.slice(0, 8)}`,
      status: 'PACKING',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
      lines: {
        create: [{
          productId: product.id,
          description: 'zvec21 line',
          qty: new Prisma.Decimal('1'),
          unitPriceForeign: new Prisma.Decimal('100'),
          unitPriceBase: new Prisma.Decimal('100'),
          taxForeign: new Prisma.Decimal('0'),
          taxBase: new Prisma.Decimal('0'),
          totalForeign: new Prisma.Decimal('100'),
          totalBase: new Prisma.Decimal('100'),
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await db.orderAllocation.create({
    data: { orderId: order.id, lineId, productId: product.id, warehouseId: main.id, qty: new Prisma.Decimal('1') },
  })
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: main.id, quantity: new Prisma.Decimal('1'), reservedQty: new Prisma.Decimal('1') },
  })
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id,
      warehouseId: main.id,
      status: 'PACKED',
      lines: { create: [{ lineId, productId: product.id, qty: new Prisma.Decimal('1') }] },
    },
    select: { id: true },
  })
  return { productId: product.id, mainId: main.id, returnsId: returns.id, orderId: order.id, lineId, shipmentId: shipment.id }
}

async function cleanup(rig: Rig, fx: Awaited<ReturnType<typeof seed>> | undefined) {
  if (!fx) return
  const { db } = rig
  await db.integrationOutbox.deleteMany({ where: { operation: 'refund.reservation-release', payloadJson: { path: ['orderId'], equals: fx.orderId } } }).catch(() => {})
  await db.stockMovement.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
  await db.costLayer.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
  await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.shipmentLine.deleteMany({ where: { shipment: { orderId: fx.orderId } } }).catch(() => {})
  await db.shipment.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.orderAllocation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrder.delete({ where: { id: fx.orderId } }).catch(() => {})
  await db.stockLevel.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
  await db.warehouse.deleteMany({ where: { id: { in: [fx.mainId, fx.returnsId] } } }).catch(() => {})
  await db.product.delete({ where: { id: fx.productId } }).catch(() => {})
}

/**
 * Resolves once PostgreSQL reports a backend BLOCKED BY THE SHIPPER'S OWN BACKEND — the refund, parked on the
 * order row. Asking for "any Lock wait" would be satisfied by another concurrency file running in parallel
 * against the same database, and prove nothing about this refund.
 */
async function waitUntilBlockedBy(rig: Rig, shipperPid: number, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { rows } = await rig.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND $1::int = ANY (pg_blocking_pids(pid))`,
      [shipperPid],
    )
    if (rows[0].n > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

function refundInput(fx: Awaited<ReturnType<typeof seed>>, suffix: string, externalRefundId: number) {
  return {
    orderId: fx.orderId,
    lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'zvec21 line', qty: 1, totalBase: 100 }],
    reason: 'WooCommerce refund',
    returnWarehouseId: fx.returnsId,
    externalRefundId,
    creditNotePrefix: `ZV21${suffix.slice(0, 6)}-`,
  }
}

async function observe(rig: Rig, fx: Awaited<ReturnType<typeof seed>>) {
  const { db } = rig
  const [refunds, restocked, level, releaseRows, shipment] = await Promise.all([
    db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { returnWarehouseId: true } }),
    db.stockLevel.findFirst({ where: { productId: fx.productId, warehouseId: fx.returnsId }, select: { quantity: true } }),
    db.stockLevel.findFirst({ where: { productId: fx.productId, warehouseId: fx.mainId }, select: { quantity: true, reservedQty: true } }),
    db.integrationOutbox.count({ where: { operation: 'refund.reservation-release', payloadJson: { path: ['orderId'], equals: fx.orderId } } }),
    db.shipment.findUnique({ where: { id: fx.shipmentId }, select: { status: true } }),
  ])
  return {
    refunds,
    returnsQty: restocked ? Number(restocked.quantity) : 0,
    mainQty: level ? Number(level.quantity) : null,
    mainReserved: level ? Number(level.reservedQty) : null,
    releaseRows,
    shipmentStatus: shipment?.status,
  }
}

test(
  'o3d-zvec.21: a refund waiting on the order lock while the unit SHIPS restocks it and does not release it',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    const rig = await openRig()
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    let fx: Awaited<ReturnType<typeof seed>> | undefined
    try {
      fx = await seed(rig, suffix)
      const seeded = fx
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let shipperHoldsLock!: () => void
      const holding = new Promise<void>((resolve) => { shipperHoldsLock = resolve })
      let shipperPid = 0

      // The shipper: order lock first (as every shipment transition does), then SHIPPED, then hold.
      const shipper = rig.db.$transaction(async (tx) => {
        await rig.lockSalesOrder(tx, seeded.orderId)
        shipperPid = Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid)
        await tx.shipment.update({ where: { id: seeded.shipmentId }, data: { status: 'SHIPPED', shippedAt: new Date() } })
        shipperHoldsLock()
        await released
      }, { timeout: 60000, maxWait: 15000 })

      await holding
      const refund = rig.createSalesOrderRefund(rig.db, refundInput(seeded, suffix, 1_000_000 + Math.floor(Math.random() * 900_000)))
      const refundWasBlocked = await waitUntilBlockedBy(rig, shipperPid)
      assert.equal(refundWasBlocked, true, 'PRECONDITION: the refund is parked on the shipper\'s order lock (PostgreSQL reports a backend blocked by the shipper)')
      const midRace = await observe(rig, seeded)
      assert.equal(midRace.refunds.length, 0, 'PRECONDITION: the refund has committed nothing while the shipper holds the lock')
      release()
      await shipper
      const result = await refund

      assert.equal(result.success, true, `refund must succeed (${result.success ? '' : result.error})`)
      const seen = await observe(rig, seeded)
      assert.equal(seen.shipmentStatus, 'SHIPPED', 'PRECONDITION: the unit shipped before the refund took the lock')
      assert.equal(seen.refunds.length, 1, 'exactly one credit note')
      assert.equal(seen.refunds[0].returnWarehouseId, seeded.returnsId, 'the refund decided AFTER the shipment committed: the shipped unit is restocked')
      assert.equal(seen.returnsQty, 1, 'one unit is back on hand in the returns warehouse')
      assert.equal(seen.releaseRows, 0, 'and the same unit is NOT also released — shipped stock has no reservation left to release')
      assert.ok((seen.mainQty ?? 0) >= 0 && (seen.returnsQty ?? 0) >= 0, 'no negative stock')
    } finally {
      await cleanup(rig, fx)
      await rig.db.$disconnect()
      await rig.pool.end()
    }
  },
)

test(
  'o3d-zvec.21 (control): the same rig where the unit never ships releases it and restocks nothing',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    const rig = await openRig()
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    let fx: Awaited<ReturnType<typeof seed>> | undefined
    try {
      fx = await seed(rig, suffix)
      const seeded = fx
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let shipperHoldsLock!: () => void
      const holding = new Promise<void>((resolve) => { shipperHoldsLock = resolve })
      let shipperPid = 0

      // The shipper takes the lock and touches the shipment, but leaves it PACKED: nothing ships.
      const shipper = rig.db.$transaction(async (tx) => {
        await rig.lockSalesOrder(tx, seeded.orderId)
        shipperPid = Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid)
        await tx.shipment.update({ where: { id: seeded.shipmentId }, data: { trackingNumber: 'ZV21-NOT-SHIPPED' } })
        shipperHoldsLock()
        await released
      }, { timeout: 60000, maxWait: 15000 })

      await holding
      const refund = rig.createSalesOrderRefund(rig.db, refundInput(seeded, suffix, 2_000_000 + Math.floor(Math.random() * 900_000)))
      const refundWasBlocked = await waitUntilBlockedBy(rig, shipperPid)
      assert.equal(refundWasBlocked, true, 'PRECONDITION: the refund is parked on the order lock')
      release()
      await shipper
      const result = await refund

      assert.equal(result.success, true, `refund must succeed (${result.success ? '' : result.error})`)
      const seen = await observe(rig, seeded)
      assert.equal(seen.shipmentStatus, 'PACKED', 'PRECONDITION: the unit never shipped')
      assert.equal(seen.refunds.length, 1)
      assert.equal(seen.refunds[0].returnWarehouseId, null, 'no return warehouse: nothing came back')
      assert.equal(seen.returnsQty, 0, 'NO restock of a unit that never left')
      assert.equal(seen.releaseRows, 1, 'the unit\'s reservation is released, exactly once')
    } finally {
      await cleanup(rig, fx)
      await rig.db.$disconnect()
      await rig.pool.end()
    }
  },
)
