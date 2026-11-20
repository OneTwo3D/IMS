import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { getVatReport, type FinanceAnalyticsDeps } from '@/lib/domain/finance/finance-period-analytics'
import { salesInvoiceDocumentDay, salesInvoiceDocumentDayOfOrder } from '@/lib/domain/accounting/document-date'
import { grirJournalDate } from '@/lib/domain/accounting/grir-subledger-movement'

/**
 * The VAT report places each document by the date it carries in Xero, not by the moment it was posted (o3d-z5shj). Fixtures are evaluated against the where-clause the
 * report really emits. Instants are worked by hand: in BST (UTC+1) London midnight is 23:00Z the evening before.
 */

const D = (v: string | number) => new Prisma.Decimal(v)
const NOW = new Date('2026-11-20T12:00:00.000Z')
type Clause = { not?: null; gte?: Date; lt?: Date } | null | undefined
const inClause = (value: Date | null, c: Clause): boolean => {
  if (c === undefined) return true
  if (c === null) return value === null
  if (c.not === null) return value !== null
  return value !== null && (!c.gte || value >= c.gte) && (!c.lt || value < c.lt)
}

type Order = { externalCreatedAt: Date | null; invoicedAt: Date | null; tax: number; net: number }
type RefundLine = { createdAt: Date; net: number; postedTaxRate: number | null; creditNoteId?: string | null }
type SupplierCredit = { postedAt: Date; amountBase: number; billTotal: number | null; lineNet: number; lineTax: number }
type Bill = { invoiceDate: Date; net: number; tax: number }

const rate = { name: 'VAT 20%', rate: D(20), accountingTaxType: 'OUTPUT2', countryCode: 'GB', reportingCategory: null }
function deps(data: { orders?: Order[]; refunds?: RefundLine[]; credits?: SupplierCredit[]; bills?: Bill[] }): FinanceAnalyticsDeps {
  return {
    now: () => NOW,
    baseCurrency: async () => 'GBP',
    client: {
      salesOrderLine: {
        findMany: async (a: { where: { order: { OR: Array<{ invoicedAt?: Clause; externalCreatedAt?: Clause }> } } }) =>
          (data.orders ?? []).filter((o) => a.where.order.OR.some((c) => inClause(o.invoicedAt, c.invoicedAt) && inClause(o.externalCreatedAt, c.externalCreatedAt)))
            .map((o) => ({ taxRateId: 'r20', taxForeign: D(o.tax), taxBase: D(o.tax), totalBase: D(o.net), order: { shippingAddress: null, pricesIncludeVat: false }, taxRate: rate })),
      },
      purchaseInvoice: {
        findMany: async (a: { where: { invoiceDate: Clause } }) =>
          (data.bills ?? []).filter((b) => inClause(b.invoiceDate, a.where.invoiceDate)).map((b) => ({
            invoiceDate: b.invoiceDate, po: { supplier: { country: 'GB' } },
            lines: [{ qtyBilled: D(1), totalBase: D(b.net), poLine: { qty: D(1), taxRateId: 'r20', taxBase: D(b.tax), taxRate: { ...rate, accountingTaxType: 'INPUT2' } } }],
          })),
      },
      salesOrderRefundLine: {
        findMany: async (a: { where: { refund: { createdAt: Clause; accountingCreditNoteId: Clause } } }) =>
          (data.refunds ?? []).filter((r) => inClause(r.createdAt, a.where.refund.createdAt) && inClause(r.creditNoteId === undefined ? 'cn' as never : (r.creditNoteId as never), a.where.refund.accountingCreditNoteId as never))
            .map((r) => ({ totalBase: D(r.net), postedTaxRate: r.postedTaxRate === null ? null : D(r.postedTaxRate), refund: { order: { shippingAddress: null } }, salesOrderLine: { taxRateId: 'r20', taxRate: rate } })),
      },
      supplierCreditNote: {
        findMany: async (a: { where: { postedAt: Clause } }) =>
          (data.credits ?? []).filter((c) => inClause(c.postedAt, a.where.postedAt)).map((c) => ({
            amountBase: D(c.amountBase), purchaseInvoiceId: c.billTotal === null ? null : 'bill',
            purchaseInvoice: c.billTotal === null ? null : { totalBase: D(c.billTotal), lines: [{ qtyBilled: D(1), totalBase: D(c.lineNet), poLine: { qty: D(1), taxRateId: 'r20', taxBase: D(c.lineTax), taxRate: { ...rate, accountingTaxType: 'INPUT2' } } }] },
            po: { supplier: { country: 'GB' } },
          })),
      },
    } as never,
  }
}
const Q3 = { dateFrom: '2026-07-01', dateTo: '2026-09-30' }
const Q4 = { dateFrom: '2026-10-01', dateTo: '2026-12-31' }
const run = (f: { dateFrom: string; dateTo: string }, d: FinanceAnalyticsDeps) => getVatReport(f, { deps: d, paginate: false })

