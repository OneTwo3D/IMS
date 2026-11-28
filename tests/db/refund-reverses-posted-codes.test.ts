import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * A REFUND OF A POSTED INVOICE REVERSES IT ON THE CODES THE INVOICE POSTED WITH (owner ruling), against a real Postgres. The order carries a 20% and a 5% line and a per-rate split discount; its invoice posted
 * the 5% rate on OLD-B. The rate is then remapped to NEW-B (the old code stays mapped on another 5% rate). The refund of the 5% line must credit BOTH the goods line and its discount share on OLD-B (the posted
 * code), the posted-VAT fence (expectedTaxIdentities) must agree with that, and a refund BEFORE any posting still reads the rate's current code. A header-rate order (no split) keeps its single discount line.
 * Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/refund-reverses-posted-codes.test.ts would have been skipped.')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { createSalesOrderRefund } = await import('../../lib/domain/sales/refund-service')
  const { readPostedInvoiceTaxCodes } = await import('../../lib/domain/sales/posted-invoice-tax-codes')
  const { raiseShopRefundTask } = await import('../../lib/domain/sales/shop-refund-tasks')
  return { db, Prisma, createSalesOrderRefund, readPostedInvoiceTaxCodes, raiseShopRefundTask }
}

test('[db] a refund of a posted invoice credits goods and discount on the codes it posted with, after the rate was remapped; before posting it reads the current mapping', { skip }, async (t) => {
  const { db, Prisma, createSalesOrderRefund } = await load()
  const sfx = randomUUID().slice(0, 8)
  const orderIds: string[] = []
  const rateIds: string[] = []
  t.after(async () => {
    for (const orderId of orderIds) {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: orderId } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId } }).catch(() => {})
      await db.salesOrder.delete({ where: { id: orderId } }).catch(() => {})
    }
    await db.taxRate.deleteMany({ where: { id: { in: rateIds } } }).catch(() => {})
  })
  const mkRate = async (key: string, rate: string, code: string) => {
    const r = await db.taxRate.create({ data: { name: `PC-${key}-${sfx}`, rate, accountingTaxType: code, countryCode: 'ZZ' }, select: { id: true, name: true } })
    rateIds.push(r.id)
    return r
  }
  const a = await mkRate('A', '0.2', `A-${sfx}`)
  const b = await mkRate('B', '0.05', `OLDB-${sfx}`)
  // No other rate holds the old code: the remap below edits rate B in place (updateTaxRate), so the old code is on NO tax rate row afterwards and must be priced from the posted record.
  const D = (v: string) => new Prisma.Decimal(v)
  const entry = (id: string, rate: number, net: number, tax: number) => ({ taxRateId: id, accountingTaxType: 'stale', reverseCharge: false, rate, netForeign: net, taxForeign: tax, netBase: net, taxBase: tax })
  const mkLine = (id: string, tax: string) => ({ description: 'l', qty: D('1'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D(tax), taxBase: D(tax), totalForeign: D('100'), totalBase: D('100'), taxRateId: id })
  const mkOrder = async (opts: { split: boolean; posted: 'none' | 'synced' | 'no-row' }) => {
    const o = await db.salesOrder.create({
      data: {
        orderNumber: `PC-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), pricesIncludeVat: false, taxRateName: a.name, taxRatePercent: D('0.2'),
        subtotalForeign: D('200'), subtotalBase: D('200'), discountAmount: D('40'), taxForeign: D('22'), taxBase: D('22'), totalForeign: D('182'), totalBase: D('182'),
        ...(opts.split ? { discountTaxSplit: [entry(a.id, 0.2, 20, 4), entry(b.id, 0.05, 20, 1)] as object } : {}),
        ...(opts.posted !== 'none' ? { accountingInvoiceId: `inv-${randomUUID()}`, accountingInvoiceConnector: 'xero' } : {}),
        lines: { create: [mkLine(a.id, '20'), mkLine(b.id, '5')] },
      },
      select: { id: true, accountingInvoiceId: true, lines: { select: { id: true, taxRateId: true } } },
    })
    orderIds.push(o.id)
    if (opts.posted === 'synced') {
      await db.accountingSyncLog.create({
        data: {
          connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: o.id, externalTransactionId: o.accountingInvoiceId, syncedAt: new Date(),
          payload: {
            lines: [
              { description: 'l', quantity: 1, unitAmount: 100, taxType: `A-${sfx}`, taxRateId: a.id, taxRateBasis: 'sales_line' },
              { description: 'l', quantity: 1, unitAmount: 100, taxType: `OLDB-${sfx}`, taxRateId: b.id, taxRateBasis: 'sales_line' },
            ],
            discountTaxType: `A-${sfx}`,
            ...(opts.split ? { discountParts: [{ amount: 20, taxType: `A-${sfx}`, taxRateId: a.id, taxRateBasis: 'sales_line' }, { amount: 20, taxType: `OLDB-${sfx}`, taxRateId: b.id, taxRateBasis: 'sales_line' }] } : {}),
          },
        },
      })
    }
    return o
  }
  const refundB = (order: Awaited<ReturnType<typeof mkOrder>>, extra: Record<string, unknown> = {}) => createSalesOrderRefund(db, {
    orderId: order.id,
    lines: [{ lineId: order.lines.find((l) => l.taxRateId === b.id)!.id, productId: null, description: 'l', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' }],
    creditNotePostingEnabled: true,
    reason: 'pc', creditNotePrefix: `CNPC${sfx}-`, enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true, ...extra,
  })
  const codes = async (orderId: string) => {
    const rows = await db.salesOrderRefundLine.findMany({ where: { refund: { orderId } }, select: { lineKind: true, accountingTaxType: true, discountTaxRateId: true } })
    return {
      sale: rows.filter((r) => r.lineKind === 'sale').map((r) => r.accountingTaxType),
      discount: rows.filter((r) => r.lineKind === 'discount').map((r) => [r.discountTaxRateId, r.accountingTaxType]),
    }
  }

  // Posted (SYNCED row), THEN the 5% rate is remapped to a new code.
  const posted = await mkOrder({ split: true, posted: 'synced' })
  // The new code is on rate B only after the remap; the old code is on no row.
  // Not yet posted, same mapping state.
  const unposted = await mkOrder({ split: true, posted: 'none' })
  // Posted with no readable record (hand-linked / Xeroom): the current mapping is all there is.
  const noRow = await mkOrder({ split: true, posted: 'no-row' })
  await db.taxRate.update({ where: { id: b.id }, data: { accountingTaxType: `NEWB-${sfx}` } })

  // The fence: an expectation built on the POSTED identity holds; the remapped code is a moved identity.
  const moved = await refundB(posted, { creditNotePostingEnabled: true, expectedTaxIdentities: [{ lineId: posted.lines.find((l) => l.taxRateId === b.id)!.id, lineKind: 'sale', accountingTaxType: `NEWB-${sfx}`, reverseCharge: false, vatRate: '0.05' }] })
  assert.equal(moved.success, false, 'an expectation on the remapped code no longer matches what the refund will post (the posted code)')
  const r1 = await refundB(posted, { creditNotePostingEnabled: true, expectedTaxIdentities: [{ lineId: posted.lines.find((l) => l.taxRateId === b.id)!.id, lineKind: 'sale', accountingTaxType: `OLDB-${sfx}`, reverseCharge: false, vatRate: '0.05' }] })
  assert.equal(r1.success, true, r1.success ? '' : r1.error)
  const c1 = await codes(posted.id)
  assert.deepEqual(c1.sale, [`OLDB-${sfx}`], 'the goods line is credited on the code the invoice posted it with')
  assert.deepEqual(c1.discount, [[b.id, `OLDB-${sfx}`]], 'and so is its discount share')

  const r2 = await refundB(unposted)
  assert.equal(r2.success, true, r2.success ? '' : r2.error)
  const c2 = await codes(unposted.id)
  assert.deepEqual(c2.sale, [`NEWB-${sfx}`], 'no posted invoice: the rate\'s current code')
  assert.deepEqual(c2.discount, [[b.id, `NEWB-${sfx}`]])

  const r3 = await refundB(noRow)
  assert.equal(r3.success, true, r3.success ? '' : r3.error)
  const c3 = await codes(noRow.id)
  assert.deepEqual(c3.sale, [`NEWB-${sfx}`], 'a posted invoice with no readable record falls back to the current mapping')
  assert.deepEqual(c3.discount, [[b.id, `NEWB-${sfx}`]])

  // Switch-off shape (no split): the single discount line stays on the order default code; the goods line is still credited on the posted code.
  await db.taxRate.update({ where: { id: b.id }, data: { accountingTaxType: `OLDB-${sfx}` } })
  const plain = await mkOrder({ split: false, posted: 'synced' })
  await db.taxRate.update({ where: { id: b.id }, data: { accountingTaxType: `NEWB-${sfx}` } })
  const r4 = await refundB(plain)
  assert.equal(r4.success, true, r4.success ? '' : r4.error)
  const c4 = await codes(plain.id)
  assert.deepEqual(c4.sale, [`OLDB-${sfx}`])
  assert.deepEqual(c4.discount, [[null, `A-${sfx}`]], 'header-rate discount: one line on the order default code, as before')
})

test('[db] an order-default rate remapped after posting: goods, the header-rate discount and shipping are all credited on the codes the invoice posted', { skip }, async (t) => {
  const { db, Prisma, createSalesOrderRefund } = await load()
  const sfx = randomUUID().slice(0, 8)
  const D = (v: string) => new Prisma.Decimal(v)
  const rate = await db.taxRate.create({ data: { name: `PD-${sfx}`, rate: '0.2', accountingTaxType: `DEFOLD-${sfx}`, countryCode: 'ZZ' }, select: { id: true, name: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `PD-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), pricesIncludeVat: false, taxRateName: rate.name, taxRatePercent: D('0.2'),
      subtotalForeign: D('100'), subtotalBase: D('100'), shippingForeign: D('10'), shippingBase: D('10'), discountAmount: D('10'),
      taxForeign: D('20'), taxBase: D('20'), totalForeign: D('120'), totalBase: D('120'),
      accountingInvoiceId: `inv-${randomUUID()}`, accountingInvoiceConnector: 'xero',
      lines: { create: [{ description: 'l', qty: D('1'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('20'), taxBase: D('20'), totalForeign: D('100'), totalBase: D('100'), taxRateId: rate.id }] },
    },
    select: { id: true, accountingInvoiceId: true, lines: { select: { id: true } } },
  })
  t.after(async () => {
    await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: order.id } }).catch(() => {})
    await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: order.id } } }).catch(() => {})
    await db.salesOrderRefund.deleteMany({ where: { orderId: order.id } }).catch(() => {})
    await db.salesOrderLine.deleteMany({ where: { orderId: order.id } }).catch(() => {})
    await db.salesOrder.delete({ where: { id: order.id } }).catch(() => {})
    await db.taxRate.delete({ where: { id: rate.id } }).catch(() => {})
  })
  const old = `DEFOLD-${sfx}`
  await db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: order.id, externalTransactionId: order.accountingInvoiceId, syncedAt: new Date(),
      payload: {
        lines: [{ description: 'l', quantity: 1, unitAmount: 100, taxType: old, taxRateId: rate.id, taxRateBasis: 'sales_line' }],
        shippingAmount: 10, shippingTaxType: old, shippingTaxRateId: rate.id, shippingTaxRateBasis: 'plain',
        discountAmount: 10, discountTaxType: old, discountTaxRateId: rate.id, discountTaxRateBasis: 'plain',
      },
    },
  })
  // The in-place remap (updateTaxRate): the old code is on no row afterwards.
  await db.taxRate.update({ where: { id: rate.id }, data: { accountingTaxType: `DEFNEW-${sfx}` } })
  const r = await createSalesOrderRefund(db, {
    orderId: order.id,
    lines: [
      { lineId: order.lines[0]!.id, productId: null, description: 'l', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' },
      { lineId: null, productId: null, description: 'Shipping', qty: 0, totalForeign: 10, totalBase: 10, lineKind: 'shipping' },
    ],
    reason: 'pd', creditNotePrefix: `CNPD${sfx}-`, enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true, creditNotePostingEnabled: true,
  })
  assert.equal(r.success, true, r.success ? '' : r.error)
  const rows = await db.salesOrderRefundLine.findMany({ where: { refund: { orderId: order.id } }, select: { lineKind: true, accountingTaxType: true } })
  assert.deepEqual(rows.map((x) => [x.lineKind, x.accountingTaxType]).sort(), [['discount', old], ['sale', old], ['shipping', old]].sort())
})

