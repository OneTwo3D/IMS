import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * POSTED INVOICE RECORDS ARE KEPT (owner ruling 2026-11-28), against a real Postgres: the sync-log retention run neither deletes nor compacts the connector-confirmed SALES_INVOICE / SALES_INVOICE_UPDATE rows of an
 * order (the record a refund reads the posted tax codes from), while other old rows are still pruned or compacted; and a refund of an invoiced order that had to read the CURRENT codes writes one WARNING (and is not
 * refused), where a refund with the record present writes none and behaves as before. Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/posted-invoice-records-kept.test.ts would have been skipped.')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { purgeExpiredData } = await import('../../lib/data-retention')
  const { createSalesOrderRefund } = await import('../../lib/domain/sales/refund-service')
  return { db, Prisma, purgeExpiredData, createSalesOrderRefund }
}

test('[db] retention keeps (whole) the posted invoice rows of an order and still prunes / compacts the other old rows', { skip }, async (t) => {
  const { db, Prisma, purgeExpiredData } = await load()
  const D = (v: string) => new Prisma.Decimal(v)
  const invoiceId = `inv-${randomUUID()}`
  const order = await db.salesOrder.create({
    data: { orderNumber: `PK-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('1'), subtotalBase: D('1'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('1'), totalBase: D('1'), accountingInvoiceId: invoiceId },
    select: { id: true },
  })
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000)
  const payload = { lines: [{ description: 'l', taxType: 'OLD', taxRateId: 'r1' }], contactName: 'Someone' }
  const mk = (data: Record<string, unknown>) => db.accountingSyncLog.create({
    data: { connector: 'xero', referenceType: 'SalesOrder', referenceId: order.id, createdAt: old, syncedAt: old, payload, ...data } as never,
    select: { id: true },
  })
  const create = await mk({ type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: invoiceId })
  const update = await mk({ type: 'SALES_INVOICE_UPDATE', status: 'SYNCED', externalTransactionId: invoiceId })
  // Still compacted: an operator-asserted document id (the claim survives, the payload expires).
  const asserted = await mk({ type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: `asserted-${randomUUID()}`, settlementBasis: 'OPERATOR_ASSERTION' })
  // Still deleted: a shadow update (cancelled, held-shadow basis, no document id) that no exemption names.
  const prunable = await mk({ type: 'SALES_INVOICE_UPDATE', status: 'CANCELLED', settlementBasis: 'HELD_SHADOW', syncedAt: null })
  t.after(async () => {
    await db.accountingSyncLog.deleteMany({ where: { id: { in: [create.id, update.id, asserted.id, prunable.id] } } }).catch(() => {})
    await db.salesOrder.delete({ where: { id: order.id } }).catch(() => {})
  })
  await purgeExpiredData()
  const rows = await db.accountingSyncLog.findMany({ where: { id: { in: [create.id, update.id, asserted.id, prunable.id] } }, select: { id: true, payload: true, backReferenceEvidenceCompactedAt: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const kept of [create.id, update.id]) {
    const row = byId.get(kept)
    assert.ok(row, 'a posted invoice row is not deleted')
    assert.equal(row.backReferenceEvidenceCompactedAt, null, 'and not compacted')
    assert.deepEqual(row.payload, payload, 'its payload (the posted codes) is intact')
  }
  assert.ok(byId.get(asserted.id)?.backReferenceEvidenceCompactedAt, 'an asserted row is still compacted')
  assert.equal(byId.has(prunable.id), false, 'an unrelated old shadow row is still pruned')
})

test('[db] a refund of an invoiced order that falls back to current codes writes one WARNING and succeeds; with the record present it writes none', { skip }, async (t) => {
  const { db, Prisma, createSalesOrderRefund } = await load()
  const sfx = randomUUID().slice(0, 8)
  const D = (v: string) => new Prisma.Decimal(v)
  const rate = await db.taxRate.create({ data: { name: `FW-${sfx}`, rate: '0.2', accountingTaxType: `FW-${sfx}`, countryCode: 'ZZ' }, select: { id: true, name: true } })
  const orderIds: string[] = []
  t.after(async () => {
    for (const id of orderIds) {
      await db.activityLog.deleteMany({ where: { entityType: 'SALES_ORDER', entityId: id } }).catch(() => {})
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: id } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: id } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId: id } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId: id } }).catch(() => {})
      await db.salesOrder.delete({ where: { id } }).catch(() => {})
    }
    await db.taxRate.delete({ where: { id: rate.id } }).catch(() => {})
  })
  const mk = async (withRecord: boolean) => {
    const o = await db.salesOrder.create({
      data: {
        orderNumber: `FW-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), pricesIncludeVat: false, taxRateName: rate.name, taxRatePercent: D('0.2'),
        subtotalForeign: D('100'), subtotalBase: D('100'), taxForeign: D('20'), taxBase: D('20'), totalForeign: D('120'), totalBase: D('120'),
        accountingInvoiceId: `inv-${randomUUID()}`, accountingInvoiceConnector: 'xero',
        lines: { create: [{ description: 'goods', qty: D('1'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('20'), taxBase: D('20'), totalForeign: D('100'), totalBase: D('100'), taxRateId: rate.id }] },
      },
      select: { id: true, accountingInvoiceId: true, lines: { select: { id: true } } },
    })
    orderIds.push(o.id)
    if (withRecord) {
      await db.accountingSyncLog.create({
        data: {
          connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: o.id, externalTransactionId: o.accountingInvoiceId, syncedAt: new Date(),
          payload: { lines: [{ description: 'goods', quantity: 1, unitAmount: 100, taxType: `FW-${sfx}`, taxRateId: rate.id, taxRateBasis: 'sales_line' }] },
        },
      })
    }
    return o
  }
  const refund = (o: { id: string; lines: { id: string }[] }) => createSalesOrderRefund(db, {
    orderId: o.id, lines: [{ lineId: o.lines[0]!.id, productId: null, description: 'goods', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' }],
    reason: 'fw', creditNotePrefix: `CNFW${sfx}-`, enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true,
  })
  const warnings = (id: string) => db.activityLog.findMany({ where: { entityType: 'SALES_ORDER', entityId: id, action: 'refund_used_current_tax_codes' }, select: { level: true, description: true, metadata: true } })

  const noRecord = await mk(false)
  const r1 = await refund(noRecord)
  assert.equal(r1.success, true, r1.success ? '' : r1.error)
  const w1 = await warnings(noRecord.id)
  assert.equal(w1.length, 1, 'one warning for the refund')
  assert.equal(w1[0]!.level, 'WARNING')
  assert.match(w1[0]!.description, /goods \(FW-/, 'names the line and the code used')

  const withRecord = await mk(true)
  const r2 = await refund(withRecord)
  assert.equal(r2.success, true, r2.success ? '' : r2.error)
  assert.equal((await warnings(withRecord.id)).length, 0, 'the record is present: unchanged, no warning')
  const row = await db.salesOrderRefundLine.findFirst({ where: { refund: { orderId: withRecord.id } }, select: { accountingTaxType: true } })
  assert.equal(row?.accountingTaxType, `FW-${sfx}`)
})