test('an invoice posted after London midnight on a quarter-end lands in the SAME quarter as its Xero date', async () => {
  // Order created 22:50Z on 30 Sep = 23:50 BST on 30 Sep: the Xero invoice Date is 2026-09-30 (Q3). The post is delayed past London midnight: 23:30Z = 00:30 BST on 1 Oct.
  const order: Order = { externalCreatedAt: new Date('2026-09-30T22:50:00Z'), invoicedAt: new Date('2026-09-30T23:30:00Z'), tax: 20, net: 100 }
  const xeroDate = salesInvoiceDocumentDay(order.externalCreatedAt!)
  assert.equal(xeroDate, '2026-09-30')
  const q3 = await run(Q3, deps({ orders: [order] }))
  const q4 = await run(Q4, deps({ orders: [order] }))
  assert.equal(Number(q3.totals.salesTaxBase), 20, 'Q3 holds it: the quarter of its Xero date')
  assert.equal(Number(q4.totals.salesTaxBase), 0, 'Q4 does not (the post instant is in Q4 London)')
  assert.ok(xeroDate >= Q3.dateFrom && xeroDate <= Q3.dateTo)
})

test('the reverse: an order created after London midnight but posted before it cannot happen; a Q4 Xero date stays in Q4 whatever the post time', async () => {
  const order: Order = { externalCreatedAt: new Date('2026-09-30T23:10:00Z'), invoicedAt: new Date('2026-11-02T09:00:00Z'), tax: 8, net: 40 }
  assert.equal(salesInvoiceDocumentDay(order.externalCreatedAt!), '2026-10-01')
  assert.equal(Number((await run(Q3, deps({ orders: [order] }))).totals.salesTaxBase), 0)
  assert.equal(Number((await run(Q4, deps({ orders: [order] }))).totals.salesTaxBase), 8)
})

test('an order with no storefront creation date falls back to its stored invoice stamp; an unposted order is in no period', async () => {
  const stamped: Order = { externalCreatedAt: null, invoicedAt: new Date('2026-09-30T22:30:00Z'), tax: 20, net: 100 }
  const unposted: Order = { externalCreatedAt: new Date('2026-08-10T10:00:00Z'), invoicedAt: null, tax: 99, net: 99 }
  const r = await run(Q3, deps({ orders: [stamped, unposted] }))
  assert.equal(Number(r.totals.salesTaxBase), 20)
  assert.equal(salesInvoiceDocumentDayOfOrder(stamped), '2026-09-30')
  assert.equal(salesInvoiceDocumentDayOfOrder(unposted), null)
})

test('purchase bills are placed by the bill date sent to Xero (a day stored as UTC midnight is inside that London day)', async () => {
  const bills: Bill[] = [{ invoiceDate: new Date('2026-09-30T00:00:00Z'), net: 100, tax: 20 }, { invoiceDate: new Date('2026-10-01T00:00:00Z'), net: 50, tax: 10 }]
  assert.equal(Number((await run(Q3, deps({ bills }))).totals.purchaseTaxBase), 20)
  assert.equal(Number((await run(Q4, deps({ bills }))).totals.purchaseTaxBase), 10)
})

