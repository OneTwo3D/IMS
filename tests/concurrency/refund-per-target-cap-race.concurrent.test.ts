import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-w00 (Codex r3 #2) — two hand-recorded refunds racing for the SAME order line, proven against a
 * real Postgres.
 *
 * The exception inbox's Record-manually action reads what each part of the order still has left to
 * refund, then calls createSalesOrderRefund. That read happens OUTSIDE the refund transaction, so two
 * quarantined refunds on one order can each see the same £100 line as fully refundable, each allocate
 * £100 to it, and then BOTH serialise successfully — because the only check taken under the order lock
 * was the order-wide ceiling, and on a £200-net order 100 + 100 fits. The line is credited twice while
 * the other line is never credited at all: right total, wrong account, wrong VAT identity.
 *
 * The fix re-takes the per-target balances inside createSalesOrderRefund, after `lockSalesOrder`
 * (`SELECT ... FOR UPDATE` on the sales_orders row, held to COMMIT). The loser blocks on the winner and
 * then — under READ COMMITTED, where each statement takes a fresh snapshot — reads the refund line the
 * winner just committed, and refuses.
 *
 * WHY THIS CANNOT BE A UNIT TEST: the property is the VISIBILITY of an uncommitted refund line across
 * two database sessions. The in-memory client in tests/domain/sales/refund-service.test.ts runs its
 * "transactions" sequentially and never blocks, so it can pin the decision but not the race that makes
 * the decision necessary.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
test(
  'o3d-w00: two concurrent recordings against ONE order line credit it exactly once',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })

    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
    if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
      throw new Error('This concurrency test requires a Postgres DATABASE_URL')
    }

    const [{ Prisma, PrismaClient }, { PrismaPg }, { default: pg }, { createSalesOrderRefund }] = await Promise.all([
      import('@/app/generated/prisma/client'),
      import('@prisma/adapter-pg'),
      import('pg'),
      import('@/lib/domain/sales/refund-service'),
    ])

    // max: 4 — the two contenders must hold connections SIMULTANEOUSLY; a pool of 1 would serialise them
    // at the pool instead of at the database and prove nothing. Config form, not `new PrismaPg(pool)`
    // (o3d-4ajo): a duplicate `pg` copy fails the adapter's instanceof check and the Pool is treated as
    // the config, surfacing far away as a pg startup TypeError.
    const poolConfig = { connectionString: databaseUrl, max: 4 }
    const pool = new pg.Pool(poolConfig)
    const db = new PrismaClient({ adapter: new PrismaPg(poolConfig) })

    const suffix = randomUUID()
    let orderId: string | undefined
    let taxRateId: string | undefined

    try {
      taxRateId = (await db.taxRate.create({
        data: {
          name: `TGT-VAT-${suffix.slice(0, 6)}`,
          rate: new Prisma.Decimal('0.2'),
          accountingTaxType: 'OUTPUT2',
          reverseCharge: false,
        },
        select: { id: true },
      })).id

      // A COHERENT order: two £100-net lines at 20%, gross 240 (net 200 + 40 VAT). The order-wide
      // ceiling is 200, so two £100 refunds both fit under it — which is exactly why the ceiling alone
      // cannot stop them landing on the SAME line.
      const order = await db.salesOrder.create({
        data: {
          orderNumber: `TGT-${suffix.slice(0, 8)}`,
          status: 'SHIPPED',
          currency: 'GBP',
          fxRateToBase: new Prisma.Decimal('1'),
          subtotalForeign: new Prisma.Decimal('200'),
          totalForeign: new Prisma.Decimal('240'),
          subtotalBase: new Prisma.Decimal('200'),
          taxForeign: new Prisma.Decimal('40'),
          taxBase: new Prisma.Decimal('40'),
          shippingForeign: new Prisma.Decimal('0'),
          totalBase: new Prisma.Decimal('240'),
          pricesIncludeVat: false,
          taxRatePercent: new Prisma.Decimal('0.2'),
          lines: {
            create: [
              {
                description: 'Widget',
                qty: new Prisma.Decimal('1'),
                unitPriceForeign: new Prisma.Decimal('100'),
                unitPriceBase: new Prisma.Decimal('100'),
                taxForeign: new Prisma.Decimal('20'),
                taxBase: new Prisma.Decimal('20'),
                totalForeign: new Prisma.Decimal('100'),
                totalBase: new Prisma.Decimal('100'),
                taxRateId,
              },
              {
                description: 'Gadget',
                qty: new Prisma.Decimal('1'),
                unitPriceForeign: new Prisma.Decimal('100'),
                unitPriceBase: new Prisma.Decimal('100'),
                taxForeign: new Prisma.Decimal('20'),
                taxBase: new Prisma.Decimal('20'),
                totalForeign: new Prisma.Decimal('100'),
                totalBase: new Prisma.Decimal('100'),
                taxRateId,
              },
            ],
          },
        },
        select: { id: true, lines: { select: { id: true, description: true }, orderBy: { description: 'asc' } } },
      })
      orderId = order.id
      const widgetLineId = order.lines.find((line) => line.description === 'Widget')!.id

      // Two DISTINCT WooCommerce refund ids — the real shape: two separate quarantined parks on one
      // order, each hand-recorded against the same line. Distinct ids mean the externalRefundId replay
      // path and the per-refund advisory lock cannot be what serialises them.
      const baseExternalId = Number.parseInt(suffix.replace(/\D/g, '').slice(0, 7), 10)
      const record = (externalRefundId: number) => createSalesOrderRefund(db, {
        orderId: order.id,
        lines: [{
          lineId: widgetLineId,
          productId: null,
          description: 'Widget refund',
          qty: 0,
          totalForeign: 100,
          totalBase: 100,
          lineKind: 'sale',
        }],
        reason: `hand-recorded ${externalRefundId}`,
        externalRefundId,
        creditNotePrefix: `CNTGT${suffix.slice(0, 6)}-`,
        enforcePerTargetBalances: true,
      })

      const results = await Promise.all([record(baseExternalId), record(baseExternalId + 1)])

      const refundLines = await db.salesOrderRefundLine.findMany({
        where: { refund: { orderId: order.id }, salesOrderLineId: widgetLineId },
        select: { totalForeign: true },
      })
      const creditedToWidget = refundLines.reduce((sum, line) => sum + Number(line.totalForeign), 0)
      const verdicts = results
        .map((result, index) => `#${index}=${result.success ? 'created' : `refused(${result.success === false ? result.error : ''})`}`)
        .join(' | ')

      assert.equal(
        creditedToWidget, 100,
        `the £100 line may be credited exactly once, got ${creditedToWidget} — ${verdicts}`,
      )
      assert.equal(results.filter((result) => result.success).length, 1, `exactly one recording may land — ${verdicts}`)
      const loser = results.find((result) => !result.success)
      assert.ok(loser && loser.success === false, 'the other must be refused, not throw')
      assert.match(
        loser.success === false ? loser.error : '',
        /more than it has left to refund/,
        'and refused for the reason that is true: the line has nothing left',
      )
    } finally {
      if (orderId) {
        await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } }).catch(() => {})
        await db.salesOrderRefund.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrderLine.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrder.delete({ where: { id: orderId } }).catch(() => {})
      }
      if (taxRateId) {
        await db.taxRate.delete({ where: { id: taxRateId } }).catch(() => {})
      }
      await db.$disconnect()
      await pool.end()
    }
  },
)
