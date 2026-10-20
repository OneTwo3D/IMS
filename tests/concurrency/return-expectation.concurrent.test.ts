import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * A REFUND THAT SENDS GOODS BACK IN TRANSIT, AGAINST A REAL POSTGRES.
 *
 * Arm 1 (race). The refund's first attempt and its accounting retry both create the refund's return expectation. The
 * first holds its transaction open after creating the document; the second is started and we wait until PostgreSQL
 * itself reports it blocked by the first (the per-refund advisory lock), and only then does the first commit. The
 * second must find the document and add nothing: one document, one set of lines. Without the lock the second would
 * not wait and would collide on the unique key instead (or, worse, create lines twice).
 *
 * Arm 2 (end to end, ON). The real refund service with the switch on: the refund commits a document and writes NO
 * stock movement, stock level or cost layer.
 *
 * Arm 3 (control, OFF). The identical call with the switch off restocks, so arm 2's "nothing was restocked" can only be
 * met by the in-transit path and not by a fixture that never restocks.
 *
 * WHY THIS CANNOT BE A UNIT TEST: the in-memory client runs its transactions one after another and its statements never
 * block, so it cannot show a second writer waiting on the first.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
const SWITCH = 'refund_returns_in_transit_enabled'

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new Error('This concurrency test requires a Postgres DATABASE_URL')
  }
  const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, refundService, expectation] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/domain/sales/return-expectation'),
  ])
  const poolConfig = { connectionString: databaseUrl, max: 6 }
  const pool = new pg.Pool(poolConfig)
  const db = new PrismaClient({ adapter: new PrismaPg(poolConfig) })
  return { Prisma, db, pool, createSalesOrderRefund: refundService.createSalesOrderRefund, createReturnExpectationTx: expectation.createReturnExpectationTx }
}
type Rig = Awaited<ReturnType<typeof openRig>>

async function seed(rig: Rig, suffix: string) {
  const { Prisma, db } = rig
  const product = await db.product.create({ data: { sku: `RXC-${suffix}`, name: `rxc ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const main = await db.warehouse.create({ data: { code: `RM${suffix.slice(0, 8)}`, name: `rxc main ${suffix}` }, select: { id: true } })
  const returns = await db.warehouse.create({ data: { code: `RR${suffix.slice(0, 8)}`, name: `rxc returns ${suffix}` }, select: { id: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `RXC-${suffix.slice(0, 8)}`,
      status: 'SHIPPED',
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
          description: 'rxc line',
          qty: new Prisma.Decimal('2'),
          unitPriceForeign: new Prisma.Decimal('50'),
          unitPriceBase: new Prisma.Decimal('50'),
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
  await db.shipment.create({
    data: {
      orderId: order.id,
      warehouseId: main.id,
      status: 'SHIPPED',
      shippedAt: new Date(),
      lines: { create: [{ lineId, productId: product.id, qty: new Prisma.Decimal('2') }] },
    },
  })
  return { productId: product.id, mainId: main.id, returnsId: returns.id, orderId: order.id, lineId }
}

async function cleanup(rig: Rig, fx: Awaited<ReturnType<typeof seed>> | undefined) {
  await rig.db.setting.deleteMany({ where: { key: SWITCH } }).catch(() => {})
  if (!fx) return
  const { db } = rig
  await db.returnExpectationLine.deleteMany({ where: { expectation: { orderId: fx.orderId } } }).catch(() => {})
  await db.returnExpectation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
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

async function waitUntilBlockedBy(rig: Rig, holderPid: number, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { rows } = await rig.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND $1::int = ANY (pg_blocking_pids(pid))`,
      [holderPid],
    )
    if (rows[0].n > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

function refundInput(fx: Awaited<ReturnType<typeof seed>>, suffix: string, externalRefundId: number) {
  return {
    orderId: fx.orderId,
    lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'rxc line', qty: 1, totalBase: 50 }],
    reason: 'WooCommerce refund',
    returnWarehouseId: fx.returnsId,
    externalRefundId,
    creditNotePrefix: `RXC${suffix.slice(0, 6)}-`,
  }
}

async function observe(rig: Rig, fx: Awaited<ReturnType<typeof seed>>) {
  const { db } = rig
  const [refunds, expectations, movements, levels, layers] = await Promise.all([
    db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { id: true, returnInTransit: true, returnWarehouseId: true } }),
    db.returnExpectation.findMany({ where: { orderId: fx.orderId }, include: { lines: true } }),
    db.stockMovement.count({ where: { productId: fx.productId, type: 'RETURN_INBOUND' } }),
    db.stockLevel.count({ where: { productId: fx.productId, warehouseId: fx.returnsId } }),
    db.costLayer.count({ where: { productId: fx.productId, warehouseId: fx.returnsId } }),
  ])
  return { refunds, expectations, movements, levels, layers }
}

