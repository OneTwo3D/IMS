import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'
import {
  getApAgingReport,
  getArAgingReport,
  getCurrencySummaryReport,
  getFxGainLossReport,
  getVatReport,
  type FinanceAnalyticsClient,
} from '@/lib/domain/finance/finance-period-analytics'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): FinanceAnalyticsClient {
  const unused = { findMany: async () => [] }
  return {
    salesOrder: unused,
    salesOrderLine: unused,
    payment: unused,
    purchaseInvoice: unused,
    fxRate: unused,
  }
}

const settings = async () => ({
  accountsReceivableAccount: '110',
  accountsPayableAccount: '210',
  realisedFxGainLossAccount: '610',
})

test('AR aging report throws a typed source-scan error at the source row cap', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => Array.from({ length: 50001 }, (_, index) => ({ id: `so-${index}` })),
    },
  }

  await assert.rejects(
    getArAgingReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } }),
    (error: unknown) => error instanceof SourceScanTooLargeError && /AR aging source rows exceed 50,000/.test(error.message),
  )
})

test('VAT report subtracts tax from taxable base for tax-inclusive orders', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async () => [
        {
          taxRateId: 'tax-20',
          taxForeign: decimal('20'),
          taxBase: decimal('20'),
          totalBase: decimal('120'),
          order: { shippingAddress: { country: 'gb' }, pricesIncludeVat: true },
          taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'GB' },
        },
      ],
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.taxableBase, '100')
  assert.equal(report.rows[0]?.taxBase, '20')
  assert.equal(report.totals.taxableBase, '100')
  assert.equal(report.totals.taxBase, '20')
})

test('finance analytics formats base amounts with the configured base currency minor units', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async () => [
        {
          taxRateId: 'tax-0',
          taxForeign: decimal('0'),
          taxBase: decimal('0'),
          totalBase: decimal('100.5'),
          order: { shippingAddress: { country: 'JP' }, pricesIncludeVat: false },
          taxRate: { name: 'No VAT', rate: decimal('0'), accountingTaxType: 'NONE', countryCode: 'JP' },
        },
      ],
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z'), baseCurrency: async () => 'JPY' } },
  )

  assert.equal(report.totals.taxableBase, '101')
})

test('VAT report keeps totalBase as taxable base for tax-exclusive orders', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async () => [
        {
          taxRateId: 'tax-20',
          taxForeign: decimal('10'),
          taxBase: decimal('10'),
          totalBase: decimal('50'),
          order: { shippingAddress: { country: 'GB' }, pricesIncludeVat: false },
          taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'GB' },
        },
      ],
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.taxableBase, '50')
  assert.equal(report.rows[0]?.taxBase, '10')
  assert.equal(report.totals.taxableBase, '50')
  assert.equal(report.totals.taxBase, '10')
})

test('VAT report includes purchase invoice input tax by prorating source PO line tax', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrderLine: { findMany: async () => [] },
    purchaseInvoice: {
      findMany: async () => [
        {
          invoiceDate: new Date('2026-06-15T00:00:00.000Z'),
          po: { supplier: { country: 'GB' } },
          lines: [{
            qtyBilled: decimal('2'),
            totalBase: decimal('100'),
            poLine: {
              qty: decimal('4'),
              taxRateId: 'tax-20',
              taxBase: decimal('40'),
              taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'INPUT2', countryCode: 'GB' },
            },
          }],
        },
      ],
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.side, 'purchases')
  assert.equal(report.rows[0]?.taxableBase, '100')
  assert.equal(report.rows[0]?.taxBase, '20')
  assert.equal(report.totals.purchaseTaxBase, '20')
  assert.equal(report.totals.taxBase, '-20')
})

