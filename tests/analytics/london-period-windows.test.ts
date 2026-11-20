import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { londonPeriod } from '@/lib/domain/math/london-period'
import { businessDateOfIso } from '@/lib/business-date'
import { getReturnsAnalyticsReport, getSalesAnalyticsReport, getThroughputAnalyticsReport, type SalesFulfillmentAnalyticsClient } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { getVatReport, getCurrencySummaryReport, getFxGainLossReport, type FinanceAnalyticsDeps } from '@/lib/domain/finance/finance-period-analytics'

/**
 * o3d-bo89l / o3d-7a7z4. Xero documents, VAT tax points and the stock ledger are dated in LONDON; the sales and finance period reports used to window on UTC
 * days, so in summer time (BST, UTC+1) a document at 23:00-24:00Z fell in the wrong period. Every expected instant below is worked out by hand from London
 * midnight (BST = 23:00Z the evening before; GMT = 00:00Z), never from the implementation.
 */

const iso = (d: Date) => d.toISOString()

test('londonPeriod: a BST month is [23:00Z the evening before, 23:00Z on its last day)', () => {
  const p = londonPeriod({ dateFrom: '2026-07-01', dateTo: '2026-07-31' }, new Date('2026-11-20T12:00:00Z'), 30)
  assert.equal(iso(p.dateFrom), '2026-06-30T23:00:00.000Z')
  assert.equal(iso(p.dateToExclusive), '2026-07-31T23:00:00.000Z')
  assert.equal(iso(p.dateTo), '2026-07-31T22:59:59.999Z')
  assert.equal(iso(p.fromLabel), '2026-07-01T00:00:00.000Z')
  assert.equal(iso(p.toLabel), '2026-07-31T00:00:00.000Z')
})

test('londonPeriod: a GMT month is the UTC month (control)', () => {
  const p = londonPeriod({ dateFrom: '2026-02-01', dateTo: '2026-02-28' }, new Date('2026-11-20T12:00:00Z'), 30)
  assert.equal(iso(p.dateFrom), '2026-02-01T00:00:00.000Z')
  assert.equal(iso(p.dateToExclusive), '2026-03-01T00:00:00.000Z')
})

test('londonPeriod: the default is the 30 London days ending London today (23:30Z in BST is already tomorrow)', () => {
  const p = londonPeriod({}, new Date('2026-07-01T23:30:00Z'), 30)
  // London today = 2 July; 30 days = 3 June..2 July.
  assert.equal(iso(p.fromLabel), '2026-06-03T00:00:00.000Z')
  assert.equal(iso(p.toLabel), '2026-07-02T00:00:00.000Z')
  assert.equal(iso(p.dateFrom), '2026-06-02T23:00:00.000Z')
  assert.equal(iso(p.dateToExclusive), '2026-07-02T23:00:00.000Z')
})

test('londonPeriod: a from after the to collapses to the to day; unreadable labels fall back to the default', () => {
  const collapsed = londonPeriod({ dateFrom: '2026-07-20', dateTo: '2026-07-10' }, new Date('2026-11-20T12:00:00Z'), 30)
  assert.equal(iso(collapsed.fromLabel), '2026-07-10T00:00:00.000Z')
  assert.equal(iso(collapsed.dateFrom), '2026-07-09T23:00:00.000Z')
  assert.equal(iso(collapsed.dateToExclusive), '2026-07-10T23:00:00.000Z')
  const bad = londonPeriod({ dateFrom: 'nonsense', dateTo: '2026-13-45' }, new Date('2026-07-15T12:00:00Z'), 30)
  assert.equal(iso(bad.toLabel), '2026-07-15T00:00:00.000Z')
})

test('the ledger page Date column shows the London date of the instant', () => {
  assert.equal(businessDateOfIso('2026-07-31T23:30:00.000Z'), '2026-08-01')
  assert.equal(businessDateOfIso('2026-07-31T22:30:00.000Z'), '2026-07-31')
  assert.equal(businessDateOfIso('2026-01-31T23:30:00.000Z'), '2026-01-31')
})

// ---- sales / fulfillment family -------------------------------------------------------------------------------------------------------------------------

