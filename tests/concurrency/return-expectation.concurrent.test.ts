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
      lines: { create: [{ lineId, productId: product.id, qty: new Prisma.Decimal('2'), costLayerSnapshot: [{ costLayerId: 'retexp-issued-layer', qty: '2', unitCostBase: '40' }] }] },
    },
  })
  return { productId: product.id, mainId: main.id, returnsId: returns.id, orderId: order.id, lineId }
}

async function cleanup(rig: Rig, fx: Awaited<ReturnType<typeof seed>> | undefined) {
  await rig.db.setting.deleteMany({ where: { key: SWITCH } }).catch(() => {})
  if (!fx) return
  const { db } = rig
  await db.salesOrderRefundInboxAdoption.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
  await db.wmsReturnsInbox.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
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
      const params = { valued: true, refundId: refund.id, orderId: seeded.orderId, creditNoteNumber: `RXC-${suffix}`, rows }

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
      assert.ok(seen.expectations[0].valuedAt, 'no accounting staging to follow, so it was valued in the refund transaction')
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

test(
  'return expectation (o3d-iil0b): a refund ADOPTS a returns-inbox arrival already restocked for that order and product: it links, and books no expectation, movement or transit debit; the next refund, with nothing left to adopt, routes in transit',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    const rig = await openRig()
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    let fx: Awaited<ReturnType<typeof seed>> | undefined
    try {
      fx = await seed(rig, suffix)
      const seeded = fx
      await rig.db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
      // The warehouse booked the return first: a RESTOCKED inbox row and its RETURN_INBOUND movement for one unit.
      const inbox = await rig.db.wmsReturnsInbox.create({
        data: { connector: 'mintsoft', externalReturnId: `rxc-${suffix}`, orderId: seeded.orderId, productId: seeded.productId, qty: new rig.Prisma.Decimal('1'), warehouseId: seeded.returnsId, status: 'RESTOCKED' },
        select: { id: true },
      })
      await rig.db.stockMovement.create({
        data: { type: 'RETURN_INBOUND', productId: seeded.productId, toWarehouseId: seeded.returnsId, qty: new rig.Prisma.Decimal('1'), referenceType: 'WmsReturnsInbox', referenceId: inbox.id, unitCostBase: new rig.Prisma.Decimal('40'), totalValueBase: new rig.Prisma.Decimal('40') },
      })
      const first = await rig.createSalesOrderRefund(rig.db, refundInput(seeded, suffix, 5_000_000 + Math.floor(Math.random() * 900_000)))
      assert.equal(first.success, true, `refund must succeed (${first.success ? '' : first.error})`)
      const adopted = await rig.db.salesOrderRefund.findFirstOrThrow({ where: { orderId: seeded.orderId }, select: { id: true, returnInTransit: true, returnWarehouseId: true } })
      const links = await rig.db.salesOrderRefundInboxAdoption.findMany({ where: { refundId: adopted.id }, select: { inboxId: true, qty: true } })
      assert.deepEqual(links.map((l) => [l.inboxId, Number(l.qty)]), [[inbox.id, 1]], 'linked to the arrival, per inbox row and quantity')
      assert.equal(adopted.returnInTransit, false)
      assert.equal(adopted.returnWarehouseId, null)
      let seen = await observe(rig, seeded)
      assert.equal(seen.expectations.length, 0, 'no new return expectation')
      assert.equal(seen.movements, 1, 'only the warehouse\'s own RETURN_INBOUND: the refund booked no second stock-in')
      assert.equal(await rig.db.activityLog.count({ where: { entityId: seeded.orderId, action: 'refund_adopted_returns_inbox' } }), 1)

      // CONTROL: the arrival is used up, so a second refund adopts nothing and routes its goods in transit as before.
      const second = await rig.createSalesOrderRefund(rig.db, refundInput(seeded, suffix, 5_900_000 + Math.floor(Math.random() * 90_000)))
      assert.equal(second.success, true, `refund must succeed (${second.success ? '' : second.error})`)
      seen = await observe(rig, seeded)
      assert.equal(seen.expectations.length, 1, 'the unadopted refund keeps its expectation')
      assert.equal(seen.refunds.filter((r) => r.returnInTransit).length, 1)
    } finally {
      await cleanup(rig, fx)
      await rig.db.$disconnect()
      await rig.pool.end()
    }
  },
)

// o3d-iil0b follow-up: adoption counts EVERY claim on an arrival, per inbox row and quantity, under the order lock.
async function addRestockedArrival(rig: Rig, fx: Awaited<ReturnType<typeof seed>>, suffix: string, qty: string, tag: string) {
  const inbox = await rig.db.wmsReturnsInbox.create({
    data: { connector: 'mintsoft', externalReturnId: `rxc-${tag}-${suffix}`, orderId: fx.orderId, productId: fx.productId, qty: new rig.Prisma.Decimal(qty), warehouseId: fx.returnsId, status: 'RESTOCKED' },
    select: { id: true },
  })
  await rig.db.stockMovement.create({
    data: { type: 'RETURN_INBOUND', productId: fx.productId, toWarehouseId: fx.returnsId, qty: new rig.Prisma.Decimal(qty), referenceType: 'WmsReturnsInbox', referenceId: inbox.id, unitCostBase: new rig.Prisma.Decimal('40'), totalValueBase: new rig.Prisma.Decimal('40').mul(qty) },
  })
  return inbox.id
}

