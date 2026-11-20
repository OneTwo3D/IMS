import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * The VAT report's real query shapes for an order whose discount tax was apportioned across its line rates (SalesOrder.discountTaxSplit): each rate's row is the base and VAT the invoice posts at that rate
 * (its lines less its share of the discount), the order-level row is the shipping VAT alone, and the reversal of one rate's share of the discount nets against that rate's row. A header-rate order (no split)
 * is unchanged. Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/vat-report-apportioned-discount.test.ts would have been skipped.')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const mod = await import('../../lib/domain/finance/finance-period-analytics')
  return { db, mod }
}

test('[db] VAT report: an apportioned order discount comes off each rate row; the order-level row is the shipping VAT alone; a per-rate discount reversal nets on its own rate row', { skip }, async (t) => {
  const { db, mod } = await load()
  const sfx = randomUUID().slice(0, 8)
  const mkRate = (key: string, rate: string) => db.taxRate.create({ data: { name: `AD-${key}-${sfx}`, rate, accountingTaxType: `ADOUT-${key}-${sfx}`, countryCode: 'ZZ' }, select: { id: true } })
  const [a, b, c] = [await mkRate('A', '0.2'), await mkRate('B', '0.05'), await mkRate('C', '0')]
  const product = await db.product.create({ data: { sku: `AD-${sfx}`, name: 'ad', type: 'SIMPLE' }, select: { id: true } })
  const entry = (id: string, rate: number, net: number, tax: number) => ({ taxRateId: id, accountingTaxType: `x`, reverseCharge: false, rate, netForeign: net, taxForeign: tax, netBase: net, taxBase: tax })
  const mkLine = (id: string, tax: string) => ({ productId: product.id, sku: `AD-${sfx}`, description: 'l', qty: '1', unitPriceForeign: '100', unitPriceBase: '100', taxForeign: tax, taxBase: tax, totalForeign: '100', totalBase: '100', taxRateId: id })
  // Lines 100 @20%, 100 @5%, 100 @0%; shipping 10 net taxed at 20% (2); a 60 discount apportioned 20 / 20 / 20 (VAT 4 / 1 / 0). Order VAT = 25 + 2 - 5 = 22.
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `AD-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: '1', shippingAddress: { country: 'ZZ' },
      subtotalForeign: '300', shippingForeign: '10', shippingBase: '10', discountAmount: '60', totalForeign: '272', subtotalBase: '300', taxForeign: '22', taxBase: '22', totalBase: '272',
      discountTaxSplit: [entry(a.id, 0.2, 20, 4), entry(b.id, 0.05, 20, 1), entry(c.id, 0, 20, 0)],
      externalCreatedAt: new Date('2026-08-10T10:00:00Z'), invoicedAt: new Date('2026-08-10T10:30:00Z'),
      lines: { create: [mkLine(a.id, '20'), mkLine(b.id, '5'), mkLine(c.id, '0')] },
    },
    select: { id: true, lines: { select: { id: true, taxRateId: true } } },
  })
  // A header-rate order (no split) in the same period: 100 @20% with a 10 discount (header VAT 2). Its discount VAT stays in the order-level residual.
  const plain = await db.salesOrder.create({
    data: {
      orderNumber: `AD-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: '1', shippingAddress: { country: 'ZZ' },
      subtotalForeign: '100', discountAmount: '10', totalForeign: '108', subtotalBase: '100', taxForeign: '18', taxBase: '18', totalBase: '108',
      externalCreatedAt: new Date('2026-08-11T10:00:00Z'), invoicedAt: new Date('2026-08-11T10:30:00Z'),
      lines: { create: [mkLine(a.id, '20')] },
    },
    select: { id: true },
  })
  const refund = await db.salesOrderRefund.create({
    data: {
      orderId: order.id, totalForeign: '84', totalBase: '84', createdAt: new Date('2026-08-12T10:00:00Z'), accountingCreditNoteId: `cn-${randomUUID()}`,
      lines: { create: [
        { salesOrderLineId: order.lines.find((l) => l.taxRateId === b.id)!.id, description: 'sale B', qty: '1', unitPriceBase: '100', totalBase: '100', totalForeign: '100', postedTaxRate: '0.05', lineKind: 'sale' },
        { description: 'Order discount', qty: '0', unitPriceBase: '0', totalBase: '-20', totalForeign: '-20', postedTaxRate: '0.05', lineKind: 'discount', discountTaxRateId: b.id },
      ] },
    },
    select: { id: true },
  })
  t.after(async () => {
    await db.salesOrderRefundLine.deleteMany({ where: { refundId: refund.id } })
    await db.salesOrderRefund.deleteMany({ where: { id: refund.id } })
    for (const o of [order, plain]) {
      await db.salesOrderLine.deleteMany({ where: { orderId: o.id } })
      await db.salesOrder.deleteMany({ where: { id: o.id } })
    }
    await db.product.deleteMany({ where: { id: product.id } })
    await db.taxRate.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } })
  })

  const report = await mod.getVatReport({ dateFrom: '2026-08-01', dateTo: '2026-08-11' }, { paginate: false })
  const row = (name: string) => report.rows.find((r) => r.taxRateName === name && r.side === 'sales')
  // Rate A: 100 + 100 of lines, 40 of VAT; the apportioned order's 20 of discount (VAT 4) comes off: base 180, VAT 36 (the plain order's discount is NOT taken off the rate row).
  assert.equal(Number(row(`AD-A-${sfx}`)!.taxBase), 36)
  assert.equal(Number(row(`AD-A-${sfx}`)!.taxableBase), 180)
  assert.equal(Number(row(`AD-B-${sfx}`)!.taxBase), 4, '5 of line VAT less 1 of discount VAT')
  assert.equal(Number(row(`AD-B-${sfx}`)!.taxableBase), 80)
  assert.equal(Number(row(`AD-C-${sfx}`)!.taxableBase), 80)
  // The order-level row: shipping VAT 2 for the apportioned order (its discount VAT is on the rate rows) and 18 - 20 = -2 for the header-rate order (its discount VAT is here).
  const shipping = report.rows.find((r) => r.taxRateName === mod.SHIPPING_ROW_NAME && r.side === 'sales' && r.jurisdiction === 'ZZ')!
  assert.equal(Number(shipping.taxBase), 2 + -2)
  assert.equal(Number(shipping.taxableBase), 10)

  // The credit note (12 Aug) reverses B's line (100) and B's 20 of discount, each on rate B's row: VAT credited 5 - 1 = 4, base 80.
  const later = await mod.getVatReport({ dateFrom: '2026-08-12', dateTo: '2026-08-12' }, { paginate: false })
  const credit = later.rows.find((r) => r.taxRateName === `AD-B-${sfx}` && r.side === 'sales')!
  assert.equal(Number(credit.taxBase), -4)
  assert.equal(Number(credit.taxableBase), -80)
  assert.equal(later.rows.some((r) => r.taxRateName === 'No tax rate' && r.side === 'sales' && Number(r.taxableBase) === 20), false, 'the discount reversal did not land on the "No tax rate" row')
})