type Where = Record<string, unknown>
function salesClient(seen: { orders?: Where; refunds?: Where; shipments?: Where; activity?: Where; activities?: unknown[] }) {
  const empty = { findMany: async () => [] }
  return {
    product: empty,
    cogsEntry: empty,
    stockMovement: empty,
    salesOrder: { findMany: async (a: { where: Where }) => { seen.orders = a.where; return [] } },
    salesOrderRefund: empty,
    salesOrderRefundLine: { findMany: async (a: { where: Where }) => { seen.refunds = a.where; return [] } },
    shipment: { findMany: async (a: { where: Where }) => { if ('shippedAt' in a.where) seen.shipments = a.where; return [] } },
    activityLog: { findMany: async (a: { where: Where }) => { seen.activity = a.where; return (seen.activities ?? []) as never[] } },
  } as unknown as SalesFulfillmentAnalyticsClient
}
const NOW = () => new Date('2026-11-20T12:00:00.000Z')

test('Sales analytics windows the order createdAt on London days (BST July)', async () => {
  const seen: Parameters<typeof salesClient>[0] = {}
  const report = await getSalesAnalyticsReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' }, { client: salesClient(seen), now: NOW })
  const createdAt = seen.orders!.createdAt as { gte: Date; lt: Date }
  assert.equal(iso(createdAt.gte), '2026-06-30T23:00:00.000Z')
  assert.equal(iso(createdAt.lt), '2026-07-31T23:00:00.000Z')
  assert.equal(report.dateFrom, '2026-07-01', 'the displayed label stays the typed day')
  assert.equal(report.dateTo, '2026-07-31')
})

test('Returns analytics nets a 23:40Z refund in the SAME London period as the 23:15Z dispatch it reverses (o3d-bo89l scenario)', async () => {
  const seen: Parameters<typeof salesClient>[0] = {}
  await getReturnsAnalyticsReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' }, { client: salesClient(seen), now: NOW })
  const clauses = JSON.stringify(seen.refunds)
  // 2026-06-30T23:40Z is London 1 July: inside July's window, outside June's.
  assert.match(clauses, /"gte":"2026-06-30T23:00:00.000Z"/)
  assert.match(clauses, /"lt":"2026-07-31T23:00:00.000Z"/)
  const refundAt = Date.parse('2026-06-30T23:40:00Z')
  assert.ok(refundAt >= Date.parse('2026-06-30T23:00:00Z') && refundAt < Date.parse('2026-07-31T23:00:00Z'))
})

test('Throughput analytics windows shipments and activity on London days and buckets rows by London day', async () => {
  const seen: Parameters<typeof salesClient>[0] = {
    activities: [{ userId: 'u1', createdAt: new Date('2026-07-31T23:30:00.000Z'), metadata: {}, user: { name: 'Pat' } }],
  }
  const report = await getThroughputAnalyticsReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' }, { client: salesClient(seen), now: NOW })
  assert.equal(iso((seen.shipments!.shippedAt as { gte: Date }).gte), '2026-06-30T23:00:00.000Z')
  assert.equal(iso((seen.activity!.createdAt as { lt: Date }).lt), '2026-07-31T23:00:00.000Z')
  // 23:30Z on 31 July is outside July's window; the row is still bucketed by its London day should it be loaded.
  assert.deepEqual(report.rows.map((r) => r.date), ['2026-08-01'])
})

// ---- finance family (o3d-7a7z4) ---------------------------------------------------------------------------------------------------------------------------

type InvoiceLine = { invoicedAt: Date; taxBase: number; totalBase: number }
function vatDeps(lines: InvoiceLine[], now: Date): FinanceAnalyticsDeps {
  return {
    now: () => now,
    baseCurrency: async () => 'GBP',
    client: {
      salesOrderLine: {
        findMany: async (a: { where: { order: { invoicedAt: { gte: Date; lt: Date } } } }) => {
          const w = a.where.order.invoicedAt
          return lines.filter((l) => l.invoicedAt >= w.gte && l.invoicedAt < w.lt).map((l) => ({
            taxRateId: 'r20', taxForeign: new Prisma.Decimal(l.taxBase), taxBase: new Prisma.Decimal(l.taxBase), totalBase: new Prisma.Decimal(l.totalBase),
            order: { shippingAddress: null, pricesIncludeVat: false },
            taxRate: { name: 'VAT 20%', rate: new Prisma.Decimal(20), accountingTaxType: 'OUTPUT2', countryCode: 'GB', reportingCategory: null },
          }))
        },
      },
      purchaseInvoice: { findMany: async () => [] },
    } as never,
  }
}

