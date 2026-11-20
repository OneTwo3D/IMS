import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * The VAT report's real query shapes against a real database: the sales invoice is placed by the Xero document date (the London day the order was created), not by
 * the instant it was posted; credit notes Xero holds are netted by their own dates; a deleted refund is not. Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/vat-report-document-date.test.ts would have been skipped.')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const mod = await import('../../lib/domain/finance/finance-period-analytics')
  return { db, mod }
}

test('[db] VAT report: late-posted invoice stays in its Xero quarter; credit notes net by their own dates; supplier credit nets the bill share', { skip }, async (t) => {
  const { db, mod } = await load()
  const sfx = randomUUID().slice(0, 8)
  // A rate name nothing else uses, so the report rows for this run are identified by it.
  const rate = await db.taxRate.create({ data: { name: `VB-${sfx}`, rate: '0.2', accountingTaxType: 'OUTPUT2', countryCode: 'ZZ' }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `VB-${sfx}`, name: 'vb', type: 'SIMPLE' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `VB-${sfx}`, country: 'ZZ' }, select: { id: true } })
  const mkOrder = (created: string, invoiced: string | null) => db.salesOrder.create({
    data: {
      orderNumber: `VB-${randomUUID().slice(0, 8)}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: '100', totalForeign: '120', subtotalBase: '100', taxBase: '20', totalBase: '120',
      externalCreatedAt: new Date(created), invoicedAt: invoiced ? new Date(invoiced) : null,
      lines: { create: [{ productId: product.id, sku: `VB-${sfx}`, description: 'l', qty: '1', unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: rate.id }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  // Created 22:50Z on 30 Sep 2026 (23:50 BST: Xero date 30 Sep, Q3), posted 23:30Z (00:30 BST on 1 Oct).
  const late = await mkOrder('2026-09-30T22:50:00Z', '2026-09-30T23:30:00Z')
  // Not posted: in no period.
  const unposted = await mkOrder('2026-08-10T10:00:00Z', null)
  const mkRefund = (orderId: string, lineId: string, at: string, over: { accountingCreditNoteId?: string | null; deletedAt?: Date | null }) => db.salesOrderRefund.create({
    data: {
      orderId, totalForeign: '50', totalBase: '50', createdAt: new Date(at), accountingCreditNoteId: over.accountingCreditNoteId === undefined ? `cn-${randomUUID()}` : over.accountingCreditNoteId, deletedAt: over.deletedAt ?? null,
      lines: { create: [{ salesOrderLineId: lineId, description: 'r', qty: '1', unitPriceBase: '50', totalBase: '50', postedTaxRate: '0.2' }] },
    },
    select: { id: true },
  })
  const q4Refund = await mkRefund(late.id, late.lines[0]!.id, '2026-09-30T23:40:00Z', {})
  const noCn = await mkRefund(late.id, late.lines[0]!.id, '2026-08-01T10:00:00Z', { accountingCreditNoteId: null })
  const deleted = await mkRefund(late.id, late.lines[0]!.id, '2026-08-02T10:00:00Z', { deletedAt: new Date() })
  const po = await db.purchaseOrder.create({ data: { reference: `VB-${sfx}`, supplierId: supplier.id, currency: 'GBP', fxRateToBase: '1', subtotalForeign: '100', subtotalBase: '100', totalForeign: '120', totalBase: '120' }, select: { id: true } })
  const poLine = await db.purchaseOrderLine.create({ data: { poId: po.id, productId: product.id, qty: '1', unitCostForeign: '100', unitCostBase: '100', totalForeign: '100', totalBase: '100', taxBase: '20', taxForeign: '20', taxRateId: rate.id }, select: { id: true } })
  const bill = await db.purchaseInvoice.create({
    data: { poId: po.id, invoiceDate: new Date('2026-09-30T00:00:00Z'), totalForeign: '120', totalBase: '120', fxRateToBase: '1', lines: { create: [{ poLineId: poLine.id, qtyBilled: '1', unitCostForeign: '100', totalForeign: '100', totalBase: '100' }] } },
    select: { id: true },
  })
  const credit = await db.supplierCreditNote.create({
    data: { poId: po.id, purchaseInvoiceId: bill.id, supplierId: supplier.id, amountForeign: '60', amountBase: '60', currency: 'GBP', fxRateToBase: '1', status: 'POSTED', postedAt: new Date('2026-09-30T23:30:00Z'), accountingCreditNoteId: `scn-${randomUUID()}` },
    select: { id: true },
  })
  t.after(async () => {
    await db.supplierCreditNote.deleteMany({ where: { id: credit.id } })
    await db.purchaseInvoiceLine.deleteMany({ where: { invoiceId: bill.id } })
    await db.purchaseInvoice.deleteMany({ where: { id: bill.id } })
    await db.purchaseOrderLine.deleteMany({ where: { id: poLine.id } })
    await db.purchaseOrder.deleteMany({ where: { id: po.id } })
    for (const o of [late, unposted]) {
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: o.id } } })
      await db.salesOrderRefund.deleteMany({ where: { orderId: o.id } })
      await db.salesOrderLine.deleteMany({ where: { orderId: o.id } })
      await db.salesOrder.deleteMany({ where: { id: o.id } })
    }
    await db.supplier.deleteMany({ where: { id: supplier.id } })
    await db.product.deleteMany({ where: { id: product.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
  })
  void q4Refund; void noCn; void deleted

  const only = (report: Awaited<ReturnType<typeof mod.getVatReport>>, side: 'sales' | 'purchases') =>
    report.rows.filter((r) => r.taxRateName === `VB-${sfx}` && r.side === side).reduce((sum, r) => sum + Number(r.taxBase), 0)
  const q3 = await mod.getVatReport({ dateFrom: '2026-07-01', dateTo: '2026-09-30' }, { paginate: false })
  const q4 = await mod.getVatReport({ dateFrom: '2026-10-01', dateTo: '2026-12-31' }, { paginate: false })
  assert.equal(only(q3, 'sales'), 20, 'Q3: the late-posted invoice (its Xero date is 30 Sep); no credit note without a Xero id and none that is deleted')
  assert.equal(only(q4, 'sales'), -10, 'Q4: only the 00:40 BST credit note, minus 10')
  assert.equal(only(q3, 'purchases'), 20, 'Q3: the bill dated 30 Sep')
  assert.equal(only(q4, 'purchases'), -10, 'Q4: the supplier credit note (posted 00:30 BST on 1 Oct) takes half the bill tax')
})
