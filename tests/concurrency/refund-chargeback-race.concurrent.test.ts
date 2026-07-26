import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-6oyu.18 — the concurrent double-reversal race, proven against a real Postgres.
 *
 * Two independent paths raise a credit note for one sales order:
 *   - the WooCommerce refund webhook  (createSalesOrderRefund with an externalRefundId)
 *   - the Xero payment poller's chargeback (createSalesOrderRefund with chargeback: true)
 *
 * Both pre-check "has this order already been reversed?" OUTSIDE the refund transaction —
 * raiseChargebackForReversedOrder's prior-refund read and the poller's window-scoped
 * wasHandledByRecentWcRefund. Neither can see the other path's UNCOMMITTED row, so when a
 * Xero payment removal and a WC refund land inside one poll cycle both pre-checks pass and
 * both post a credit note. The order is then reversed twice.
 *
 * The guard is transactional, not a unique index: SalesOrderRefund is legitimately
 * many-per-order (partial refunds) and the two racing rows differ in
 * `chargeback`/`externalRefundId`, so no uniqueness key collides. Instead the decision is
 * re-taken inside createSalesOrderRefund's transaction, which already holds
 * pg_advisory_xact_lock(REFUND_ACCOUNTING_LOCK_KEY) and `SELECT ... FOR UPDATE` on the
 * sales_orders row. Both are held to COMMIT, so the loser BLOCKS on the winner and then —
 * under READ COMMITTED, where each statement takes a fresh snapshot — reads the row the
 * winner just committed and refuses cleanly with a `conflict`.
 *
 * WHY THIS CANNOT BE A UNIT TEST: the whole property under test is the VISIBILITY of an
 * uncommitted row across two real database sessions. The in-memory client in
 * tests/domain/sales/refund-service.test.ts runs its "transactions" sequentially and its
 * statements never block, so it can pin the decision but can never reproduce the race that
 * makes the decision necessary. Only a real Postgres can.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
test(
  'o3d-6oyu.18: overlapping WC refund + poller chargeback produce exactly ONE credit note',
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

    // max: 4 — the two contenders must hold connections SIMULTANEOUSLY. A pool of 1 would
    // serialize them at the pool instead of at the database and prove nothing.
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    const db = new PrismaClient({ adapter: new PrismaPg(pool) })

    const suffix = randomUUID()
    let orderId: string | undefined
    let taxRateId: string | undefined

    try {
      // A minimal VAT-INCLUSIVE order: gross total 120 (net 100 + 20 VAT). The gross basis
      // matters — it is why createSalesOrderRefund's refund-total cap does NOT catch this
      // race on its own: the chargeback's NET 100 plus a 10 WC refund still fit under 120.
      // The order needs a LINE carrying a tax identity, not just an order-level taxRatePercent.
      // o3d-w00 #5 derives tax uniformity from `so.lines` — every line must share one non-null
      // accountingTaxType and none may be reverse-charged — and a monetary-only refund is refused
      // outright unless that holds, because an unattributable amount cannot be posted under a tax
      // identity the order does not have.
      //
      // A lineless order makes that set EMPTY, so `size === 1` is false and every monetary-only
      // refund fails closed. This fixture was lineless, so once o3d-w00 merged BOTH racers were
      // refused and the test saw zero credit notes instead of exactly one — failing for a reason
      // that has nothing to do with the race it exists to pin.
      taxRateId = (await db.taxRate.create({
        data: {
          name: `RACE-VAT-${suffix.slice(0, 6)}`,
          rate: new Prisma.Decimal('0.2'),
          accountingTaxType: 'OUTPUT2',
          reverseCharge: false,
        },
        select: { id: true },
      })).id

      const order = await db.salesOrder.create({
        data: {
          orderNumber: `RACE-${suffix.slice(0, 8)}`,
          status: 'SHIPPED',
          currency: 'GBP',
          fxRateToBase: new Prisma.Decimal('1'),
          subtotalForeign: new Prisma.Decimal('100'),
          totalForeign: new Prisma.Decimal('120'),
          subtotalBase: new Prisma.Decimal('100'),
          taxBase: new Prisma.Decimal('20'),
          totalBase: new Prisma.Decimal('120'),
          pricesIncludeVat: true,
          taxRatePercent: new Prisma.Decimal('0.2'),
          lines: {
            create: [{
              description: 'Race fixture line',
              qty: new Prisma.Decimal('1'),
              unitPriceForeign: new Prisma.Decimal('100'),
              unitPriceBase: new Prisma.Decimal('100'),
              taxForeign: new Prisma.Decimal('20'),
              taxBase: new Prisma.Decimal('20'),
              totalForeign: new Prisma.Decimal('120'),
              totalBase: new Prisma.Decimal('120'),
              taxRateId,
            }],
          },
        },
        select: { id: true },
      })
      orderId = order.id

      // Monetary-only refund lines (null product, qty 0) keep this test on the guard itself —
      // no stock, cost layers or accounting staging. revenueDeferredDate is null, so
      // createSalesOrderRefund skips the accounting reversal path entirely.
      const chargeback = createSalesOrderRefund(db, {
        orderId: order.id,
        lines: [{ lineId: null, productId: null, description: 'Payment reversed (chargeback)', qty: 0, totalBase: 100, lineKind: 'sale' }],
        reason: 'Payment reversed (chargeback)',
        creditNotePrefix: `CNRACE${suffix.slice(0, 6)}-`,
        chargeback: true,
      })
      const wcRefund = createSalesOrderRefund(db, {
        orderId: order.id,
        lines: [{ lineId: null, productId: null, description: 'WooCommerce refund', qty: 0, totalBase: 10, lineKind: 'sale' }],
        reason: 'WooCommerce refund',
        externalRefundId: Number.parseInt(suffix.replace(/\D/g, '').slice(0, 8), 10),
        creditNotePrefix: `CNRACE${suffix.slice(0, 6)}-`,
      })

      const [chargebackResult, wcResult] = await Promise.all([chargeback, wcRefund])
      const results = [chargebackResult, wcResult]

      // THE assertion: whichever ordering the database picked, only one credit note exists.
      const refunds = await db.salesOrderRefund.findMany({
        where: { orderId: order.id },
        select: { id: true, chargeback: true, externalRefundId: true },
      })
      assert.equal(refunds.length, 1, `expected exactly one credit note, got ${refunds.length} — the order was double-reversed`)

      // And the loser failed CLEANLY: a typed `conflict`, never a raw error the operator has
      // to clear and never a dead-lettered sync.
      const winners = results.filter((result) => result.success)
      const losers = results.filter((result) => !result.success)
      assert.equal(winners.length, 1, 'exactly one path may create the credit note')
      assert.equal(losers.length, 1, 'the other path must be refused, not throw')
      const loser = losers[0]
      assert.equal(loser.success, false)
      const conflict = loser.success === false ? loser.conflict : undefined
      assert.ok(
        conflict === 'prior-refund' || conflict === 'prior-chargeback',
        `loser must carry a typed conflict, got ${String(conflict)}`,
      )
      // The conflict must match who actually won.
      assert.equal(
        conflict,
        refunds[0]?.chargeback ? 'prior-chargeback' : 'prior-refund',
        'the conflict must name the path that committed first',
      )
    } finally {
      if (orderId) {
        // No allocations and no unmatched lines on this fixture, so neither refund outbox
        // backstop is enqueued — nothing else to clean up.
        await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } }).catch(() => {})
        await db.salesOrderRefund.deleteMany({ where: { orderId } }).catch(() => {})
        // Lines first: the order cascade may not cover them, and the tax rate cannot go while a
        // line still references it.
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