test('AR aging subtracts non-refund payments and uses configurable buckets', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [{
        id: 'so-1',
        customerId: 'customer-1',
        customerName: 'Customer A',
        customerEmail: 'a@example.com',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        invoicedAt: new Date('2026-05-01T00:00:00.000Z'),
        paymentDueAt: null,
        paidAt: null,
        totalBase: decimal('120'),
        payments: [
          { amount: decimal('20'), paidAt: new Date('2026-05-05T00:00:00.000Z'), refundId: null },
          { amount: decimal('50'), paidAt: new Date('2026-06-05T00:00:00.000Z'), refundId: null },
          { amount: decimal('-5'), paidAt: new Date('2026-05-06T00:00:00.000Z'), refundId: 'refund-1' },
        ],
        status: SalesOrderStatus.PROCESSING,
      }],
    },
  }

  const report = await getArAgingReport(
    { bucket1Days: 10, bucket2Days: 20, bucket3Days: 40 },
    { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.bucket3, '95')
  assert.equal(report.rows[0]?.outstandingBase, '95')
  assert.equal(report.totals.outstandingBase, '95')
  assert.equal(report.totals.bucket1Days, '10')
})

test('AR aging uses paymentDueAt and separates customer credit balances', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [
        {
          id: 'so-1',
          customerId: 'customer-1',
          customerName: 'Customer A',
          customerEmail: 'a@example.com',
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
          invoicedAt: new Date('2026-04-01T00:00:00.000Z'),
          paymentDueAt: new Date('2026-05-25T00:00:00.000Z'),
          paidAt: null,
          totalBase: decimal('1000'),
          payments: [
            { amount: decimal('300'), paidAt: new Date('2026-05-15T00:00:00.000Z'), refundId: null },
            { amount: decimal('200'), paidAt: new Date('2026-05-20T00:00:00.000Z'), refundId: 'refund-1' },
          ],
          status: SalesOrderStatus.PROCESSING,
        },
        {
          id: 'so-credit',
          customerId: 'customer-1',
          customerName: 'Customer A',
          customerEmail: 'a@example.com',
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          invoicedAt: new Date('2026-05-01T00:00:00.000Z'),
          paymentDueAt: new Date('2026-05-01T00:00:00.000Z'),
          paidAt: null,
          totalBase: decimal('100'),
          payments: [{ amount: decimal('150'), paidAt: new Date('2026-05-02T00:00:00.000Z'), refundId: null }],
          status: SalesOrderStatus.PROCESSING,
        },
      ],
    },
  }

  const report = await getArAgingReport(
    { bucket1Days: 10, bucket2Days: 20, bucket3Days: 40, dateTo: '2026-06-01' },
    { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.bucket1, '500')
  assert.equal(report.rows[0]?.outstandingBase, '500')
  assert.equal(
    decimal(report.rows[0]?.current ?? 0)
      .add(report.rows[0]?.bucket1 ?? 0)
      .add(report.rows[0]?.bucket2 ?? 0)
      .add(report.rows[0]?.bucket3 ?? 0)
      .add(report.rows[0]?.bucket4 ?? 0)
      .toString(),
    report.rows[0]?.outstandingBase,
  )
  assert.equal(report.totals.creditBalanceBase, '50')
})

test('AP aging reconciles unpaid supplier invoices into aging buckets', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    purchaseInvoice: {
      findMany: async () => [{
        id: 'pi-1',
        invoiceNumber: 'PI-1',
        invoiceDate: new Date('2026-05-01T00:00:00.000Z'),
        dueDate: new Date('2026-05-15T00:00:00.000Z'),
        paidAt: null,
        totalBase: decimal('75'),
        po: { supplierId: 'supplier-1', supplier: { name: 'Supplier A', email: 'supplier@example.com' } },
      }],
    },
  }

  const report = await getApAgingReport(
    { bucket1Days: 30, bucket2Days: 60, bucket3Days: 90 },
    { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.bucket1, '75')
  assert.equal(report.rows[0]?.outstandingBase, '75')
  assert.equal(report.totals.outstandingBase, '75')
})