test('[db] which sync row speaks for the posted invoice: the newest one that names the document, and only if the ledger holds it and it is readable', { skip }, async (t) => {
  const { db, Prisma, readPostedInvoiceTaxCodes } = await load()
  const sfx = randomUUID().slice(0, 8)
  const D = (v: string) => new Prisma.Decimal(v)
  const rate = await db.taxRate.create({ data: { name: `PO-${sfx}`, rate: '0.2', accountingTaxType: `CUR-${sfx}`, countryCode: 'ZZ' }, select: { id: true } })
  const invoiceId = `inv-${randomUUID()}`
  const order = await db.salesOrder.create({
    data: { orderNumber: `PO-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('1'), subtotalBase: D('1'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('1'), totalBase: D('1'), accountingInvoiceId: invoiceId },
    select: { id: true },
  })
  t.after(async () => {
    await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: order.id } }).catch(() => {})
    await db.salesOrder.delete({ where: { id: order.id } }).catch(() => {})
    await db.taxRate.delete({ where: { id: rate.id } }).catch(() => {})
  })
  const payload = (code: string, extra: Record<string, unknown> = {}) => ({ lines: [{ description: 'l', taxType: code, taxRateId: rate.id }], ...extra })
  const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 10, n))
  const row = (data: Record<string, unknown>) => db.accountingSyncLog.create({
    data: { connector: 'xero', referenceType: 'SalesOrder', referenceId: order.id, ...data } as never,
  })
  const codeOf = async () => (await readPostedInvoiceTaxCodes(db, order.id, invoiceId))?.lineCodeByRateId.get(rate.id) ?? null

  assert.equal(await codeOf(), null, 'no row: no record')
  await row({ type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: invoiceId, syncedAt: at(1), createdAt: at(1), payload: payload('V1') })
  assert.equal(await codeOf(), 'V1')
  await row({ type: 'SALES_INVOICE_UPDATE', status: 'SYNCED', externalTransactionId: invoiceId, syncedAt: at(2), createdAt: at(2), payload: payload('V2', { accountingInvoiceId: invoiceId }) })
  assert.equal(await codeOf(), 'V2', 'a synced update replaces the create')
  // A newer update accepted but still in flight (it names the document only in its payload): Xero's document is not known to carry it, and the older version is NOT read in its place.
  await row({ type: 'SALES_INVOICE_UPDATE', status: 'PENDING', createdAt: at(3), payload: payload('V3', { accountingInvoiceId: invoiceId }) })
  assert.equal(await codeOf(), null, 'the newest row is not a ledger fact: no record (fallback), never the older version')
  await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: order.id, status: 'PENDING' } })
  // A newest row whose payload was compacted (unreadable): no record.
  await row({ type: 'SALES_INVOICE_UPDATE', status: 'SYNCED', externalTransactionId: invoiceId, syncedAt: at(4), createdAt: at(4), payload: { compacted: true } })
  assert.equal(await codeOf(), null, 'an unreadable newest row: no record')
  await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: order.id, createdAt: at(4) } })
  // A newest update that is a SHADOW (CANCELLED, held-shadow basis, no document id; it names the document only in its payload) sent nothing: the next row speaks.
  await row({ type: 'SALES_INVOICE_UPDATE', status: 'CANCELLED', settlementBasis: 'HELD_SHADOW', createdAt: at(5), payload: payload('V5', { accountingInvoiceId: invoiceId }) })
  assert.equal(await codeOf(), 'V2', 'a shadow newest update is skipped')
  // A newest update that FAILED before ever being claimed (no document id, no attempt) sent nothing either.
  await row({ type: 'SALES_INVOICE_UPDATE', status: 'FAILED', createdAt: at(6), payload: payload('V6', { accountingInvoiceId: invoiceId }) })
  assert.equal(await codeOf(), 'V2', 'a never-claimed failed newest update is skipped')
  // A FAILED update that WAS attempted may have reached the ledger: no record.
  await row({ type: 'SALES_INVOICE_UPDATE', status: 'FAILED', attemptRevision: 1, processingStartedAt: at(7), createdAt: at(7), payload: payload('V7', { accountingInvoiceId: invoiceId }) })
  assert.equal(await codeOf(), null, 'a claimed failed newest update is unproven: no record')
})

test('[db] a reverse-charge default-rate order: after an in-place remap, shipping and the header discount are credited on the code they posted with', { skip }, async (t) => {
  const { db, Prisma, createSalesOrderRefund } = await load()
  const sfx = randomUUID().slice(0, 8)
  const D = (v: string) => new Prisma.Decimal(v)
  const swap = `RCSWAP-${sfx}`
  const zero = await db.taxRate.create({ data: { name: `RZ-${sfx}`, rate: '0', accountingTaxType: swap, countryCode: 'ZZ' }, select: { id: true } })
  const rc = await db.taxRate.create({ data: { name: `RC-${sfx}`, rate: '0.2', accountingTaxType: `RCOLD-${sfx}`, reverseCharge: true, countryCode: 'ZZ' }, select: { id: true, name: true } })
  const orderIds: string[] = []
  t.after(async () => {
    for (const orderId of orderIds) {
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: orderId } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId } }).catch(() => {})
      await db.salesOrder.delete({ where: { id: orderId } }).catch(() => {})
    }
    await db.taxRate.deleteMany({ where: { id: { in: [zero.id, rc.id] } } }).catch(() => {})
  })
  const mk = async (extra: Record<string, unknown>, payloadExtra: Record<string, unknown>) => {
    const o = await db.salesOrder.create({
      data: {
        orderNumber: `RCO-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), pricesIncludeVat: false, taxRateName: rc.name, taxRatePercent: D('0.2'),
        subtotalForeign: D('100'), subtotalBase: D('100'), accountingInvoiceId: `inv-${randomUUID()}`, accountingInvoiceConnector: 'xero',
        lines: { create: [{ description: 'l', qty: D('1'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('100'), totalBase: D('100'), taxRateId: rc.id }] },
        ...extra,
      } as never,
      select: { id: true, accountingInvoiceId: true, lines: { select: { id: true } } },
    })
    orderIds.push(o.id)
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: o.id, externalTransactionId: o.accountingInvoiceId, syncedAt: new Date(),
        payload: { lines: [{ description: 'l', quantity: 1, unitAmount: 100, taxType: swap, taxRateId: rc.id, taxRateBasis: 'sales_line' }], ...payloadExtra },
      },
    })
    return o
  }
  const withShipping = await mk(
    { shippingForeign: D('10'), shippingBase: D('10'), taxForeign: D('2'), taxBase: D('2'), totalForeign: D('112'), totalBase: D('112') },
    { shippingAmount: 10, shippingTaxType: `RCOLD-${sfx}`, shippingTaxRateId: rc.id, shippingTaxRateBasis: 'plain' },
  )
  const withDiscount = await mk(
    { discountAmount: D('10'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D('90'), totalBase: D('90') },
    { discountAmount: 10, discountTaxType: `RCOLD-${sfx}`, discountTaxRateId: rc.id, discountTaxRateBasis: 'plain' },
  )
  // The in-place remap: the old code is on no rate row afterwards.
  await db.taxRate.update({ where: { id: rc.id }, data: { accountingTaxType: `RCNEW-${sfx}` } })
  const accountingSettings = { reverseChargeSalesTaxType: swap } as never
  const refund = (o: { id: string; lines: { id: string }[] }, lines: Record<string, unknown>[]) => createSalesOrderRefund(db, {
    orderId: o.id,
    lines: [{ lineId: o.lines[0]!.id, productId: null, description: 'l', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' }, ...lines] as never,
    reason: 'rc', creditNotePrefix: `CNRC${sfx}-`, enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true, creditNotePostingEnabled: true, accountingSettings,
  })
  const codes = async (orderId: string) => (await db.salesOrderRefundLine.findMany({ where: { refund: { orderId } }, select: { lineKind: true, accountingTaxType: true } })).map((r) => [r.lineKind, r.accountingTaxType]).sort()
  const r1 = await refund(withShipping, [{ lineId: null, productId: null, description: 'Shipping', qty: 0, totalForeign: 10, totalBase: 10, lineKind: 'shipping' }])
  assert.equal(r1.success, true, r1.success ? '' : r1.error)
  assert.deepEqual(await codes(withShipping.id), [['sale', swap], ['shipping', `RCOLD-${sfx}`]].sort())
  const r2 = await refund(withDiscount, [])
  assert.equal(r2.success, true, r2.success ? '' : r2.error)
  assert.deepEqual(await codes(withDiscount.id), [['discount', `RCOLD-${sfx}`], ['sale', swap]].sort())
})

test('[db] a rate with no accounting code of its own does not make the order default code ambiguous', { skip }, async (t) => {
  const { db, Prisma, createSalesOrderRefund } = await load()
  const sfx = randomUUID().slice(0, 8)
  const D = (v: string) => new Prisma.Decimal(v)
  const def = await db.taxRate.create({ data: { name: `LD-${sfx}`, rate: '0.2', accountingTaxType: `DEFX-${sfx}`, countryCode: 'ZZ' }, select: { id: true, name: true } })
  const codeless = await db.taxRate.create({ data: { name: `LC-${sfx}`, rate: '0.05', accountingTaxType: null, countryCode: 'ZZ' }, select: { id: true } })
  const line = (taxRateId: string, tax: string) => ({ description: 'l', qty: D('1'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D(tax), taxBase: D(tax), totalForeign: D('100'), totalBase: D('100'), taxRateId })
  const o = await db.salesOrder.create({
    data: {
      orderNumber: `LC-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), pricesIncludeVat: false, taxRateName: def.name, taxRatePercent: D('0.2'),
      subtotalForeign: D('200'), subtotalBase: D('200'), taxForeign: D('25'), taxBase: D('25'), totalForeign: D('225'), totalBase: D('225'),
      accountingInvoiceId: `inv-${randomUUID()}`, accountingInvoiceConnector: 'xero',
      lines: { create: [line(def.id, '20'), line(codeless.id, '5')] },
    },
    select: { id: true, accountingInvoiceId: true, lines: { select: { id: true, taxRateId: true } } },
  })
  t.after(async () => {
    await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: o.id } }).catch(() => {})
    await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: o.id } } }).catch(() => {})
    await db.salesOrderRefund.deleteMany({ where: { orderId: o.id } }).catch(() => {})
    await db.salesOrderLine.deleteMany({ where: { orderId: o.id } }).catch(() => {})
    await db.salesOrder.delete({ where: { id: o.id } }).catch(() => {})
    await db.taxRate.deleteMany({ where: { id: { in: [def.id, codeless.id] } } }).catch(() => {})
  })
  // The invoice posted both lines on the default code (the code-less rate fell back to it), each bound to its own rate.
  await db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: o.id, externalTransactionId: o.accountingInvoiceId, syncedAt: new Date(),
      payload: { lines: [
        { description: 'l', quantity: 1, unitAmount: 100, taxType: `DEFX-${sfx}`, taxRateId: def.id, taxRateBasis: 'sales_line' },
        { description: 'l', quantity: 1, unitAmount: 100, taxType: `DEFX-${sfx}`, taxRateId: codeless.id, taxRateBasis: 'sales_line' },
      ] },
    },
  })
  await db.taxRate.update({ where: { id: def.id }, data: { accountingTaxType: `DEFNEW-${sfx}` } })
  const r = await createSalesOrderRefund(db, {
    orderId: o.id,
    lines: [{ lineId: o.lines.find((l) => l.taxRateId === def.id)!.id, productId: null, description: 'l', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' }],
    reason: 'lc', creditNotePrefix: `CNLC${sfx}-`, enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true, creditNotePostingEnabled: true,
  })
  assert.equal(r.success, true, r.success ? '' : r.error)
  const rows = await db.salesOrderRefundLine.findMany({ where: { refund: { orderId: o.id } }, select: { accountingTaxType: true } })
  assert.deepEqual(rows.map((x) => x.accountingTaxType), [`DEFX-${sfx}`])
})

test('[db] the shop refund task keeps the gross figure after a remap: the posted code is priced at the rate it was posted at', { skip }, async (t) => {
  const { db, Prisma, readPostedInvoiceTaxCodes, raiseShopRefundTask } = await load()
  const sfx = randomUUID().slice(0, 8)
  const D = (v: string) => new Prisma.Decimal(v)
  const rate = await db.taxRate.create({ data: { name: `SR-${sfx}`, rate: '0.05', accountingTaxType: `SROLD-${sfx}`, countryCode: 'ZZ' }, select: { id: true } })
  const o = await db.salesOrder.create({
    data: {
      orderNumber: `SR-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), subtotalForeign: D('100'), subtotalBase: D('100'), taxForeign: D('5'), taxBase: D('5'), totalForeign: D('105'), totalBase: D('105'),
      accountingInvoiceId: `inv-${randomUUID()}`, accountingInvoiceConnector: 'xero',
    },
    select: { id: true, accountingInvoiceId: true },
  })
  t.after(async () => {
    await db.wmsOperatorTask.deleteMany({ where: { orderId: o.id } }).catch(() => {})
    await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: o.id } }).catch(() => {})
    await db.salesOrder.delete({ where: { id: o.id } }).catch(() => {})
    await db.taxRate.delete({ where: { id: rate.id } }).catch(() => {})
  })
  await db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: o.id, externalTransactionId: o.accountingInvoiceId, syncedAt: new Date(),
      payload: { lines: [{ description: 'l', quantity: 1, unitAmount: 100, taxType: `SROLD-${sfx}`, taxRateId: rate.id, taxRateBasis: 'sales_line' }] },
    },
  })
  await db.taxRate.update({ where: { id: rate.id }, data: { accountingTaxType: `SRNEW-${sfx}` } })
  const raise = async (postedCodes: Awaited<ReturnType<typeof readPostedInvoiceTaxCodes>>, refundId: string) => {
    await raiseShopRefundTask(db, { orderId: o.id, orderNumber: 'SR', refundId, creditNoteNumber: 'CN', currency: 'GBP', postedCodes, lines: [{ totalForeign: 100, qty: 1, accountingTaxType: `SROLD-${sfx}`, reverseCharge: false }] })
    return (await db.wmsOperatorTask.findFirst({ where: { orderId: o.id, externalOrderId: refundId }, select: { queryText: true } }))!.queryText
  }
  const withPosted = await raise(await readPostedInvoiceTaxCodes(db, o.id, o.accountingInvoiceId), 'r1')
  assert.match(withPosted, /105\.00 GBP including tax/, 'priced at the posted code\'s rate')
  const without = await raise(null, 'r2')
  assert.match(without, /could not work out the tax-inclusive figure/, 'without the posted codes the remapped code cannot be priced (the failure this fixes)')
})
