import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * An operator-typed refund is cut from the order line's REMAINING stored value under the order lock, and a line can never be refunded
 * above its stored net, proven against a real Postgres.
 *
 * A line of 100 units worth 0.50 refunded one unit at a time: pro-rating the original net would round 0.005 up to 0.01 on every refund and
 * credit 1.00. Cut from what is left, with the last unit taking the remainder, the 100 refunds (four at a time, so they contend for the
 * order lock) credit exactly 0.50; the 101st is refused, and so is a price-only refund above what the line has left.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
test(
  'a line refunded 100 times, four at a time, credits exactly its stored net; one more, or an over-ceiling amount, is refused',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, { createSalesOrderRefund }] = await Promise.all([
      import('@/app/generated/prisma/client'),
      import('@prisma/adapter-pg'),
      import('pg'),
      import('@/lib/domain/sales/refund-service'),
    ])
    const poolConfig = { connectionString: databaseUrl, max: 6 }
    const pool = new pg.Pool(poolConfig)
    const db = new PrismaClient({ adapter: new PrismaPg(poolConfig) })
    const suffix = randomUUID()
    let orderId: string | undefined

    try {
      const order = await db.salesOrder.create({
        data: {
          orderNumber: `NET-${suffix.slice(0, 8)}`,
          status: 'SHIPPED',
          currency: 'GBP',
          fxRateToBase: new Prisma.Decimal('1'),
          subtotalForeign: new Prisma.Decimal('0.5'),
          totalForeign: new Prisma.Decimal('0.5'),
          subtotalBase: new Prisma.Decimal('0.5'),
          taxForeign: new Prisma.Decimal('0'),
          taxBase: new Prisma.Decimal('0'),
          shippingForeign: new Prisma.Decimal('0'),
          totalBase: new Prisma.Decimal('0.5'),
          pricesIncludeVat: false,
          lines: {
            create: [{
              description: 'Tiny',
              qty: new Prisma.Decimal('100'),
              unitPriceForeign: new Prisma.Decimal('0.005'),
              unitPriceBase: new Prisma.Decimal('0.005'),
              taxForeign: new Prisma.Decimal('0'),
              taxBase: new Prisma.Decimal('0'),
              totalForeign: new Prisma.Decimal('0.5'),
              totalBase: new Prisma.Decimal('0.5'),
            }],
          },
        },
        select: { id: true, lines: { select: { id: true } } },
      })
      orderId = order.id
      const lineId = order.lines[0].id

      const refundOne = (n: number) => createSalesOrderRefund(db, {
        orderId: order.id,
        // The stated figure is a preview only: a stale or hostile 99 changes nothing.
        lines: [{ lineId, productId: null, description: 'Tiny', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' }],
        reason: `partial ${n}`,
        creditNotePrefix: `CNNET${suffix.slice(0, 6)}-`,
        enforcePerTargetBalances: true,
        deriveSaleLineNetsFromStoredBalance: true,
      })

      for (let batch = 0; batch < 25; batch += 1) {
        const results = await Promise.all([0, 1, 2, 3].map((i) => refundOne(batch * 4 + i)))
        for (const result of results) assert.equal(result.success, true, result.success ? '' : result.error)
      }

      const rows = await db.salesOrderRefundLine.findMany({ where: { refund: { orderId: order.id }, salesOrderLineId: lineId }, select: { totalForeign: true, totalBase: true } })
      assert.equal(rows.length, 100)
      const sumForeign = rows.reduce((s, r) => s.add(r.totalForeign), new Prisma.Decimal(0))
      const sumBase = rows.reduce((s, r) => s.add(r.totalBase), new Prisma.Decimal(0))
      assert.equal(sumForeign.toFixed(4), '0.5000', 'the line is credited exactly its stored net, in the foreign column')
      assert.equal(sumBase.toFixed(4), '0.5000', 'and in the base column')

      const extra = await refundOne(101)
      assert.equal(extra.success, false, 'the 101st unit does not exist')
      const overCeiling = await createSalesOrderRefund(db, {
        orderId: order.id,
        lines: [{ lineId, productId: null, description: 'Tiny', qty: 0, totalForeign: 0.1, totalBase: 0.1, lineKind: 'sale' }],
        reason: 'above the ceiling',
        creditNotePrefix: `CNNET${suffix.slice(0, 6)}-`,
        enforcePerTargetBalances: true,
        deriveSaleLineNetsFromStoredBalance: true,
      })
      assert.equal(overCeiling.success, false)
      assert.match(overCeiling.success === false ? overCeiling.error : '', /more than it has left to refund|exceed/)
      assert.equal(await db.salesOrderRefundLine.count({ where: { refund: { orderId: order.id } } }), 100, 'nothing was written by the refusals')
    } finally {
      if (orderId) {
        await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } }).catch(() => {})
        await db.salesOrderRefund.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrderLine.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrder.delete({ where: { id: orderId } }).catch(() => {})
      }
      await db.$disconnect()
      await pool.end()
    }
  },
)