test(
  'return expectation: the first attempt and the retry creating it at once leave ONE document (the second waits on the per-refund lock, then adds nothing)',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    const rig = await openRig()
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    let fx: Awaited<ReturnType<typeof seed>> | undefined
    try {
      fx = await seed(rig, suffix)
      const seeded = fx
      const refund = await rig.db.salesOrderRefund.create({
        data: {
          orderId: seeded.orderId,
          totalForeign: new rig.Prisma.Decimal('50'),
          totalBase: new rig.Prisma.Decimal('50'),
          returnWarehouseId: seeded.returnsId,
          returnInTransit: true,
          lines: { create: [{ productId: seeded.productId, description: 'rxc', qty: new rig.Prisma.Decimal('1'), unitPriceBase: new rig.Prisma.Decimal('50'), totalBase: new rig.Prisma.Decimal('50') }] },
        },
        select: { id: true, lines: { select: { id: true } } },
      })
      const rows = [{ productId: seeded.productId, qty: 1, refundLineId: refund.lines[0].id, unitCostBase: '10' }]
      const params = { refundId: refund.id, orderId: seeded.orderId, creditNoteNumber: `RXC-${suffix}`, rows }

      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let firstHolds!: () => void
      const holding = new Promise<void>((resolve) => { firstHolds = resolve })
      let firstPid = 0
      const first = rig.db.$transaction(async (tx) => {
        firstPid = Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid)
        const result = await rig.createReturnExpectationTx(tx, params)
        firstHolds()
        await released
        return result
      }, { timeout: 60000, maxWait: 15000 })

      await holding
      const second = rig.db.$transaction((tx) => rig.createReturnExpectationTx(tx, params), { timeout: 60000, maxWait: 15000 })
      const blocked = await waitUntilBlockedBy(rig, firstPid)
      assert.equal(blocked, true, 'PRECONDITION: the second creator is parked behind the first (PostgreSQL reports a backend blocked by it)')
      assert.equal(await rig.db.returnExpectation.count({ where: { orderId: seeded.orderId } }), 0, 'PRECONDITION: nothing is visible while the first holds')
      release()
      const [a, b] = await Promise.all([first, second])

      assert.equal(a.outcome, 'created')
      assert.equal(b.outcome, 'existing', 'the second found the first one\'s document after waiting')
      assert.equal(b.expectationId, a.expectationId)
      const seen = await observe(rig, seeded)
      assert.equal(seen.expectations.length, 1)
      assert.equal(seen.expectations[0].lines.length, 1)
    } finally {
      await cleanup(rig, fx)
      await rig.db.$disconnect()
      await rig.pool.end()
    }
  },
)

test(
  'return expectation: with the switch ON a real refund commits a document and writes no movement, stock level or cost layer',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    const rig = await openRig()
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    let fx: Awaited<ReturnType<typeof seed>> | undefined
    try {
      fx = await seed(rig, suffix)
      const seeded = fx
      await rig.db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
      const result = await rig.createSalesOrderRefund(rig.db, refundInput(seeded, suffix, 3_000_000 + Math.floor(Math.random() * 900_000)))
      assert.equal(result.success, true, `refund must succeed (${result.success ? '' : result.error})`)
      assert.equal(result.success && result.returnedRows.length, 0)
      const seen = await observe(rig, seeded)
      assert.equal(seen.refunds.length, 1)
      assert.equal(seen.refunds[0].returnInTransit, true)
      assert.equal(seen.refunds[0].returnWarehouseId, seeded.returnsId)
      assert.equal(seen.expectations.length, 1, 'one document')
      assert.equal(seen.expectations[0].refundId, seen.refunds[0].id)
      assert.equal(seen.expectations[0].lines.length, 1)
      assert.equal(seen.expectations[0].lines[0].qty.toFixed(6), '1.000000')
      assert.equal(seen.movements, 0, 'no RETURN_INBOUND movement')
      assert.equal(seen.levels, 0, 'no stock level in the returns warehouse')
      assert.equal(seen.layers, 0, 'no cost layer')
    } finally {
      await cleanup(rig, fx)
      await rig.db.$disconnect()
      await rig.pool.end()
    }
  },
)

test(
  'return expectation (control): the identical refund with the switch OFF restocks and creates no document',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    const rig = await openRig()
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    let fx: Awaited<ReturnType<typeof seed>> | undefined
    try {
      fx = await seed(rig, suffix)
      const seeded = fx
      const result = await rig.createSalesOrderRefund(rig.db, refundInput(seeded, suffix, 4_000_000 + Math.floor(Math.random() * 900_000)))
      assert.equal(result.success, true, `refund must succeed (${result.success ? '' : result.error})`)
      const seen = await observe(rig, seeded)
      assert.equal(seen.refunds[0].returnInTransit, false)
      assert.equal(seen.expectations.length, 0)
      assert.equal(seen.movements, 1, 'restocked at refund time, as before')
      assert.equal(seen.levels, 1)
    } finally {
      await cleanup(rig, fx)
      await rig.db.$disconnect()
      await rig.pool.end()
    }
  },
)