const adoptionTest = { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' }

test('return expectation (o3d-iil0b): an arrival an expectation already received is NOT adopted by the next refund', adoptionTest, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix)
    await rig.db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
    // Refund 1 (no arrival yet) routes its unit in transit: an expectation.
    const first = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, 6_000_000 + Math.floor(Math.random() * 90_000)))
    assert.equal(first.success, true, first.success ? '' : first.error)
    // The unit then arrives and the arrival is matched to that expectation (what the restock does): the inbox row is RESTOCKED and the expectation line is received.
    await addRestockedArrival(rig, fx, suffix, '1', 'matched')
    await rig.db.returnExpectationLine.updateMany({ where: { expectation: { orderId: fx.orderId } }, data: { qtyReceived: new rig.Prisma.Decimal('1') } })
    // Refund 2 must not adopt that arrival: it already belongs to refund 1's expectation.
    const second = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, 6_100_000 + Math.floor(Math.random() * 90_000)))
    assert.equal(second.success, true, second.success ? '' : second.error)
    assert.equal(await rig.db.salesOrderRefundInboxAdoption.count({ where: { refund: { orderId: fx.orderId } } }), 0, 'nothing adopted')
    assert.equal((await rig.db.returnExpectation.count({ where: { orderId: fx.orderId } })), 2, 'the second refund keeps its own expectation')
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('return expectation (o3d-iil0b): two refunds racing for ONE arrival: exactly one adopts it', adoptionTest, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix)
    await rig.db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
    const inboxId = await addRestockedArrival(rig, fx, suffix, '1', 'race')
    const [a, b] = await Promise.all([
      rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, 6_200_000 + Math.floor(Math.random() * 90_000))),
      rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, 6_300_000 + Math.floor(Math.random() * 90_000))),
    ])
    assert.equal(a.success, true, a.success ? '' : a.error)
    assert.equal(b.success, true, b.success ? '' : b.error)
    const adoptions = await rig.db.salesOrderRefundInboxAdoption.findMany({ where: { inboxId }, select: { qty: true } })
    assert.equal(adoptions.length, 1, 'the arrival is adopted once')
    assert.equal(adoptions.reduce((sum, r) => sum + Number(r.qty), 0), 1)
    assert.equal(await rig.db.returnExpectation.count({ where: { orderId: fx.orderId } }), 1, 'the other refund routed its unit in transit')
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('return expectation (o3d-iil0b): partial quantities are consumed per inbox row; a refund the remainder cannot cover adopts nothing', adoptionTest, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix)
    await rig.db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
    const inboxId = await addRestockedArrival(rig, fx, suffix, '1.5', 'partial')
    const first = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, 6_400_000 + Math.floor(Math.random() * 90_000)))
    assert.equal(first.success, true, first.success ? '' : first.error)
    const rows = await rig.db.salesOrderRefundInboxAdoption.findMany({ where: { inboxId }, select: { qty: true } })
    assert.deepEqual(rows.map((r) => Number(r.qty)), [1], 'one unit of the 1.5 consumed')
    // 0.5 is left: a refund of one more unit is not fully covered, so it adopts nothing and keeps today\'s behaviour (an expectation).
    const second = await rig.createSalesOrderRefund(rig.db, refundInput(fx, suffix, 6_500_000 + Math.floor(Math.random() * 90_000)))
    assert.equal(second.success, true, second.success ? '' : second.error)
    assert.equal(await rig.db.salesOrderRefundInboxAdoption.count({ where: { inboxId } }), 1)
    assert.equal(await rig.db.returnExpectation.count({ where: { orderId: fx.orderId } }), 1)
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})

test('return expectation (o3d-iil0b round 1): a PARTLY SHIPPED storefront refund adopts the units it would return (the shipped one), not every refund line', adoptionTest, async () => {
  const rig = await openRig()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  let fx: Awaited<ReturnType<typeof seed>> | undefined
  try {
    fx = await seed(rig, suffix)
    await rig.db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
    // Only ONE of the two units shipped; the shipped unit came back and the warehouse restocked it.
    await rig.db.shipmentLine.updateMany({ where: { shipment: { orderId: fx.orderId } }, data: { qty: new rig.Prisma.Decimal('1'), costLayerSnapshot: [{ costLayerId: 'retexp-issued-layer', qty: '1', unitCostBase: '40' }] } })
    const inboxId = await addRestockedArrival(rig, fx, suffix, '1', 'partship')
    // The storefront refunds BOTH units. Sized from every refund line (2) the arrival (1) would not cover it; sized from the units that shipped (1) it does.
    const result = await rig.createSalesOrderRefund(rig.db, { ...refundInput(fx, suffix, 6_600_000 + Math.floor(Math.random() * 90_000)), lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'rxc line', qty: 2, totalBase: 100 }] })
    assert.equal(result.success, true, result.success ? '' : result.error)
    const links = await rig.db.salesOrderRefundInboxAdoption.findMany({ where: { inboxId }, select: { qty: true } })
    assert.deepEqual(links.map((l) => Number(l.qty)), [1], 'the shipped unit is adopted')
    assert.equal(await rig.db.returnExpectation.count({ where: { orderId: fx.orderId } }), 0, 'no expectation on top of the inbox restock (no double count)')
  } finally {
    await cleanup(rig, fx)
    await rig.db.$disconnect()
    await rig.pool.end()
  }
})