test('currency summary rolls up sales, purchases, AR and AP by document currency', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrder: {
      findMany: async () => [
        {
          id: 'so-usd',
          currency: 'USD',
          totalForeign: decimal('120'),
          totalBase: decimal('100'),
          paidAt: null,
          payments: [{ amount: decimal('20'), currency: 'USD', paidAt: new Date('2026-06-12T00:00:00.000Z'), refundId: null }],
        },
      ],
    },
    purchaseInvoice: {
      findMany: async () => [
        {
          id: 'pi-eur',
          paidAt: null,
          totalForeign: decimal('60'),
          totalBase: decimal('50'),
          po: { currency: 'EUR' },
        },
      ],
    },
  }

  const report = await getCurrencySummaryReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  const eur = report.rows.find((row) => row.currency === 'EUR')
  const usd = report.rows.find((row) => row.currency === 'USD')

  assert.equal(usd?.salesForeign, '120')
  assert.equal(usd?.salesBase, '100')
  assert.equal(usd?.arOutstandingForeign, '100')
  assert.equal(usd?.arOutstandingBase, '83.33')
  assert.equal(eur?.purchasesForeign, '60')
  assert.equal(eur?.purchasesBase, '50')
  assert.equal(eur?.apOutstandingForeign, '60')
  assert.equal(eur?.apOutstandingBase, '50')
  assert.equal(report.totals.salesBase, '100')
  assert.equal(report.totals.apOutstandingBase, '50')
})

test('FX gain/loss uses latest settlement rate and configured Xero accounts', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    payment: {
      findMany: async () => [{
        id: 'payment-1',
        amount: decimal('120'),
        currency: 'USD',
        paidAt: new Date('2026-06-10T00:00:00.000Z'),
        refundId: null,
        order: {
          id: 'so-1',
          orderNumber: 'SO-1',
          invoiceNumber: 'INV-1',
          currency: 'USD',
          fxRateToBase: decimal('1.2'),
          customerName: 'Customer A',
          customerEmail: null,
        },
      }],
    },
    fxRate: {
      findMany: async () => [
        { fromCurrency: 'GBP', toCurrency: 'USD', rate: decimal('1.5'), fetchedAt: new Date('2026-06-09T00:00:00.000Z') },
        { fromCurrency: 'GBP', toCurrency: 'USD', rate: decimal('1.1'), fetchedAt: new Date('2026-06-11T00:00:00.000Z') },
      ],
    },
  }

  const report = await getFxGainLossReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z'), accountingSettings: settings } },
  )

  assert.equal(report.rows[0]?.bookedBase, '100')
  assert.equal(report.rows[0]?.settlementId, 'payment-1')
  assert.equal(report.rows[0]?.settlementBase, '80')
  assert.equal(report.rows[0]?.gainLossBase, '-20')
  assert.equal(report.rows[0]?.fxGainLossAccount, '610')
  assert.equal(report.totals.lossesBase, '20')
})

test('FX gain/loss keeps partial receivable payments as separate settlement rows', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    payment: {
      findMany: async () => [
        {
          id: 'payment-1',
          amount: decimal('120'),
          currency: 'USD',
          paidAt: new Date('2026-01-10T00:00:00.000Z'),
          refundId: null,
          order: {
            id: 'so-1',
            orderNumber: 'SO-1',
            invoiceNumber: 'INV-1',
            currency: 'USD',
            fxRateToBase: decimal('1.2'),
            customerName: 'Customer A',
            customerEmail: null,
          },
        },
        {
          id: 'payment-2',
          amount: decimal('120'),
          currency: 'USD',
          paidAt: new Date('2026-02-10T00:00:00.000Z'),
          refundId: null,
          order: {
            id: 'so-1',
            orderNumber: 'SO-1',
            invoiceNumber: 'INV-1',
            currency: 'USD',
            fxRateToBase: decimal('1.2'),
            customerName: 'Customer A',
            customerEmail: null,
          },
        },
      ],
    },
    fxRate: {
      findMany: async () => [
        { fromCurrency: 'GBP', toCurrency: 'USD', rate: decimal('1.1'), fetchedAt: new Date('2026-01-09T00:00:00.000Z') },
        { fromCurrency: 'GBP', toCurrency: 'USD', rate: decimal('1.5'), fetchedAt: new Date('2026-02-09T00:00:00.000Z') },
      ],
    },
  }

  const report = await getFxGainLossReport(
    { dateFrom: '2026-01-01', dateTo: '2026-02-28' },
    { deps: { client, now: () => new Date('2026-02-28T00:00:00.000Z'), accountingSettings: settings } },
  )

  assert.deepEqual(report.rows.map((row) => row.settlementId), ['payment-1', 'payment-2'])
  assert.deepEqual(report.rows.map((row) => row.settlementRateToBase), ['1.1', '1.5'])
  assert.match(report.notices.join(' '), /one row per Payment\.id/)
})