test('VAT: a 23:30Z invoice on a BST quarter-end lands in the NEXT London quarter', async () => {
  // 2026-09-30T23:30:00Z is 00:30 BST on 1 October: Q4's tax point, not Q3's.
  const lines: InvoiceLine[] = [
    { invoicedAt: new Date('2026-09-30T22:30:00Z'), taxBase: 20, totalBase: 100 }, // 23:30 BST on 30 Sep: Q3
    { invoicedAt: new Date('2026-09-30T23:30:00Z'), taxBase: 40, totalBase: 200 }, // 00:30 BST on 1 Oct: Q4
  ]
  const now = new Date('2026-11-20T12:00:00Z')
  const q3 = await getVatReport({ dateFrom: '2026-07-01', dateTo: '2026-09-30' }, { deps: vatDeps(lines, now), paginate: false })
  const q4 = await getVatReport({ dateFrom: '2026-10-01', dateTo: '2026-12-31' }, { deps: vatDeps(lines, now), paginate: false })
  assert.equal(Number(q3.totals.salesTaxBase), 20, 'Q3 holds only the 22:30Z invoice')
  assert.equal(Number(q4.totals.salesTaxBase), 40, 'Q4 holds the 23:30Z invoice')
})

test('VAT: a GMT quarter-end is unchanged (23:30Z on 31 Dec is still 31 Dec)', async () => {
  const lines: InvoiceLine[] = [{ invoicedAt: new Date('2026-12-31T23:30:00Z'), taxBase: 20, totalBase: 100 }]
  const q4 = await getVatReport({ dateFrom: '2026-10-01', dateTo: '2026-12-31' }, { deps: vatDeps(lines, new Date('2027-01-20T12:00:00Z')), paginate: false })
  assert.equal(Number(q4.totals.salesTaxBase), 20)
})

test('VAT: the default period is the London day (23:30Z in BST is already tomorrow)', async () => {
  const report = await getVatReport({}, { deps: vatDeps([], new Date('2026-07-01T23:30:00Z')), paginate: false })
  assert.equal(report.dateTo, '2026-07-02')
})

test('Currency summary and FX gain/loss window paidAt/invoiceDate on London days (BST July)', async () => {
  const seenWhere: Where[] = []
  const spy = { findMany: async (a: { where: Where }) => { seenWhere.push(a.where); return [] } }
  const client = { salesOrder: spy, salesOrderPayment: spy, payment: spy, purchaseInvoice: spy, purchaseOrder: spy, fxRate: spy, exchangeRate: spy, salesOrderRefund: spy } as never
  const deps = { now: NOW, baseCurrency: async () => 'GBP', accountingSettings: async () => ({ accountsReceivableAccount: '200', accountsPayableAccount: '800', realisedFxGainLossAccount: '400' }), client: { ...(client as object), setting: spy } } as unknown as FinanceAnalyticsDeps
  for (const run of [getCurrencySummaryReport, getFxGainLossReport]) {
    seenWhere.length = 0
    try { await run({ dateFrom: '2026-07-01', dateTo: '2026-07-31' }, { deps, paginate: false }) } catch { /* the spy client is not a full model; only the windows it saw matter */ }
    const text = JSON.stringify(seenWhere)
    assert.match(text, /2026-06-30T23:00:00.000Z/, `${run.name} lower bound`)
    assert.match(text, /2026-07-31T23:00:00.000Z/, `${run.name} upper bound`)
    assert.doesNotMatch(text, /2026-07-01T00:00:00.000Z|2026-08-01T00:00:00.000Z/, `${run.name} no UTC-day bound`)
  }
})