test('sales credit notes net the sales side, dated by the London day of the credit note', async () => {
  const orders: Order[] = [{ externalCreatedAt: new Date('2026-09-10T10:00:00Z'), invoicedAt: new Date('2026-09-10T10:05:00Z'), tax: 20, net: 100 }]
  // Refund raised 23:40Z on 30 Sep = 00:40 BST on 1 Oct: a Q4 credit note. Net 50 at 20% = 10 VAT.
  const refunds: RefundLine[] = [{ createdAt: new Date('2026-09-30T23:40:00Z'), net: 50, postedTaxRate: 0.2 }]
  const q3 = await run(Q3, deps({ orders, refunds }))
  const q4 = await run(Q4, deps({ orders, refunds }))
  assert.equal(Number(q3.totals.salesTaxBase), 20, 'Q3 sales VAT is untouched by a Q4 credit note')
  assert.equal(Number(q4.totals.salesTaxBase), -10, 'Q4 carries the credit note: minus 10')
  assert.equal(Number(q4.totals.taxableBase), -50)
  // Both quarters together equal the Xero return: 20 - 10 = 10.
  assert.equal(Number(q3.totals.salesTaxBase) + Number(q4.totals.salesTaxBase), 10)
})

test('a refund whose credit note Xero does not hold is not netted; a legacy line without a stored rate uses the tax rate of its order line', async () => {
  const held: RefundLine[] = [{ createdAt: new Date('2026-08-01T10:00:00Z'), net: 100, postedTaxRate: null }, { createdAt: new Date('2026-08-02T10:00:00Z'), net: 100, postedTaxRate: 0.2, creditNoteId: null }]
  const r = await run(Q3, deps({ refunds: held }))
  assert.equal(Number(r.totals.salesTaxBase), -20, 'only the first line (rate 20 from the order line); the second has no Xero credit note')
})

test('supplier credit notes net the purchase side by their share of the bill they offset, dated by the day posted; an untied one is counted in a notice', async () => {
  const credits: SupplierCredit[] = [
    { postedAt: new Date('2026-09-30T23:30:00Z'), amountBase: 60, billTotal: 120, lineNet: 100, lineTax: 20 }, // Q4 (1 Oct London); half of the bill: tax 10, net 50
    { postedAt: new Date('2026-10-05T10:00:00Z'), amountBase: 10, billTotal: null, lineNet: 0, lineTax: 0 },
  ]
  const q3 = await run(Q3, deps({ credits }))
  assert.equal(Number(q3.totals.purchaseTaxBase), 0)
  const q4 = await run(Q4, deps({ credits }))
  assert.equal(Number(q4.totals.purchaseTaxBase), -10)
  assert.equal(Number(q4.totals.taxableBase), -50)
  assert.ok(q4.notices.some((n) => /1 supplier credit note .* not tied to a bill/.test(n)), 'the untied credit note is reported')
})

test('grirJournalDate stamps the LONDON day of an instant (23:30Z on 31 July is 1 August) and keeps a date-only string as it is', () => {
  assert.equal(grirJournalDate(new Date('2026-07-31T23:30:00Z')).toISOString(), '2026-08-01T00:00:00.000Z')
  assert.equal(grirJournalDate(new Date('2026-12-31T23:30:00Z')).toISOString(), '2026-12-31T00:00:00.000Z', 'GMT: unchanged')
  assert.equal(grirJournalDate('2026-07-31').toISOString(), '2026-07-31T00:00:00.000Z')
  assert.equal(grirJournalDate(new Date('2026-07-31T00:00:00Z')).toISOString(), '2026-07-31T00:00:00.000Z', 'a bill date stored as UTC midnight keeps its day in BST')
})