test('VAT report groups same rate across reporting categories into separate rows', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async () => [
        {
          taxRateId: 'tax-uk-domestic',
          taxForeign: decimal('20'),
          taxBase: decimal('20'),
          totalBase: decimal('100'),
          order: { shippingAddress: { country: 'GB' }, pricesIncludeVat: false },
          taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'GB', reportingCategory: 'DOMESTIC' },
        },
        {
          taxRateId: 'tax-eu-oss',
          taxForeign: decimal('20'),
          taxBase: decimal('20'),
          totalBase: decimal('100'),
          order: { shippingAddress: { country: 'DE' }, pricesIncludeVat: false },
          taxRate: { name: 'DE Standard via OSS', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'DE', reportingCategory: 'OSS' },
        },
      ],
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 2)
  const categories = report.rows.map((row) => row.reportingCategory).sort()
  assert.deepEqual(categories, ['DOMESTIC', 'OSS'])
  assert.equal(report.totals.salesTaxBase, '40')
})

test('VAT report filters rows by vatReportingCategory', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async (args: { where: { taxRate?: { reportingCategory?: { equals: string } } } }) => {
        const filter = args.where?.taxRate?.reportingCategory?.equals
        const all = [
          {
            taxRateId: 'tax-uk-domestic',
            taxForeign: decimal('20'),
            taxBase: decimal('20'),
            totalBase: decimal('100'),
            order: { shippingAddress: { country: 'GB' }, pricesIncludeVat: false },
            taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'GB', reportingCategory: 'DOMESTIC' },
          },
          {
            taxRateId: 'tax-eu-oss',
            taxForeign: decimal('20'),
            taxBase: decimal('20'),
            totalBase: decimal('100'),
            order: { shippingAddress: { country: 'DE' }, pricesIncludeVat: false },
            taxRate: { name: 'DE Standard via OSS', rate: decimal('0.2'), accountingTaxType: 'OUTPUT2', countryCode: 'DE', reportingCategory: 'OSS' },
          },
        ]
        return filter ? all.filter((line) => line.taxRate.reportingCategory === filter) : all
      },
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30', vatReportingCategory: 'OSS' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.reportingCategory, 'OSS')
  assert.equal(report.totals.salesTaxBase, '20')
})

test('VAT report skips purchase invoice lines whose taxRate category does not match the filter', async () => {
  const client: FinanceAnalyticsClient = {
    ...unusedClient(),
    purchaseInvoice: {
      findMany: async () => [
        {
          invoiceDate: new Date('2026-06-15T00:00:00.000Z'),
          po: { supplier: { country: 'GB' } },
          lines: [
            {
              qtyBilled: decimal('1'),
              totalBase: decimal('50'),
              poLine: {
                qty: decimal('1'),
                taxRateId: 'tax-uk-domestic',
                taxBase: decimal('10'),
                taxRate: { name: 'UK Standard', rate: decimal('0.2'), accountingTaxType: 'INPUT2', countryCode: 'GB', reportingCategory: 'DOMESTIC' },
              },
            },
            {
              qtyBilled: decimal('1'),
              totalBase: decimal('50'),
              poLine: {
                qty: decimal('1'),
                taxRateId: 'tax-rc',
                taxBase: decimal('0'),
                taxRate: { name: 'Reverse charge', rate: decimal('0'), accountingTaxType: 'REVERSECHARGES', countryCode: 'GB', reportingCategory: 'REVERSE_CHARGE' },
              },
            },
          ],
        },
      ],
    },
  }

  const report = await getVatReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-30', vatReportingCategory: 'REVERSE_CHARGE' },
    { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.reportingCategory, 'REVERSE_CHARGE')
  assert.equal(report.rows[0]?.taxBase, '0')
})
