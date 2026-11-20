import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * A refund of a DISCOUNTED MIXED-RATE ORDER whose discount tax was apportioned across its line rates (SalesOrder.discountTaxSplit) credits the right VAT per rate, proven against a real Postgres.
 *
 * One order: 100 net at 20%, 100 at 5%, 100 at 0%, shipping 10 at 20%, a 60 discount split 20 / 20 / 20 (VAT 4 / 1 / 0): the order carries 25 + 2 - 5 = 22 of VAT. Refunding the 5% line reverses
 * ITS 20 of discount on its own rate's code (not the header 20% code: that would credit 4 of VAT for 1); refunding the other two completes the order and the discount lines add up to the 60 the invoice posted,
 * each under its rate's code, and the credit notes' VAT per rate is the order's. A header-rate order (no split) keeps the single discount line at the order default code.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */
test(
  'refunding a 20% / 5% / 0% discounted order reverses the discount per rate, under each rate\'s own tax code',
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
    const rateIds: string[] = []
    try {
      const mkRate = async (key: string, rate: string) => {
        const r = await db.taxRate.create({ data: { name: `RD-${key}-${sfx}`, rate, accountingTaxType: `RDOUT-${key}-${sfx}`, countryCode: 'ZZ' }, select: { id: true, name: true, accountingTaxType: true } })
        rateIds.push(r.id)
        return { ...r, accountingTaxType: r.accountingTaxType as string }
      }
      const [a, b, c] = [await mkRate('A', '0.2'), await mkRate('B', '0.05'), await mkRate('C', '0')]
      const entry = (r: { id: string; accountingTaxType: string }, rate: number, tax: number) => ({ taxRateId: r.id, accountingTaxType: r.accountingTaxType, reverseCharge: false, rate, netForeign: 20, taxForeign: tax, netBase: 20, taxBase: tax })
      const mkOrder = async (split: unknown) => {
        const line = (r: { id: string }, tax: string) => ({ description: 'l', qty: new Prisma.Decimal('1'), unitPriceForeign: new Prisma.Decimal('100'), unitPriceBase: new Prisma.Decimal('100'), taxForeign: new Prisma.Decimal(tax), taxBase: new Prisma.Decimal(tax), totalForeign: new Prisma.Decimal('100'), totalBase: new Prisma.Decimal('100'), taxRateId: r.id })
        const o = await db.salesOrder.create({
          data: {
            orderNumber: `RD-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'), pricesIncludeVat: false, taxRateName: a.name, taxRatePercent: new Prisma.Decimal('0.2'),
            subtotalForeign: new Prisma.Decimal('300'), shippingForeign: new Prisma.Decimal('10'), shippingBase: new Prisma.Decimal('10'), discountAmount: new Prisma.Decimal('60'),
            taxForeign: new Prisma.Decimal('22'), taxBase: new Prisma.Decimal('22'), totalForeign: new Prisma.Decimal('272'), totalBase: new Prisma.Decimal('272'), subtotalBase: new Prisma.Decimal('300'),
            ...(split ? { discountTaxSplit: split as object } : {}),
            lines: { create: [line(a, '20'), line(b, '5'), line(c, '0')] },
          },
          select: { id: true, lines: { select: { id: true, taxRateId: true } } },
        })
        orderIds.push(o.id)
        return o
      }
      const refund = (orderId: string, lineId: string, n: string) => createSalesOrderRefund(db, {
        orderId, lines: [{ lineId, productId: null, description: 'l', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' }],
        reason: `r${n}`, creditNotePrefix: `CNRD${sfx}-`, enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true,
      })
      const discountRows = (orderId: string) => db.salesOrderRefundLine.findMany({ where: { refund: { orderId }, lineKind: 'discount' }, select: { totalForeign: true, accountingTaxType: true, discountTaxRateId: true, postedTaxRate: true } })

      const split = await mkOrder([entry(a, 0.2, 4), entry(b, 0.05, 1), entry(c, 0, 0)])
      const lineOf = (o: typeof split, id: string) => o.lines.find((l) => l.taxRateId === id)!.id

      const r1 = await refund(split.id, lineOf(split, b.id), '1')
      assert.equal(r1.success, true, r1.success ? '' : r1.error)
      let rows = await discountRows(split.id)
      assert.deepEqual(rows.map((r) => [Number(r.totalForeign), r.accountingTaxType, r.discountTaxRateId]), [[-20, b.accountingTaxType, b.id]], 'only the 5% line\'s own 20 of discount, on the 5% code')
      assert.equal(Number(rows[0]!.postedTaxRate), 0.05)

      for (const [id, n] of [[a.id, '2'], [c.id, '3']] as const) {
        const r = await refund(split.id, lineOf(split, id), n)
        assert.equal(r.success, true, r.success ? '' : r.error)
      }
      rows = await discountRows(split.id)
      const byRate = new Map(rows.map((r) => [r.discountTaxRateId, r]))
      assert.equal(rows.length, 3)
      assert.deepEqual([a.id, b.id, c.id].map((id) => [Number(byRate.get(id)!.totalForeign), byRate.get(id)!.accountingTaxType]), [[-20, a.accountingTaxType], [-20, b.accountingTaxType], [-20, c.accountingTaxType]])
      const vat = rows.reduce((s, r) => s + Number(r.totalForeign) * Number(r.postedTaxRate), 0)
      assert.equal(Math.round(vat * 100) / 100, -5, 'the discount VAT given back is the 5 the order took off, not 12 at the header rate')

      // The same order priced the header-rate way (no split): one discount line at the order default code, as before.
      const plain = await mkOrder(null)
      const p1 = await refund(plain.id, lineOf(plain, a.id), 'p1')
      assert.equal(p1.success, true, p1.success ? '' : p1.error)
      const plainRows = await discountRows(plain.id)
      assert.equal(plainRows.length, 1)
      assert.equal(plainRows[0]!.discountTaxRateId, null)
      assert.equal(plainRows[0]!.accountingTaxType, a.accountingTaxType, 'the order default code')
    } finally {
      for (const orderId of orderIds) {
        await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } }).catch(() => {})
        await db.salesOrderRefund.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrderLine.deleteMany({ where: { orderId } }).catch(() => {})
        await db.salesOrder.delete({ where: { id: orderId } }).catch(() => {})
      }
      await db.taxRate.deleteMany({ where: { id: { in: rateIds } } }).catch(() => {})
      await db.$disconnect()
    }
  },
)
