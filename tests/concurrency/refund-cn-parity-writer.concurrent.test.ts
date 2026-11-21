import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-k26m.17: the refund WRITER stores what the storefront refund sync established under `wc_refund_credit_note_parity_enabled`, against a real Postgres.
 *   - a store-credit refund is numbered SC-<WooCommerce refund id> (o3d-store-credit-refund 1.1.9) instead of minting one, and marked store_credit_refund;
 *   - the EAS fee gap is recorded (eas_fee_gap_foreign, storefront_amount_foreign);
 *   - a refund with no storefront id ignores the facts (an operator refund cannot claim to be store credit).
 * Synthetic orders only. Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
test(
  'the refund writer numbers a store-credit refund SC-<refund id>, records the EAS fee gap, and ignores both on a non-storefront refund',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
    const [{ Prisma, PrismaClient }, { PrismaPg }, { createSalesOrderRefund }] = await Promise.all([
      import('@/app/generated/prisma/client'),
      import('@prisma/adapter-pg'),
      import('@/lib/domain/sales/refund-service'),
    ])
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 4 }) })
    const sfx = randomUUID().slice(0, 8)
    const orderIds: string[] = []
    // Storefront refund ids no other file uses: a WooCommerce refund id is globally unique on sales_order_refunds.
    const base = 900_000_000 + Math.floor(Math.random() * 90_000_000)
    let rateId: string | null = null
    try {
      const rate = await db.taxRate.create({ data: { name: `PAR-Z-${sfx}`, rate: '0', accountingTaxType: `PARZ-${sfx}`, countryCode: 'ZZ' }, select: { id: true, name: true } })
      rateId = rate.id
      const mkOrder = async () => {
        const o = await db.salesOrder.create({
          data: {
            orderNumber: `PAR-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'), pricesIncludeVat: false, taxRateName: rate.name, taxRatePercent: new Prisma.Decimal('0'),
            subtotalForeign: new Prisma.Decimal('100'), subtotalBase: new Prisma.Decimal('100'), taxForeign: new Prisma.Decimal('0'), taxBase: new Prisma.Decimal('0'),
            totalForeign: new Prisma.Decimal('100'), totalBase: new Prisma.Decimal('100'),
            // One zero-rated line, so the order is uniformly taxed and a money-only refund of it is determinable (gross is net).
            lines: { create: [{ description: 'l', qty: new Prisma.Decimal('1'), unitPriceForeign: new Prisma.Decimal('100'), unitPriceBase: new Prisma.Decimal('100'), taxForeign: new Prisma.Decimal('0'), taxBase: new Prisma.Decimal('0'), totalForeign: new Prisma.Decimal('100'), totalBase: new Prisma.Decimal('100'), taxRateId: rate.id }] },
          },
          select: { id: true },
        })
        orderIds.push(o.id)
        return o.id
      }
      const refund = (orderId: string, externalRefundId: number | undefined, refundParity: Record<string, unknown>) => createSalesOrderRefund(db, {
        orderId, lines: [{ productId: null, description: 'money', qty: 0, totalForeign: 20.86, totalBase: 20.86, lineKind: 'sale' }],
        reason: 'parity', creditNotePrefix: `CNPAR${sfx}-`, ...(externalRefundId !== undefined ? { externalRefundId, refundedViaGateway: false } : {}), refundParity,
      })
      const read = (orderId: string) => db.salesOrderRefund.findFirst({ where: { orderId }, select: { creditNoteNumber: true, storeCreditRefund: true, easFeeGapForeign: true, storefrontAmountForeign: true } })

      const sc = await mkOrder()
      const r1 = await refund(sc, base + 1, { storeCreditRefund: true })
      assert.equal(r1.success, true, r1.success ? '' : r1.error)
      const scRow = await read(sc)
      assert.equal(scRow?.creditNoteNumber, `SC-${base + 1}`)
      assert.equal(scRow?.storeCreditRefund, true)
      assert.equal(scRow?.easFeeGapForeign, null)

      const gap = await mkOrder()
      const r2 = await refund(gap, base + 2, { easFeeGapForeign: 3, storefrontAmountForeign: 17.86 })
      assert.equal(r2.success, true, r2.success ? '' : r2.error)
      const gapRow = await read(gap)
      assert.equal(gapRow?.storeCreditRefund, false)
      assert.doesNotMatch(gapRow?.creditNoteNumber ?? '', /^SC-/, 'minted as usual')
      assert.equal(Number(gapRow?.easFeeGapForeign), 3)
      assert.equal(Number(gapRow?.storefrontAmountForeign), 17.86)

      const manual = await mkOrder()
      const r3 = await refund(manual, undefined, { storeCreditRefund: true, easFeeGapForeign: 3, storefrontAmountForeign: 17.86 })
      assert.equal(r3.success, true, r3.success ? '' : r3.error)
      const manualRow = await read(manual)
      assert.doesNotMatch(manualRow?.creditNoteNumber ?? '', /^SC-/)
      assert.equal(manualRow?.storeCreditRefund, false)
      assert.equal(manualRow?.easFeeGapForeign, null)
      assert.equal(manualRow?.storefrontAmountForeign, null)
    } finally {
      for (const orderId of orderIds) {
        await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } }).catch(() => {})
        await db.salesOrderRefund.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrderLine.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrder.delete({ where: { id: orderId } }).catch(() => {})
      }
      if (rateId) await db.taxRate.delete({ where: { id: rateId } }).catch(() => {})
      await db.$disconnect()
    }
  },
)
